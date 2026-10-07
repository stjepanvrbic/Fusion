import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createReleaseInputSnapshot, parsePorcelainPaths, releaseGeneratedPathMatcher } from "../lib/release-integrity.mjs";

test("parsePorcelainPaths keeps leading status columns and takes the destination of renames", () => {
  const output = " M package.json\0?? packages/engine/src/new file.ts\0D  .changeset/add-thing.md\0R  CHANGELOG.md\0OLD.md\0";
  assert.deepEqual(parsePorcelainPaths(output), ["package.json", "packages/engine/src/new file.ts", ".changeset/add-thing.md", "CHANGELOG.md", "OLD.md"]);
  assert.deepEqual(parsePorcelainPaths(""), []);
});

test("release-generated paths are the version, changelog, changeset and lockfile files only", () => {
  const isReleasePath = releaseGeneratedPathMatcher(["packages/cli", "plugins/examples/fusion-plugin-auto-label"]);
  for (const path of ["package.json", "pnpm-lock.yaml", "CHANGELOG.md", "CHANGELOG-archive.md", ".changeset/pre.json", ".changeset/add-thing.md", "packages/cli/package.json", "packages/cli/CHANGELOG.md", "plugins/examples/fusion-plugin-auto-label/CHANGELOG.md"]) {
    assert.equal(isReleasePath(path), true, path);
  }
  for (const path of ["packages/cli/src/bin.ts", "packages/engine/package.json", "scripts/release.mjs", "packages/cli/README.md", "docs/CHANGELOG.md"]) {
    assert.equal(isReleasePath(path), false, path);
  }
});

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "fusion-release-snapshot-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a snapshot restores files it changed and removes files it created", () => {
  withDir((dir) => {
    const changed = join(dir, "pre.json");
    const created = join(dir, "created.json");
    const untouched = join(dir, "untouched.json");
    writeFileSync(changed, "original");
    writeFileSync(untouched, "same");
    const snapshot = createReleaseInputSnapshot([changed, created, untouched]);
    writeFileSync(changed, "mutated");
    writeFileSync(created, "new");
    snapshot.seal();

    assert.deepEqual(snapshot.restore(), { restored: [changed, created], keptConcurrentEdits: [] });
    assert.equal(readFileSync(changed, "utf8"), "original");
    assert.equal(existsSync(created), false);
    assert.equal(readFileSync(untouched, "utf8"), "same");
  });
});

test("a snapshot never overwrites a file someone else changed after the release wrote it", () => {
  withDir((dir) => {
    const file = join(dir, "pre.json");
    writeFileSync(file, "original");
    const snapshot = createReleaseInputSnapshot([file]);
    writeFileSync(file, "release wrote this");
    snapshot.seal();
    writeFileSync(file, "operator edited this");

    assert.deepEqual(snapshot.restore(), { restored: [], keptConcurrentEdits: [file] });
    assert.equal(readFileSync(file, "utf8"), "operator edited this");
  });
});

test("an unsealed snapshot (exit mid-mutation) restores whatever the release left", () => {
  withDir((dir) => {
    const file = join(dir, "package.json");
    writeFileSync(file, "original");
    const snapshot = createReleaseInputSnapshot([file]);
    writeFileSync(file, "half-written");

    assert.deepEqual(snapshot.restore(), { restored: [file], keptConcurrentEdits: [] });
    assert.equal(readFileSync(file, "utf8"), "original");
    assert.deepEqual(snapshot.restore(), { restored: [], keptConcurrentEdits: [] }, "restore is idempotent");
  });
});
