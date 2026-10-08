import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("keytar", () => {
  throw new Error("MODULE_NOT_FOUND");
});

import {
  MASTER_KEY_FILENAME,
  MasterKeyCorruptError,
  MasterKeyManager,
  MasterKeyPermissionError,
  type KeytarLike,
} from "../secrets/master-key.js";

type MutableKeytar = KeytarLike & { writes: number; stored: string | null };

const execFileAsync = promisify(execFile);

const unavailableKeychain: KeytarLike = {
  async getPassword() {
    throw new Error("keychain unavailable");
  },
  async setPassword() {
    throw new Error("keychain unavailable");
  },
  async deletePassword() {
    throw new Error("keychain unavailable");
  },
};

/** The raw icacls listing of `path` plus the principals it names, e.g. `DOMAIN\user` from `DOMAIN\user:(F)`. */
async function listAclPrincipals(path: string): Promise<{ stdout: string; principals: string[] }> {
  const { stdout } = await execFileAsync("icacls", [path], { windowsHide: true });
  const principals = stdout
    .split(/\r?\n/)
    .map((line) => (line.startsWith(path) ? line.slice(path.length) : line).trim())
    .filter((line) => line.includes(":("))
    .map((line) => line.slice(0, line.indexOf(":(")).toLowerCase());
  return { stdout, principals };
}

/*
FNXC:SecretsMasterKey 2026-10-07-17:59:
The file-backed master key must be readable only by its owner, enforced with the platform's own mechanism: POSIX mode 0600, or a Windows ACL that names only the current user.
*/
async function expectOwnerOnly(path: string): Promise<void> {
  if (process.platform === "win32") {
    const { stdout, principals } = await listAclPrincipals(path);
    const user = userInfo().username.toLowerCase();
    // A failure must show who can read the key, so the message carries the raw listing and the expected identity.
    const context = `icacls ${path}:\n${stdout}\nexpected only the current user (USERDOMAIN=${process.env.USERDOMAIN ?? ""}, USERNAME=${process.env.USERNAME ?? ""}, userInfo=${userInfo().username})`;
    expect(principals.length, context).toBeGreaterThan(0);
    expect(principals.filter((principal) => !principal.endsWith(`\\${user}`)), context).toEqual([]);
    return;
  }
  expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
}

function keyDirEntries(dir: string): string[] {
  return readdirSync(dir).sort();
}

function createKeytar(initial?: Buffer): MutableKeytar {
  let stored = initial ? initial.toString("base64") : null;
  return {
    writes: 0,
    get stored() {
      return stored;
    },
    set stored(v: string | null) {
      stored = v;
    },
    async getPassword() {
      return stored;
    },
    async setPassword(_s, _a, value) {
      stored = value;
      this.writes += 1;
    },
    async deletePassword() {
      stored = null;
      return true;
    },
  };
}

describe("MasterKeyManager", () => {
  let globalDir: string;

  beforeEach(() => {
    globalDir = mkdtempSync(join(tmpdir(), "fn-master-key-test-"));
  });

  afterEach(() => {
    rmSync(globalDir, { recursive: true, force: true });
  });

  it("uses keychain on first run", async () => {
    const keytar = createKeytar();
    const manager = new MasterKeyManager({ globalDir, keytarModule: keytar });

    const key = await manager.getOrCreateKey();
    expect(key).toHaveLength(32);
    await expect(fs.stat(join(globalDir, MASTER_KEY_FILENAME))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(manager.getBackend()).resolves.toBe("keychain");
  });

  it("falls back to file when keychain unavailable", async () => {
    const failing: KeytarLike = {
      async getPassword() {
        throw new Error("keychain unavailable");
      },
      async setPassword() {
        throw new Error("keychain unavailable");
      },
      async deletePassword() {
        throw new Error("keychain unavailable");
      },
    };
    const manager = new MasterKeyManager({ globalDir, keytarModule: failing });

    const key = await manager.getOrCreateKey();
    expect(key).toHaveLength(32);
    const keyPath = join(globalDir, MASTER_KEY_FILENAME);
    const fileStat = await fs.stat(keyPath);
    expect(fileStat.size).toBe(32);
    await expectOwnerOnly(keyPath);
    expect(keyDirEntries(globalDir)).toEqual([MASTER_KEY_FILENAME]);
    await expect(manager.getBackend()).resolves.toBe("file");
  });

  it("is idempotent on keychain", async () => {
    const original = Buffer.alloc(32, 7);
    const keytar = createKeytar(original);
    const manager = new MasterKeyManager({ globalDir, keytarModule: keytar });

    const a = await manager.getOrCreateKey();
    const b = await manager.getOrCreateKey();

    expect(a.equals(original)).toBe(true);
    expect(b.equals(original)).toBe(true);
    expect(keytar.writes).toBe(0);
  });

  it("is idempotent on file backend", async () => {
    const failing = {
      async getPassword() {
        throw new Error("unavailable");
      },
      async setPassword() {
        throw new Error("unavailable");
      },
      async deletePassword() {
        throw new Error("unavailable");
      },
    } satisfies KeytarLike;
    const manager = new MasterKeyManager({ globalDir, keytarModule: failing });

    const a = await manager.getOrCreateKey();
    const b = await manager.getOrCreateKey();

    expect(a.equals(b)).toBe(true);
  });

  it("handles race by returning externally written keychain value", async () => {
    const external = Buffer.alloc(32, 9).toString("base64");
    let stored: string | null = null;
    const keytar: KeytarLike = {
      async getPassword() {
        return stored;
      },
      async setPassword() {
        stored = external;
        throw new Error("write lost race");
      },
      async deletePassword() {
        return true;
      },
    };
    const manager = new MasterKeyManager({ globalDir, keytarModule: keytar });

    const key = await manager.getOrCreateKey();
    expect(key.equals(Buffer.from(external, "base64"))).toBe(true);
  });

  it("throws on corrupt keychain entry", async () => {
    const keytar = createKeytar();
    keytar.stored = Buffer.alloc(10).toString("base64");
    const manager = new MasterKeyManager({ globalDir, keytarModule: keytar });

    await expect(manager.getOrCreateKey()).rejects.toBeInstanceOf(MasterKeyCorruptError);
  });

  it("throws on corrupt file entry", async () => {
    writeFileSync(join(globalDir, MASTER_KEY_FILENAME), Buffer.alloc(10));
    const manager = new MasterKeyManager({ globalDir });

    await expect(manager.getOrCreateKey()).rejects.toBeInstanceOf(MasterKeyCorruptError);
  });

  it("throws when file permission verification fails", async () => {
    const failing: KeytarLike = {
      async getPassword() {
        throw new Error("no keychain");
      },
      async setPassword() {
        throw new Error("no keychain");
      },
      async deletePassword() {
        return true;
      },
    };
    const manager = new MasterKeyManager({
      globalDir,
      keytarModule: failing,
      platform: "linux",
      fsModule: {
        ...fs,
        stat: async (path) => ({ ...(await fs.stat(path)), mode: 0o644 }),
      },
    });

    await expect(manager.getOrCreateKey()).rejects.toBeInstanceOf(MasterKeyPermissionError);
    // A key whose protection failed is never published, so the next read cannot silently accept it.
    expect(keyDirEntries(globalDir)).toEqual([]);
    await expect(new MasterKeyManager({ globalDir, keytarModule: failing, platform: "linux" }).getBackend()).resolves.toBe("missing");
  });

  /*
  FNXC:SecretsMasterKey 2026-10-07-19:55:
  The Windows grant names exactly the current user: `DOMAIN\\user` when the session reports a domain, the bare account name otherwise.
  The environment is pinned per case so the assertion is exact on every host; CI Linux runners have no USERDOMAIN.
  */
  it.each([
    { name: "a domain account", env: { USERDOMAIN: "CONTOSO", USERNAME: "operator" }, principal: () => "CONTOSO\\operator" },
    { name: "an account without a reported domain", env: { USERDOMAIN: "", USERNAME: "" }, principal: () => userInfo().username },
  ])("restricts the Windows key file to only $name before publishing it", async ({ env, principal }) => {
    vi.stubEnv("USERDOMAIN", env.USERDOMAIN);
    vi.stubEnv("USERNAME", env.USERNAME);
    const calls: string[][] = [];
    const manager = new MasterKeyManager({
      globalDir,
      keytarModule: unavailableKeychain,
      platform: "win32",
      windowsAclRunner: async (args) => {
        calls.push(args);
        return { exitCode: 0, stderr: "" };
      },
    });

    try {
      const key = await manager.getOrCreateKey();
      expect(key).toHaveLength(32);
      expect(calls).toHaveLength(2);
      const target = calls[0][0];
      expect(target).not.toBe(join(globalDir, MASTER_KEY_FILENAME));
      expect(target.startsWith(join(globalDir, MASTER_KEY_FILENAME))).toBe(true);
      expect(calls).toEqual([
        [target, "/reset"],
        [target, "/inheritance:r", "/grant:r", `${principal()}:F`],
      ]);
      expect(keyDirEntries(globalDir)).toEqual([MASTER_KEY_FILENAME]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  /*
  FNXC:SecretsMasterKey 2026-10-08-15:29:
  KB-073 runner shape: on GitHub windows-latest (elevated `runneradmin`) a new file carries EXPLICIT SYSTEM, Administrators and user ACEs from the token default DACL, and the old `/inheritance:r /grant:r` left the first two in place.
  The fake runner models icacls semantics over that captured ACL so the fix is proven on every platform.
  */
  it("leaves only the current user on a staging file that starts with explicit elevated-token ACEs", async () => {
    vi.stubEnv("USERDOMAIN", "runnervmfi6oq");
    vi.stubEnv("USERNAME", "runneradmin");
    type Ace = { principal: string; inherited: boolean };
    const parentInheritable = ["NT AUTHORITY\\SYSTEM", "BUILTIN\\Administrators", "runnervmfi6oq\\runneradmin"];
    const acls = new Map<string, Ace[]>();
    const aclOf = (path: string): Ace[] => acls.get(path)
      ?? parentInheritable.map((principal) => ({ principal, inherited: false }));
    let publishedAcl: Ace[] | undefined;
    const manager = new MasterKeyManager({
      globalDir,
      keytarModule: unavailableKeychain,
      platform: "win32",
      fsModule: {
        ...fs,
        link: async (from, to) => {
          publishedAcl = aclOf(String(from));
          await fs.link(from, to);
        },
      },
      windowsAclRunner: async ([path, ...flags]) => {
        let acl = aclOf(path);
        for (let i = 0; i < flags.length; i += 1) {
          if (flags[i] === "/reset") acl = parentInheritable.map((principal) => ({ principal, inherited: true }));
          if (flags[i] === "/inheritance:r") acl = acl.filter((ace) => !ace.inherited);
          if (flags[i] === "/grant:r") {
            const principal = flags[++i].replace(/:F$/, "");
            acl = [...acl.filter((ace) => ace.principal !== principal), { principal, inherited: false }];
          }
        }
        acls.set(path, acl);
        return { exitCode: 0, stderr: "" };
      },
    });

    try {
      await manager.getOrCreateKey();
      expect(publishedAcl).toEqual([{ principal: "runnervmfi6oq\\runneradmin", inherited: false }]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    { name: "the explicit-ACE reset", failingCall: 0, expectedCalls: 1 },
    { name: "the owner-only grant", failingCall: 1, expectedCalls: 2 },
  ])("publishes no Windows key file when $name fails", async ({ failingCall, expectedCalls }) => {
    const calls: string[][] = [];
    const manager = new MasterKeyManager({
      globalDir,
      keytarModule: unavailableKeychain,
      platform: "win32",
      windowsAclRunner: async (args) => {
        calls.push(args);
        return calls.length - 1 === failingCall ? { exitCode: 5, stderr: "Access is denied." } : { exitCode: 0, stderr: "" };
      },
    });

    await expect(manager.getOrCreateKey()).rejects.toBeInstanceOf(MasterKeyPermissionError);
    expect(calls).toHaveLength(expectedCalls);
    expect(keyDirEntries(globalDir)).toEqual([]);
  });

  it("publishes no Windows key file when the ACL cannot be applied", async () => {
    const manager = new MasterKeyManager({
      globalDir,
      keytarModule: unavailableKeychain,
      platform: "win32",
      windowsAclRunner: async () => ({ exitCode: 5, stderr: "Access is denied." }),
    });

    await expect(manager.getOrCreateKey()).rejects.toBeInstanceOf(MasterKeyPermissionError);
    expect(keyDirEntries(globalDir)).toEqual([]);
  });

  it("keeps the existing file key when rotation cannot protect the replacement", async () => {
    const existing = Buffer.alloc(32, 3);
    writeFileSync(join(globalDir, MASTER_KEY_FILENAME), existing);
    const manager = new MasterKeyManager({
      globalDir,
      keytarModule: unavailableKeychain,
      platform: "win32",
      windowsAclRunner: async () => ({ exitCode: 5, stderr: "Access is denied." }),
    });

    await expect(manager.rotateKey()).rejects.toBeInstanceOf(MasterKeyPermissionError);
    expect((await fs.readFile(join(globalDir, MASTER_KEY_FILENAME))).equals(existing)).toBe(true);
    expect(keyDirEntries(globalDir)).toEqual([MASTER_KEY_FILENAME]);
  });

  it("rotates a file key into an owner-only file", async () => {
    const manager = new MasterKeyManager({ globalDir, keytarModule: unavailableKeychain });
    const before = await manager.getOrCreateKey();

    const rotated = await manager.rotateKey();

    expect(rotated.equals(before)).toBe(false);
    expect((await fs.readFile(join(globalDir, MASTER_KEY_FILENAME))).equals(rotated)).toBe(true);
    await expectOwnerOnly(join(globalDir, MASTER_KEY_FILENAME));
    expect(keyDirEntries(globalDir)).toEqual([MASTER_KEY_FILENAME]);
  });

  it("rotates key and persists to active backend", async () => {
    const keytar = createKeytar();
    const manager = new MasterKeyManager({ globalDir, keytarModule: keytar });

    const before = await manager.getOrCreateKey();
    const rotated = await manager.rotateKey();
    const after = await manager.getOrCreateKey();

    expect(rotated.equals(before)).toBe(false);
    expect(after.equals(rotated)).toBe(true);
    await expect(manager.getBackend()).resolves.toBe("keychain");
  });

  it("throws if active keychain backend cannot be updated during rotation", async () => {
    const original = Buffer.alloc(32, 5).toString("base64");
    const keytar: KeytarLike = {
      async getPassword() {
        return original;
      },
      async setPassword() {
        throw new Error("keychain unavailable");
      },
      async deletePassword() {
        return false;
      },
    };
    const manager = new MasterKeyManager({ globalDir, keytarModule: keytar });

    await expect(manager.rotateKey()).rejects.toThrow(
      "unable to rotate master key in active keychain backend",
    );
  });

  it("falls back to file when keytar import is missing", async () => {
    const manager = new MasterKeyManager({ globalDir });

    const key = await manager.getOrCreateKey();
    expect(key).toHaveLength(32);
    await expectOwnerOnly(join(globalDir, MASTER_KEY_FILENAME));
    await expect(manager.getBackend()).resolves.toBe("file");
  });
});
