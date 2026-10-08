/*
FNXC:PostgresMigration 2026-10-08-14:29:
KB-069: legacy SQLite source paths must be native platform paths. They are persisted as the migration notice's retained-backup list and compared against `join(...)` paths, so mixed or doubled separators are a defect.
Pure unit test; no PostgreSQL required.
*/
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { defaultMigrationSources } from "../../postgres/sqlite-migrator.js";
import { ARCHIVE_SCHEMA, CENTRAL_SCHEMA, PROJECT_SCHEMA } from "../../postgres/schema/_shared.js";

const fusionDir = join(tmpdir(), "proj", ".fusion");
const globalDir = join(tmpdir(), "global-fusion");

describe("defaultMigrationSources", () => {
  it("builds native joined paths in archive/project/central order", () => {
    const sources = defaultMigrationSources(fusionDir, globalDir);
    expect(sources.map((s) => s.sqlitePath)).toEqual([
      join(fusionDir, "archive.db"),
      join(fusionDir, "fusion.db"),
      join(globalDir, "fusion-central.db"),
    ]);
    expect(sources.map((s) => s.pgSchema)).toEqual([ARCHIVE_SCHEMA, PROJECT_SCHEMA, CENTRAL_SCHEMA]);
    expect(sources[1]!.projectPath).toBe(resolve(dirname(fusionDir)));
  });

  it("normalizes directories passed with a trailing separator", () => {
    const sources = defaultMigrationSources(fusionDir + sep, globalDir + sep);
    expect(sources.map((s) => s.sqlitePath)).toEqual([
      join(fusionDir, "archive.db"),
      join(fusionDir, "fusion.db"),
      join(globalDir, "fusion-central.db"),
    ]);
  });

  it("never mixes in the non-native separator", () => {
    const foreign = sep === "\\" ? "/" : "\\";
    for (const source of defaultMigrationSources(fusionDir, globalDir)) {
      expect(source.sqlitePath).not.toContain(foreign);
    }
  });
});
