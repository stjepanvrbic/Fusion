import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isProductionSourceFile,
  listGitSourceFiles,
  listProductionSourceFiles,
} from "../lib/list-git-source-files.mjs";
import { CENSUS_SOURCE_SCOPE, censusFiles, summarize } from "../lib/lifecycle-column-census-ast.mjs";
import { MOVE_TARGET_SOURCE_SCOPE, countLegacyMoveTargetLiterals } from "../check-move-target-literals.mjs";

/*
FNXC:WindowsShell 2026-10-07-18:03:
The scanners' file list must come from git glob matching on every platform: tracked and untracked non-ignored files, nothing ignored, no duplicates, and checkout paths with spaces.
These run the real git, without a shell, so they fail on any platform where the pathspecs stop matching.

FNXC:SourceFileListing 2026-10-12-06:14:
A gate's list must hold every file under its roots with one of its extensions, files directly in a root included. The lifecycle-column census once listed 2,654 of 2,865 files and reported a zero backlog while five column guards sat in the 211 files it never opened.
The repository cases compare each gate's list with a set computed from the unfiltered `git ls-files` output by path segments, so a root or extension added to a scope is checked without a new test.

FNXC:SourceFileListing 2026-10-12-07:05:
Plugin code is in two places, `plugins/<plugin>/src` and `plugins/examples/<plugin>/src`, and both gates must list both. The example plugins are the code plugin authors copy, and a literal move destination is rejected on a renamed board wherever the call is written.
The example root is one level deeper than the plugin root, so the fixture holds a path one level deeper again that must stay unlisted.
*/

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const GATE_SCOPES = [
  {
    name: "lifecycle-column census",
    scope: CENSUS_SOURCE_SCOPE,
    mustList: [
      "packages/dashboard/app/App.tsx",
      "plugins/fusion-plugin-dependency-graph/src/index.ts",
      "plugins/examples/fusion-plugin-ci-status/src/index.ts",
      "packages/core/src/index.ts",
    ],
  },
  {
    name: "move-target check",
    scope: MOVE_TARGET_SOURCE_SCOPE,
    mustList: [
      "packages/dashboard/app/App.tsx",
      "packages/core/src/index.ts",
      "plugins/fusion-plugin-even-realities-glasses/src/agent-actions.ts",
      "plugins/examples/fusion-plugin-ci-status/src/index.ts",
    ],
  },
];

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function writeFiles(dir, files) {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
}

function withRepository(body) {
  const dir = mkdtempSync(path.join(tmpdir(), "git source list "));
  try {
    git(dir, "init", "-q");
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SOURCE = "export {};\n";
const TRACKED_FILES = {
  ".gitignore": "dist/\nignored.ts\n",
  "packages/eng/src/top.ts": SOURCE,
  "packages/eng/src/deep/tracked.tsx": SOURCE,
  "packages/eng/src/deep/er/x.ts": SOURCE,
  "packages/eng/src/types.d.ts": SOURCE,
  "packages/eng/src/notes.md": "not source\n",
  "packages/eng/src/schema.d.cts": SOURCE,
  "packages/eng/src/comments": "no extension\n",
  "packages/dash/app/App.tsx": SOURCE,
  "packages/dash/app/api.ts": SOURCE,
  "packages/dash/app/components/C.tsx": SOURCE,
  "plugins/p1/src/index.ts": SOURCE,
  "plugins/p1/src/View.tsx": SOURCE,
  "plugins/p1/src/sub/n.ts": SOURCE,
  "plugins/examples/ex/src/index.ts": SOURCE,
  "plugins/examples/ex/deeper/src/y.ts": SOURCE,
  "packages/a/b/src/x.ts": SOURCE,
};
const UNTRACKED_FILES = {
  "packages/dash/app/untracked.ts": SOURCE,
  "plugins/p1/src/untrackedTop.tsx": SOURCE,
  "packages/eng/src/ignored.ts": SOURCE,
  "packages/eng/dist/out.ts": SOURCE,
};

let fixture;
before(() => {
  fixture = mkdtempSync(path.join(tmpdir(), "git source list "));
  git(fixture, "init", "-q");
  writeFiles(fixture, TRACKED_FILES);
  git(fixture, "add", "-A");
  git(fixture, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "-m", "init");
  writeFiles(fixture, UNTRACKED_FILES);
});
after(() => {
  rmSync(fixture, { recursive: true, force: true });
});

const FIXTURE_SOURCE_FILES = [
  "packages/dash/app/App.tsx",
  "packages/dash/app/api.ts",
  "packages/dash/app/components/C.tsx",
  "packages/dash/app/untracked.ts",
  "packages/eng/src/deep/er/x.ts",
  "packages/eng/src/deep/tracked.tsx",
  "packages/eng/src/top.ts",
  "packages/eng/src/types.d.ts",
  "plugins/examples/ex/src/index.ts",
  "plugins/p1/src/View.tsx",
  "plugins/p1/src/index.ts",
  "plugins/p1/src/sub/n.ts",
  "plugins/p1/src/untrackedTop.tsx",
];

test("lists direct children and nested files of every census root, tracked and untracked, and nothing else", () => {
  const files = listGitSourceFiles(CENSUS_SOURCE_SCOPE, { cwd: fixture });
  assert.deepEqual([...files].sort(), FIXTURE_SOURCE_FILES);
  assert.equal(new Set(files).size, files.length);
});

test("lists the same package, plugin and example-plugin files under the move-target scope", () => {
  const files = listGitSourceFiles(MOVE_TARGET_SOURCE_SCOPE, { cwd: fixture });
  assert.deepEqual([...files].sort(), FIXTURE_SOURCE_FILES);
  assert.equal(new Set(files).size, files.length);
});

test("the production list drops test files that the full list contains", () => {
  withRepository((dir) => {
    writeFiles(dir, {
      "packages/eng/src/top.ts": SOURCE,
      "packages/eng/src/__tests__/a.test.ts": SOURCE,
      "packages/dash/app/b.spec.tsx": SOURCE,
    });

    assert.deepEqual([...listGitSourceFiles(CENSUS_SOURCE_SCOPE, { cwd: dir })].sort(), [
      "packages/dash/app/b.spec.tsx",
      "packages/eng/src/__tests__/a.test.ts",
      "packages/eng/src/top.ts",
    ]);
    assert.deepEqual(listProductionSourceFiles(CENSUS_SOURCE_SCOPE, { cwd: dir }), ["packages/eng/src/top.ts"]);
    assert.equal(isProductionSourceFile("packages/eng/src/latest.ts"), true);
  });
});

test("a column guard and a literal move target in a file directly under a root are counted", () => {
  withRepository((dir) => {
    const guard = 'export const f = (task: { column: string }) => task.column === "in-review";\n';
    const move = 'declare const store: any;\ndeclare const id: string;\nstore.moveTask(id, "done");\n';
    writeFiles(dir, {
      "packages/dash/app/App.tsx": guard,
      "plugins/p1/src/cards.ts": guard,
      "packages/dash/app/main.tsx": move,
    });
    const read = (file) => readFileSync(path.join(dir, file), "utf8");

    const summary = summarize(censusFiles(listProductionSourceFiles(CENSUS_SOURCE_SCOPE, { cwd: dir }), read));
    assert.equal(summary.totals.column, 2);
    assert.deepEqual(summary.byFile.map(([file]) => file).sort(), ["packages/dash/app/App.tsx", "plugins/p1/src/cards.ts"]);

    const moveTargetFiles = listProductionSourceFiles(MOVE_TARGET_SOURCE_SCOPE, { cwd: dir });
    assert.ok(moveTargetFiles.includes("packages/dash/app/main.tsx"));
    assert.equal(countLegacyMoveTargetLiterals(read("packages/dash/app/main.tsx"), "packages/dash/app/main.tsx"), 1);
  });
});

test("a column guard and a literal move target in plugin and example-plugin files are counted", () => {
  withRepository((dir) => {
    const guard = 'export const f = (toColumn: string) => toColumn === "in-progress";\n';
    const move = 'declare const store: any;\ndeclare const id: string;\nstore.moveTask(id, "done");\n';
    writeFiles(dir, {
      "plugins/examples/ex/src/index.ts": guard + move,
      "plugins/p1/src/move.ts": move,
    });
    const read = (file) => readFileSync(path.join(dir, file), "utf8");

    const summary = summarize(censusFiles(listProductionSourceFiles(CENSUS_SOURCE_SCOPE, { cwd: dir }), read));
    assert.equal(summary.totals.column, 1);
    assert.deepEqual(summary.byFile.map(([file]) => file), ["plugins/examples/ex/src/index.ts"]);

    const moveTargetFiles = [...listProductionSourceFiles(MOVE_TARGET_SOURCE_SCOPE, { cwd: dir })].sort();
    assert.deepEqual(moveTargetFiles, ["plugins/examples/ex/src/index.ts", "plugins/p1/src/move.ts"]);
    for (const file of moveTargetFiles) assert.equal(countLegacyMoveTargetLiterals(read(file), file), 1, file);
  });
});

/** True when `file` sits below `root`, where `*` in the root stands for exactly one path segment. */
function isUnderRoot(file, root) {
  const rootSegments = root.split("/");
  const fileSegments = file.split("/");
  return fileSegments.length > rootSegments.length
    && rootSegments.every((segment, index) => segment === "*" || segment === fileSegments[index]);
}

let repositoryFiles;
function allRepositoryFiles() {
  repositoryFiles ??= git(repoRoot, "ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean);
  return repositoryFiles;
}

for (const { name, scope, mustList } of GATE_SCOPES) {
  test(`the ${name} lists every repository file under its roots that has one of its extensions`, () => {
    const expected = allRepositoryFiles()
      .filter((file) => scope.roots.some((root) => isUnderRoot(file, root)))
      .filter((file) => scope.extensions.some((extension) => file.endsWith(extension)))
      .sort();
    const listed = [...listGitSourceFiles(scope, { cwd: repoRoot })].sort();
    assert.ok(expected.length > 100, `expected the real source population, got ${expected.length} files`);

    const listedSet = new Set(listed);
    const expectedSet = new Set(expected);
    const omitted = expected.filter((file) => !listedSet.has(file));
    const unexpected = listed.filter((file) => !expectedSet.has(file));
    assert.deepEqual(
      { omitted, unexpected },
      { omitted: [], unexpected: [] },
      `${name}: ${omitted.length} file(s) under the roots are not listed and ${unexpected.length} listed file(s) are outside them`,
    );
    assert.equal(listed.length, expected.length);
    for (const file of mustList) assert.ok(listedSet.has(file), `${name} does not list ${file}`);

    const production = listProductionSourceFiles(scope, { cwd: repoRoot });
    assert.deepEqual([...production].sort(), expected.filter(isProductionSourceFile));
  });
}

test("refuses a scope that yields no pathspec without running git", () => {
  const calls = [];
  const exec = (...args) => {
    calls.push(args);
    return "";
  };
  assert.throws(() => listGitSourceFiles({ roots: [], extensions: [".ts"] }, { exec }), TypeError);
  assert.throws(() => listGitSourceFiles({ roots: ["packages/*/src"], extensions: [] }, { exec }), TypeError);
  const pathspecStrings = ["packages/*/src/**/*.ts"];
  assert.throws(() => listGitSourceFiles(pathspecStrings, { exec }), TypeError);
  assert.throws(() => listProductionSourceFiles(undefined, { exec }), TypeError);
  assert.equal(calls.length, 0);
});
