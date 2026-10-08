/*
FNXC:CI 2026-10-07-21:10:
The Windows Full Suite lane runs the whole core and engine suites, where some files still fail on Windows only. The lane must stay green on those known files and turn red on any other failure, a missing report, or a nonzero exit with no failing file to explain it.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PACKAGE_DIRS,
  classifyLoadTimeout,
  compareWindowsRun,
  isTimeoutMessage,
  readKnownFailing,
  renderWindowsSummary,
} from "../check-windows-known-failing.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packageDir = path.join(repoRoot, "packages", "engine");

// Each row is [file, status, extra?]; extra may carry Vitest JSON `assertionResults` and a file-level `message`.
function report(results, dir = packageDir) {
  return {
    numTotalTestSuites: results.length,
    testResults: results.map(([file, status, extra = {}]) => ({ name: path.join(dir, ...file.split("/")), status, ...extra })),
  };
}

const TIMEOUT_STACK = "Error: Test timed out in 15000ms.\nIf this is a long-running test, pass a timeout value as the last argument or configure it globally with \"testTimeout\".\n    at x (file.ts:1:1)";
const failedWith = (...messages) => ({ assertionResults: [{ status: "failed", title: "t", fullName: "t", failureMessages: messages }, { status: "passed", title: "ok", fullName: "ok", failureMessages: [] }] });

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

/*
FNXC:CI 2026-10-08-08:51:
Load-only timeouts must be distinguishable from real Windows failures in the job summary, but classification is informational: the verdict and ledger semantics never change, and a file counts as a load timeout only with positive timeout-message evidence.
*/
test("an unexpected timeout-only file still fails, but is classified as a load timeout", () => {
  const file = "src/__tests__/slow.test.ts";
  const result = compareWindowsRun({ report: report([[file, "failed", failedWith(TIMEOUT_STACK)]]), exitCode: 1, known: [], packageDir });
  assert.equal(result.ok, false);
  assert.deepEqual(result.unexpected, [file]);
  assert.deepEqual(result.unexpectedReal, []);
  assert.deepEqual(result.loadTimeouts, [{ file, known: false, timeouts: 1 }]);
  assert.match(result.reason, /outside the known Windows list.*timeout-only/);
});

test("a file-level hook timeout is timeout-only, and a known file timing out stays a known failure", () => {
  assert.deepEqual(classifyLoadTimeout({ status: "failed", message: "Hook timed out in 15000ms.", assertionResults: [] }), { timeoutOnly: true, timeouts: 1 });
  const file = "src/__tests__/known.test.ts";
  const result = compareWindowsRun({
    report: report([[file, "failed", { message: "Hook timed out in 15000ms.", assertionResults: [] }]]),
    exitCode: 1,
    known: [file],
    packageDir,
  });
  assert.equal(result.ok, true);
  assert.equal(result.loadTimeouts[0].known, true);
});

test("a timeout mixed with an assertion error, or a failure with no message, is a real failure", () => {
  const mixed = "src/__tests__/mixed.test.ts";
  const silent = "src/__tests__/silent.test.ts";
  const result = compareWindowsRun({
    report: report([
      [mixed, "failed", failedWith(TIMEOUT_STACK, "AssertionError: expected 1 to be 2")],
      [silent, "failed", { message: "", assertionResults: [{ status: "skipped", failureMessages: [] }] }],
    ]),
    exitCode: 1,
    known: [],
    packageDir,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.unexpectedReal, [mixed, silent]);
  assert.deepEqual(result.loadTimeouts, []);
  assert.deepEqual(classifyLoadTimeout({ status: "failed" }), { timeoutOnly: false, timeouts: 0 });
});

test("the summary separates real unexpected failures from load timeouts", () => {
  const real = "src/__tests__/real.test.ts";
  const slow = "src/__tests__/slow.test.ts";
  const result = compareWindowsRun({
    report: report([[real, "failed", failedWith("AssertionError: expected 1 to be 2")], [slow, "failed", failedWith(TIMEOUT_STACK, TIMEOUT_STACK)]]),
    exitCode: 1,
    known: [],
    packageDir,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /1 of them are timeout-only/);
  const summary = renderWindowsSummary({ packageName: "@fusion/engine", label: "engine-1 (shard 1/2)", result, knownCount: 0 });
  assert.match(summary, /^### Windows @fusion\/engine — engine-1 \(shard 1\/2\): FAIL/);
  const [beforeLoad, loadSection] = summary.split("Load timeouts");
  assert.match(beforeLoad, /Unexpected failures:\n- `src\/__tests__\/real\.test\.ts`/);
  assert.ok(!beforeLoad.includes(slow));
  assert.match(loadSection, /`src\/__tests__\/slow\.test\.ts` \(unexpected; 2 timeouts\)/);
  assert.ok(!loadSection.includes(real));

  const clean = compareWindowsRun({ report: report([[real, "failed", failedWith("AssertionError: x")]]), exitCode: 1, known: [real], packageDir });
  assert.ok(!renderWindowsSummary({ packageName: "@fusion/engine", result: clean, knownCount: 1 }).includes("Load timeouts"));
});

test("isTimeoutMessage matches only Vitest test and hook timeouts", () => {
  for (const text of ["Error: Test timed out in 15000ms.\nmore", "Test timed out in 15000ms.", "Error: Hook timed out in 10000ms.", "Hook timed out in 10000ms."]) {
    assert.equal(isTimeoutMessage(text), true, text);
  }
  for (const text of ["Error: expected promise to resolve in 15000ms", "", undefined]) assert.equal(isTimeoutMessage(text), false, String(text));
});

/*
FNXC:CI 2026-10-08-08:51:
Symptom verification for run 37720611351: four core files that failed only with fifteen-second timeouts were listed as ordinary unexpected failures.
*/
test("CLI: run 37720611351's load-only core timeouts fail the shard but render as load timeouts", () => {
  const coreDir = path.join(repoRoot, "packages", "core");
  const files = [
    "src/__tests__/schema-applier.test.ts",
    "src/__tests__/task-lane-cache-emitter-preservation.test.ts",
    "src/__tests__/task-symbol-resolution.test.ts",
    "src/__tests__/task-updated-lanes-emit-surfaces.test.ts",
  ];
  const fixtureDir = mkdtempSync(path.join(repoRoot, "scripts", "__tests__", ".windows-lane-fixture-"));
  try {
    const reportPath = path.join(fixtureDir, "core-1.json");
    const exitPath = path.join(fixtureDir, "core-1.exit");
    writeFileSync(reportPath, JSON.stringify(report(files.map((file) => [file, "failed", failedWith("Error: Test timed out in 15000ms.")]), coreDir)));
    writeFileSync(exitPath, "1\n");
    const env = { ...process.env };
    delete env.GITHUB_STEP_SUMMARY;
    const run = spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "check-windows-known-failing.mjs"), "--package", "@fusion/core", "--label", "core-1 (shard 1/2)", "--report", reportPath, "--exit-code", exitPath],
      { encoding: "utf8", env },
    );
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stdout, /### Windows @fusion\/core — core-1 \(shard 1\/2\): FAIL/);
    assert.ok(run.stdout.includes("Load timeouts"));
    for (const file of files) assert.ok(run.stdout.includes(`\`${file}\` (unexpected; 1 timeout)`), file);
    assert.ok(!run.stdout.includes("Unexpected failures:"));
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

/*
FNXC:CI 2026-10-08-13:12:
KB-062 symptom verification: the comparator refused --package @fusion/dashboard, @runfusion/fusion and scripts with a core/engine usage error, so those suites could not get a Windows lane signal.
*/
function runComparator(packageName, label, rows, dir, exitCode = "1\n") {
  const fixtureDir = mkdtempSync(path.join(repoRoot, "scripts", "__tests__", ".windows-lane-fixture-"));
  try {
    const reportPath = path.join(fixtureDir, "lane.json");
    const exitPath = path.join(fixtureDir, "lane.exit");
    writeFileSync(reportPath, JSON.stringify(report(rows, dir)));
    writeFileSync(exitPath, exitCode);
    const env = { ...process.env };
    delete env.GITHUB_STEP_SUMMARY;
    return spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "check-windows-known-failing.mjs"), "--package", packageName, "--label", label, "--report", reportPath, "--exit-code", exitPath],
      { encoding: "utf8", env },
    );
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

test("CLI: --package scripts fails on an unledgered node:test file", () => {
  const run = runComparator("scripts", "scripts", [["__tests__/zz-fixture.test.mjs", "failed"], ["__tests__/ok.test.mjs", "passed"]], path.join(repoRoot, "scripts"));
  assert.equal(run.status, 1, run.stderr);
  assert.ok(run.stdout.includes("Unexpected failures:"));
  assert.ok(run.stdout.includes("`__tests__/zz-fixture.test.mjs`"));
});

test("CLI: --package @fusion/dashboard fails on an unledgered file", () => {
  const run = runComparator("@fusion/dashboard", "dashboard", [["src/__tests__/x.test.ts", "failed"]], path.join(repoRoot, "packages", "dashboard"));
  assert.equal(run.status, 1, run.stderr);
  assert.ok(run.stdout.includes("`src/__tests__/x.test.ts`"));
});

test("CLI: --package @runfusion/fusion passes when only a ledgered CLI file fails", () => {
  const cliDir = path.join(repoRoot, "packages", "cli");
  const known = readKnownFailing().packages["@runfusion/fusion"] ?? [];
  if (known.length === 0) {
    const result = compareWindowsRun({ report: report([["src/__tests__/known.test.ts", "failed"]], cliDir), exitCode: 1, known: ["src/__tests__/known.test.ts"], packageDir: cliDir });
    assert.equal(result.ok, true);
    return;
  }
  const run = runComparator("@runfusion/fusion", "cli", [[known[0], "failed"], ["src/__tests__/ok.test.ts", "passed"]], cliDir);
  assert.equal(run.status, 0, run.stdout);
});

test("CLI: an unknown --package exits 2 and names every supported package", () => {
  const run = runComparator("@fusion/unknown", "x", [["src/a.test.ts", "failed"]], repoRoot);
  assert.equal(run.status, 2);
  for (const key of Object.keys(PACKAGE_DIRS)) assert.ok(run.stderr.includes(key), key);
});

test("the committed ledger names only existing files and its entry count equals its ceiling", () => {
  const ledger = readKnownFailing();
  assert.ok(Number.isInteger(ledger.ceiling) && ledger.ceiling > 0);
  let total = 0;
  for (const [packageName, files] of Object.entries(ledger.packages)) {
    const dir = Object.hasOwn(PACKAGE_DIRS, packageName) ? PACKAGE_DIRS[packageName] : undefined;
    assert.ok(dir, `unknown package ${packageName}`);
    // FNXC:CI 2026-10-08-13:12: KB-062 — Vitest packages key entries as src/**.test.ts(x); the scripts node:test suite keys them as __tests__/<name>.test.mjs relative to scripts/.
    const spelledForPackage = packageName === "scripts"
      ? (segments, file) => segments[0] === "__tests__" && file.endsWith(".test.mjs")
      : (segments, file) => segments[0] === "src" && (file.endsWith(".test.ts") || file.endsWith(".test.tsx"));
    assert.deepEqual(files, [...new Set(files)].sort(), `${packageName} entries must be sorted and unique`);
    for (const file of files) {
      // FNXC:CI 2026-10-07-23:34: entries use the comparator's one spelling (package-relative, forward slashes), so a backslash or ./ form can never silently miss its report row.
      const segments = file.split("/");
      assert.ok(
        spelledForPackage(segments, file) && !file.includes("\\") && segments.every((segment) => segment !== "" && segment !== "." && segment !== ".."),
        `${packageName}: ${file} must be a package-relative forward-slash path`,
      );
      assert.ok(existsSync(path.join(repoRoot, dir, file)), `${packageName}: ${file} does not exist`);
    }
    total += files.length;
  }
  /*
  FNXC:CI 2026-10-08-08:29:
  KB-053: after a removal the ceiling must equal the entry count, so a shrink can never leave headroom that would let the ledger silently regrow.
  */
  assert.equal(
    total,
    ledger.ceiling,
    `ledger has ${total} entries but its ceiling is ${ledger.ceiling}; lower the ceiling to the entry count when removing entries (the ledger may only shrink)`,
  );
  assert.equal(JSON.parse(readFileSync(path.join(repoRoot, "scripts/lib/windows-known-failing-tests.json"), "utf8")).ceiling, ledger.ceiling);
});
