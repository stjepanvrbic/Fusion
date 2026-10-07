import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listGitSourceFiles } from "../lib/list-git-source-files.mjs";
import { MOVE_TARGET_PATHSPECS } from "../check-move-target-literals.mjs";

/*
FNXC:WindowsShell 2026-10-07-18:03:
The scanners' file list must come from git glob matching on every platform: tracked and untracked non-ignored files, nothing ignored, no duplicates, and checkout paths with spaces.
These run the real git, without a shell, so they fail on any platform where the pathspecs stop matching.
*/

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("lists tracked and untracked sources by glob in a checkout whose path contains spaces", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "git source list "));
  try {
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@t.t");
    git(dir, "config", "user.name", "t");
    mkdirSync(path.join(dir, "packages", "eng", "src", "deep"), { recursive: true });
    mkdirSync(path.join(dir, "packages", "eng", "dist"), { recursive: true });
    writeFileSync(path.join(dir, ".gitignore"), "dist/\nignored.ts\n");
    writeFileSync(path.join(dir, "packages", "eng", "src", "top.ts"), "export {};\n");
    writeFileSync(path.join(dir, "packages", "eng", "src", "deep", "tracked.tsx"), "export {};\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
    writeFileSync(path.join(dir, "packages", "eng", "src", "deep", "untracked.ts"), "export {};\n");
    writeFileSync(path.join(dir, "packages", "eng", "src", "ignored.ts"), "export {};\n");
    writeFileSync(path.join(dir, "packages", "eng", "src", "notes.md"), "not source\n");
    writeFileSync(path.join(dir, "packages", "eng", "dist", "out.ts"), "export {};\n");

    const files = listGitSourceFiles(["packages/*/src/**/*.ts", "packages/*/src/*.ts", "packages/*/src/**/*.tsx"], { cwd: dir });
    assert.deepEqual([...files].sort(), [
      "packages/eng/src/deep/tracked.tsx",
      "packages/eng/src/deep/untracked.ts",
      "packages/eng/src/top.ts",
    ]);
    assert.equal(new Set(files).size, files.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the move-target ratchet pathspecs match this repository's production sources", () => {
  const files = listGitSourceFiles(MOVE_TARGET_PATHSPECS, { cwd: repoRoot });
  assert.ok(files.length > 100, `expected the real source population, got ${files.length} files`);
  assert.ok(files.includes("packages/core/src/index.ts"));
  assert.ok(files.every((file) => /^packages\/[^/]+\/(src|app)\/.+\.tsx?$/.test(file)), "every listed file must match a pathspec");
});
