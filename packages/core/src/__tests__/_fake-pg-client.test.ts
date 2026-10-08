/**
 * FNXC:TestInfraWindows 2026-10-08-07:11:
 * Proves the shared fake PostgreSQL client launches through the production `PgBackupManager` path on the current platform.
 * Without it, a fake that Windows cannot start (an extensionless shebang shim) fails every backup test with `spawn ... ENOENT`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PgBackupManager } from "../postgres/pg-backup.js";
import { writeFakePgClient } from "./_fake-pg-client.js";

const SECRET = "fake-client-secret";
const url = ["postgresql://", "fusion_user", ":", SECRET, "@", "db.example.test", ":", "6543", "/", "fusion_db"].join("");

describe("writeFakePgClient", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function workspace(): { root: string; fusionDir: string } {
    const root = mkdtempSync(join(tmpdir(), "fusion-fake-pg-client-"));
    tempDirs.push(root);
    const fusionDir = join(root, "project", ".fusion");
    mkdirSync(fusionDir, { recursive: true });
    return { root, fusionDir };
  }

  it("runs through PgBackupManager with the client argv and libpq env, and writes its --file output", async () => {
    const { root, fusionDir } = workspace();
    const logPath = join(root, "invocation.json");
    const fake = writeFakePgClient({
      dir: root,
      name: "pg_dump",
      script: [
        `fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({ argv, env: { PGHOST: process.env.PGHOST, PGPORT: process.env.PGPORT, PGPASSWORD: process.env.PGPASSWORD } }));`,
        'fs.writeFileSync(argAfter("--file"), "fake-dump");',
      ].join("\n"),
    });
    expect(fake.clientExec === undefined).toBe(process.platform !== "win32");

    const manager = new PgBackupManager(url, fusionDir, {
      pgDumpPath: fake.path,
      includeCentral: false,
      clientExec: fake.clientExec,
    });
    const pair = await manager.createBackup();

    expect(existsSync(pair.project!.path)).toBe(true);
    expect(readFileSync(pair.project!.path, "utf8")).toBe("fake-dump");
    const invocation = JSON.parse(readFileSync(logPath, "utf8")) as { argv: string[]; env: Record<string, string> };
    expect(invocation.argv).toContain("--file");
    expect(invocation.argv).toContain("--format=custom");
    expect(invocation.argv.join(" ")).not.toContain(SECRET);
    expect(invocation.env).toEqual({ PGHOST: "db.example.test", PGPORT: "6543", PGPASSWORD: SECRET });
  });

  it("surfaces a nonzero exit as a redacted pg_dump failure", async () => {
    const { root, fusionDir } = workspace();
    const fake = writeFakePgClient({
      dir: root,
      name: "pg_dump",
      script: `process.stderr.write(${JSON.stringify(`could not connect to ${url}\n`)}); process.exit(1);`,
    });
    const manager = new PgBackupManager(url, fusionDir, { pgDumpPath: fake.path, includeCentral: false, clientExec: fake.clientExec });

    const failure = await manager.createBackup().then(
      () => { throw new Error("expected createBackup to reject"); },
      (error: unknown) => error as Error,
    );
    expect(failure.message).toMatch(/pg_dump failed/);
    expect(failure.message).not.toContain(SECRET);
  });
});
