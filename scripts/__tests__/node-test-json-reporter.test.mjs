/*
FNXC:CI 2026-10-08-10:42:
KB-062's Windows scripts lane feeds this reporter's output to scripts/check-windows-known-failing.mjs, so the report must use Vitest's JSON shape and mark load failures and failing subtests as failed files while skip/todo never fail one.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compareWindowsRun } from "../check-windows-known-failing.mjs";
import { buildReport } from "../lib/node-test-json-reporter.mjs";

const reporterPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../lib/node-test-json-reporter.mjs");

test("node:test runs report passing, failing-subtest and load-failure files in the comparator's shape", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kb062-reporter-"));
  try {
    const passing = path.join(dir, "a-pass.test.mjs");
    const mixed = path.join(dir, "b-mixed.test.mjs");
    const broken = path.join(dir, "c-load.test.mjs");
    writeFileSync(passing, 'import test from "node:test";\ntest("passes", () => {});\n');
    writeFileSync(
      mixed,
      [
        'import { describe, it, test } from "node:test";',
        'import assert from "node:assert/strict";',
        'describe("suite", () => { it("ok", () => {}); it("bad", () => { assert.equal(1, 2); }); });',
        'test("later", { todo: true }, () => { throw new Error("todo fails"); });',
        'test("skipped", { skip: true }, () => {});',
        "",
      ].join("\n"),
    );
    writeFileSync(broken, 'throw new Error("boom at import");\n');
    const out = path.join(dir, "out.json");

    // node:test marks child processes with NODE_TEST_CONTEXT and refuses to run files recursively, so the nested run gets a clean env.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ["--test", `--test-reporter=${pathToFileURL(reporterPath).href}`, `--test-reporter-destination=${out}`, passing, mixed, broken], { cwd: dir, encoding: "utf8", env });
    assert.equal(run.status, 1, run.stderr);

    const report = JSON.parse(readFileSync(out, "utf8"));
    const byName = new Map(report.testResults.map((result) => [path.resolve(result.name), result]));
    assert.equal(byName.size, 3);
    assert.equal(byName.get(path.resolve(passing))?.status, "passed");
    assert.equal(byName.get(path.resolve(mixed))?.status, "failed");
    assert.equal(byName.get(path.resolve(broken))?.status, "failed");

    const bad = byName.get(path.resolve(mixed)).assertionResults.find((result) => result.fullName === "suite > bad");
    assert.equal(bad?.status, "failed");
    assert.ok(bad.failureMessages.length > 0 && bad.failureMessages[0] !== "");
    const todo = byName.get(path.resolve(mixed)).assertionResults.find((result) => result.title === "later");
    assert.equal(todo?.status, "todo");
    assert.notEqual(byName.get(path.resolve(broken)).message, "");

    const result = compareWindowsRun({ report, exitCode: 1, known: [], packageDir: dir });
    assert.equal(result.ok, false);
    assert.deepEqual([...result.unexpected].sort(), ["b-mixed.test.mjs", "c-load.test.mjs"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a todo or skipped failure alone never fails a file, and duplicate events collapse to one entry", () => {
  const file = path.resolve("x.test.mjs");
  const report = buildReport([
    { type: "test:fail", data: { file, nesting: 0, name: "todo case", todo: true, details: { error: new Error("todo") } } },
    { type: "test:pass", data: { file, nesting: 0, name: "skip case", skip: true } },
    { type: "test:pass", data: { file, nesting: 0, name: "ok" } },
    { type: "test:pass", data: { name: "no file" } },
  ]);
  assert.equal(report.testResults.length, 1);
  assert.equal(report.testResults[0].status, "passed");
  assert.equal(report.numTotalTestSuites, 1);
});
