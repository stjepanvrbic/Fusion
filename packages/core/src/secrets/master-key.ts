import { createLogger } from "../process/logger.js";

const severityAuditLog = createLogger("core-master-key");
import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { userInfo } from "node:os";
import { createRequire } from "node:module";
import { resolveGlobalDir } from "../config/global-settings.js";
import { superviseSpawn } from "../process/process-supervisor.js";

export const MASTER_KEY_KEYCHAIN_SERVICE = "fusion";
export const MASTER_KEY_KEYCHAIN_ACCOUNT = "master-key";
export const MASTER_KEY_FILENAME = "master.key";

export type KeytarLike = {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
};

export class MasterKeyPermissionError extends Error {
  constructor(message = "master key file must be readable only by its owner") {
    super(message);
    this.name = "MasterKeyPermissionError";
  }
}

export class MasterKeyCorruptError extends Error {
  constructor(public readonly backend: "keychain" | "file", message: string) {
    super(message);
    this.name = "MasterKeyCorruptError";
  }
}

type FsLike = Pick<typeof fs, "mkdir" | "open" | "chmod" | "stat" | "readFile" | "link" | "rename" | "unlink">;

/** Runs `icacls` with the given arguments; injectable so the Windows policy is testable on every platform. */
export type WindowsAclRunner = (args: string[]) => Promise<{ exitCode: number | null; stderr: string }>;

const ICACLS_TIMEOUT_MS = 15_000;

const runIcacls: WindowsAclRunner = (args) => new Promise((resolve) => {
  const supervised = superviseSpawn("icacls", args, {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    maxLifetimeMs: ICACLS_TIMEOUT_MS,
  });
  let stderr = "";
  supervised.child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf-8"); });
  supervised.child.once("error", (error) => resolve({ exitCode: null, stderr: error.message }));
  void supervised.waitExit().then(({ code }) => resolve({ exitCode: code, stderr }));
});

function currentWindowsPrincipal(): string {
  const user = process.env.USERNAME || userInfo().username;
  const domain = process.env.USERDOMAIN;
  return domain ? `${domain}\\${user}` : user;
}

export class MasterKeyManager {
  private readonly globalDir: string;
  private readonly filePath: string;
  private readonly injectedKeytar?: KeytarLike;
  private readonly fsModule: FsLike;
  private readonly platform: NodeJS.Platform;
  private readonly windowsAclRunner: WindowsAclRunner;

  constructor(options?: {
    globalDir?: string;
    keytarModule?: KeytarLike;
    fsModule?: FsLike;
    platform?: NodeJS.Platform;
    windowsAclRunner?: WindowsAclRunner;
  }) {
    this.globalDir = resolveGlobalDir(options?.globalDir);
    this.filePath = join(this.globalDir, MASTER_KEY_FILENAME);
    this.injectedKeytar = options?.keytarModule;
    this.fsModule = options?.fsModule ?? fs;
    this.platform = options?.platform ?? process.platform;
    this.windowsAclRunner = options?.windowsAclRunner ?? runIcacls;
  }

  async getOrCreateKey(): Promise<Buffer> {
    const keychainKey = await this.readKeychainKey();
    if (keychainKey) {
      return keychainKey;
    }

    const fileKey = await this.readFileKey();
    if (fileKey) {
      return fileKey;
    }

    const generated = randomBytes(32);
    const persisted = await this.persistNewKeyWithRaceHandling(generated);
    console.info(`master key created (${persisted.backend})`);
    return persisted.key;
  }

  async rotateKey(): Promise<Buffer> {
    const next = randomBytes(32);
    const backend = await this.getBackend();

    if (backend === "file") {
      await this.writeFileKey(next, { overwrite: true });
      console.info("master key rotated (file)");
      return next;
    }

    if (backend === "keychain") {
      const wroteKeychain = await this.writeKeychainKey(next);
      if (!wroteKeychain) {
        throw new Error("unable to rotate master key in active keychain backend");
      }
      console.info("master key rotated (keychain)");
      return next;
    }

    const persisted = await this.persistNewKeyWithRaceHandling(next);
    console.info(`master key rotated (${persisted.backend})`);
    return persisted.key;
  }

  async getBackend(): Promise<"keychain" | "file" | "missing"> {
    const keychainKey = await this.readKeychainKey();
    if (keychainKey) {
      return "keychain";
    }

    const fileKey = await this.readFileKey();
    if (fileKey) {
      return "file";
    }

    return "missing";
  }

  private async persistNewKeyWithRaceHandling(
    generated: Buffer,
  ): Promise<{ key: Buffer; backend: "keychain" | "file" }> {
    const keytar = await this.loadKeytar();
    if (keytar) {
      const raced = await this.readKeychainKey();
      if (raced) {
        return { key: raced, backend: "keychain" };
      }
      try {
        await keytar.setPassword(
          MASTER_KEY_KEYCHAIN_SERVICE,
          MASTER_KEY_KEYCHAIN_ACCOUNT,
          generated.toString("base64"),
        );
        return { key: generated, backend: "keychain" };
      } catch {
        const afterRace = await this.readKeychainKey();
        if (afterRace) {
          return { key: afterRace, backend: "keychain" };
        }
        severityAuditLog.warn("master key keychain unavailable; using file backend");
      }
    }

    const racedFile = await this.readFileKey();
    if (racedFile) {
      return { key: racedFile, backend: "file" };
    }

    try {
      await this.writeFileKey(generated, { overwrite: false });
      return { key: generated, backend: "file" };
    } catch (error) {
      if (error instanceof MasterKeyPermissionError) {
        throw error;
      }
      const afterRace = await this.readFileKey();
      if (afterRace) {
        return { key: afterRace, backend: "file" };
      }
      throw new Error("failed to persist master key", { cause: error });
    }
  }

  private async readKeychainKey(): Promise<Buffer | null> {
    const keytar = await this.loadKeytar();
    if (!keytar) {
      return null;
    }

    try {
      const value = await keytar.getPassword(
        MASTER_KEY_KEYCHAIN_SERVICE,
        MASTER_KEY_KEYCHAIN_ACCOUNT,
      );
      if (!value) {
        return null;
      }
      const decoded = Buffer.from(value, "base64");
      if (decoded.length !== 32 || decoded.toString("base64") !== value) {
        throw new MasterKeyCorruptError("keychain", "keychain master key is corrupt");
      }
      return decoded;
    } catch (error) {
      if (error instanceof MasterKeyCorruptError) {
        throw error;
      }
      severityAuditLog.warn("master key keychain unavailable; using file backend");
      return null;
    }
  }

  private async readFileKey(): Promise<Buffer | null> {
    try {
      const value = await this.fsModule.readFile(this.filePath);
      if (value.length !== 32) {
        throw new MasterKeyCorruptError("file", "file master key is corrupt");
      }
      return value;
    } catch (error) {
      if (error instanceof MasterKeyCorruptError) {
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  /*
  FNXC:SecretsMasterKey 2026-10-07-17:59:
  The key is staged in an owner-only temp file and only then published under master.key, so a key whose protection failed never exists for the next read to accept, and a failed rotation leaves the current key intact.
  Owner-only means POSIX mode 0600, verified by stat, or on Windows an ACL with inheritance removed that grants only the current user (POSIX mode bits always read 0666 there).
  A first write publishes with link(), which fails if a racing writer published first; rotation publishes with rename().

  FNXC:SecretsMasterKey 2026-10-08-15:29:
  KB-073: an elevated Windows token (e.g. the GitHub windows-latest `runneradmin`) stamps its default DACL onto new files as EXPLICIT ACEs (SYSTEM, Administrators, user).
  `/inheritance:r` drops only inherited ACEs and `/grant:r` replaces only the named principal, so those extras survived and the key stayed readable by SYSTEM and every administrator.
  The staging file is therefore first `/reset` (DACL becomes inherited-only), then stripped of inheritance and granted to the current user alone; either call failing is fail-closed and nothing is published.
  */
  private async writeFileKey(value: Buffer, options: { overwrite: boolean }): Promise<void> {
    await this.fsModule.mkdir(this.globalDir, { recursive: true });
    const stagingPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const created = await this.fsModule.open(stagingPath, "wx", 0o600);
      await created.close();
      await this.restrictToOwner(stagingPath);
      const handle = await this.fsModule.open(stagingPath, "r+");
      try {
        await handle.writeFile(value);
      } finally {
        await handle.close();
      }
      if (options.overwrite) {
        await this.fsModule.rename(stagingPath, this.filePath);
      } else {
        await this.fsModule.link(stagingPath, this.filePath);
      }
    } finally {
      await this.fsModule.unlink(stagingPath).catch(() => undefined);
    }
  }

  private async restrictToOwner(path: string): Promise<void> {
    if (this.platform === "win32") {
      const commands = [
        [path, "/reset"],
        [path, "/inheritance:r", "/grant:r", `${currentWindowsPrincipal()}:F`],
      ];
      for (const args of commands) {
        const { exitCode, stderr } = await this.windowsAclRunner(args);
        if (exitCode !== 0) {
          throw new MasterKeyPermissionError(`master key file ACL could not be restricted to the current user: ${stderr.trim() || `icacls exit ${exitCode}`}`);
        }
      }
      return;
    }
    await this.fsModule.chmod(path, 0o600);
    const fileStat = await this.fsModule.stat(path);
    if ((fileStat.mode & 0o777) !== 0o600) {
      throw new MasterKeyPermissionError("master key file permissions must be 0600");
    }
  }

  private async writeKeychainKey(value: Buffer): Promise<boolean> {
    const keytar = await this.loadKeytar();
    if (!keytar) {
      return false;
    }

    try {
      await keytar.setPassword(
        MASTER_KEY_KEYCHAIN_SERVICE,
        MASTER_KEY_KEYCHAIN_ACCOUNT,
        value.toString("base64"),
      );
      return true;
    } catch {
      severityAuditLog.warn("master key keychain unavailable; using file backend");
      return false;
    }
  }

  private async loadKeytar(): Promise<KeytarLike | null> {
    if (this.injectedKeytar) {
      return this.injectedKeytar;
    }

    if (process.env.FUSION_MASTER_KEY_DISABLE_KEYCHAIN === "1") {
      return null;
    }

    try {
      const require = createRequire(import.meta.url);
      const modName = `key${"tar"}`;
      const module = require(modName) as { default?: KeytarLike } & KeytarLike;
      return module.default ?? module;
    } catch {
      return null;
    }
  }
}
