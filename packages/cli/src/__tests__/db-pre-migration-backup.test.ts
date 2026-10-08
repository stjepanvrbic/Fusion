/*
FNXC:PostgresMigration 2026-10-08-14:29:
KB-069: `fn db migrate` copies each present legacy SQLite file into a timestamped backup directory named by the file's basename. Source paths are native (backslashes on Windows), so the copy name must come from `basename`, not a `/` split.
*/
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, isAbsolute } from "node:path";
import { defaultMigrationSources } from "@fusion/core";
import { createPreMigrationBackup } from "../commands/db.js";

describe("createPreMigrationBackup", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "kb069-backup-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("copies present sources under their basenames and skips absent ones", async () => {
    const fusionDir = join(root, "proj", ".fusion");
    const globalDir = join(root, "global");
    const sources = defaultMigrationSources(fusionDir, globalDir);
    const project = sources.find((s) => s.sqlitePath.endsWith("fusion.db"))!;
    const central = sources.find((s) => s.sqlitePath.endsWith("fusion-central.db"))!;
    for (const [source, content] of [[project, "project-bytes"], [central, "central-bytes"]] as const) {
      await mkdir(dirname(source.sqlitePath), { recursive: true });
      await writeFile(source.sqlitePath, content);
    }

    const backupDir = await createPreMigrationBackup(fusionDir, globalDir, sources);

    const rel = relative(join(globalDir, "migration-backups"), backupDir);
    expect(rel === "" || rel.startsWith("..") || isAbsolute(rel)).toBe(false);
    expect((await readdir(backupDir)).sort()).toEqual(["fusion-central.db", "fusion.db"]);
    expect(await readFile(join(backupDir, "fusion.db"), "utf8")).toBe("project-bytes");
    expect(await readFile(join(backupDir, "fusion-central.db"), "utf8")).toBe("central-bytes");
  });
});
