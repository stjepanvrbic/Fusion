/*
FNXC:CI 2026-10-07-21:10:
The Windows Full Suite lane runs the whole core and engine suites, where some files still fail on Windows only. The lane must stay green on those known files and turn red on any other failure, a missing report, or a nonzero exit with no failing file to explain it.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareWindowsRun, readKnownFailing } from "../check-windows-known-failing.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packageDir = path.join(repoRoot, "packages", "engine");

function report(results) {
  return {
    numTotalTestSuites: results.length,
    testResults: results.map(([file, status]) => ({ name: path.join(packageDir, ...file.split("/")), status })),
  };
}

test("passes when only known Windows failures fail, and flags known files that now pass", () => {
  const known = ["src/__tests__/a.test.ts", "src/__tests__/b.test.ts"];
  const result = compareWindowsRun({
    report: report([["src/__tests__/a.test.ts", "failed"], ["src/__tests__/b.test.ts", "passed"], ["src/__tests__/c.test.ts", "passed"]]),
    exitCode: 1,
    known,
    packageDir,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.unexpected, []);
  assert.deepEqual(result.nowPassing, ["src/__tests__/b.test.ts"]);
});

test("fails on a failure outside the known list", () => {
  const result = compareWindowsRun({
    report: report([["src/__tests__/a.test.ts", "failed"], ["src/__tests__/new.test.ts", "failed"]]),
    exitCode: 1,
    known: ["src/__tests__/a.test.ts"],
    packageDir,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.unexpected, ["src/__tests__/new.test.ts"]);
});

test("fails when the report is missing or empty", () => {
  for (const missing of [undefined, { numTotalTestSuites: 0, testResults: [] }]) {
    const result = compareWindowsRun({ report: missing, exitCode: 1, known: [], packageDir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /no test results/);
  }
});

test("fails on a nonzero exit that no failing file explains", () => {
  const result = compareWindowsRun({ report: report([["src/__tests__/a.test.ts", "passed"]]), exitCode: 1, known: [], packageDir });
  assert.equal(result.ok, false);
  assert.match(result.reason, /exit code 1/);
});

test("the committed ledger names only existing files and stays at or under its ceiling", () => {
  const ledger = readKnownFailing();
  assert.ok(Number.isInteger(ledger.ceiling) && ledger.ceiling > 0);
  let total = 0;
  for (const [packageName, files] of Object.entries(ledger.packages)) {
    const dir = { "@fusion/core": "packages/core", "@fusion/engine": "packages/engine" }[packageName];
    assert.ok(dir, `unknown package ${packageName}`);
    assert.deepEqual(files, [...new Set(files)].sort(), `${packageName} entries must be sorted and unique`);
    for (const file of files) assert.ok(existsSync(path.join(repoRoot, dir, file)), `${packageName}: ${file} does not exist`);
    total += files.length;
  }
  assert.ok(total <= ledger.ceiling, `ledger has ${total} entries, above its ceiling of ${ledger.ceiling}; it may only shrink`);
  assert.equal(JSON.parse(readFileSync(path.join(repoRoot, "scripts/lib/windows-known-failing-tests.json"), "utf8")).ceiling, ledger.ceiling);
});
