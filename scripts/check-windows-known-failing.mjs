#!/usr/bin/env node
/*
FNXC:CI 2026-10-07-21:10:
The non-blocking Windows Full Suite lane runs the full core and engine suites, where some files still fail on Windows only. A permanently red run hides every new regression, so this comparator reads the lane's Vitest JSON report and fails only on a failure outside scripts/lib/windows-known-failing-tests.json, a missing or empty report, or a nonzero exit that no failing file explains.
Known files that now pass are reported as warnings so the ledger shrinks. The ledger has a ceiling and may never grow; a new Windows-only failure is fixed or quarantined under the normal rules, not added here.

FNXC:CI 2026-10-08-08:51:
Run 37720611351 turned the lane red with load-only fifteen-second timeouts that looked exactly like new Windows bugs. Failing files are now classified: a file is timeout-only when its report evidence has at least one Vitest "Test/Hook timed out in Nms" message and no other failure message. A failed file with no captured message (for example a nested beforeAll failure, which the JSON reporter does not serialize) counts as a real failure.
Timeout-only files render in a separate informational "Load timeouts" summary section. Classification never changes the verdict or the ledger: an unexpected timeout-only file still fails the shard, and a timeout is not grounds for a ledger entry.

FNXC:CI 2026-10-08-13:12:
KB-062 extends the lane to five suites: core, engine, dashboard (dashboard-api project), CLI (@runfusion/fusion) and the scripts/__tests__ node:test suite, whose report comes from scripts/lib/node-test-json-reporter.mjs.
PACKAGE_DIRS is exported so the ledger test validates keys against the same map, and the usage message lists every key. A package with no ledger key compares against an empty known list.
*/
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER_PATH = path.join(repoRoot, "scripts", "lib", "windows-known-failing-tests.json");
export const PACKAGE_DIRS = {
  "@fusion/core": "packages/core",
  "@fusion/engine": "packages/engine",
  "@fusion/dashboard": "packages/dashboard",
  "@runfusion/fusion": "packages/cli",
  scripts: "scripts",
};
// Matches the first line of @vitest/runner's timeout error in stack form ("Error: Test timed out in 15000ms.") or message form.
const TIMEOUT_FIRST_LINE = /^(?:[A-Za-z]*Error:\s*)?(?:Test|Hook) timed out in \d+ms\b/;

export function readKnownFailing(ledgerPath = LEDGER_PATH) {
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  return { ceiling: ledger.ceiling, packages: ledger.packages ?? {} };
}

function toPackageRelative(packageDir, file) {
  return path.relative(packageDir, file).split(path.sep).join("/");
}

/** True when the first line of a Vitest failure message is a test or hook timeout. */
export function isTimeoutMessage(text) {
  if (typeof text !== "string") return false;
  const firstLine = text.trimStart().split(/\r?\n/, 1)[0] ?? "";
  return TIMEOUT_FIRST_LINE.test(firstLine);
}

function failureMessages(fileResult) {
  const messages = [];
  for (const assertion of Array.isArray(fileResult?.assertionResults) ? fileResult.assertionResults : []) {
    if (assertion?.status !== "failed") continue;
    for (const message of Array.isArray(assertion.failureMessages) ? assertion.failureMessages : []) messages.push(String(message ?? ""));
  }
  if (typeof fileResult?.message === "string" && fileResult.message.trim() !== "") messages.push(fileResult.message);
  return messages;
}

/**
 * Classifies one failed Vitest JSON file result. Conservative: timeout-only requires at least one timeout message and no
 * non-timeout message, so a failure with no captured evidence is never mistaken for runner load.
 */
export function classifyLoadTimeout(fileResult) {
  const messages = failureMessages(fileResult);
  const timeouts = messages.filter(isTimeoutMessage).length;
  return { timeoutOnly: messages.length > 0 && timeouts === messages.length, timeouts };
}

/** Compares one lane's Vitest JSON report with that package's known Windows failures. */
export function compareWindowsRun({ report, exitCode, known, packageDir }) {
  const results = Array.isArray(report?.testResults) ? report.testResults : [];
  if (results.length === 0) {
    return { ok: false, reason: "the lane produced no test results", unexpected: [], unexpectedReal: [], nowPassing: [], failing: [], loadTimeouts: [] };
  }
  const knownSet = new Set(known);
  const failedRows = results.filter((r) => r.status === "failed");
  const failing = [...new Set(failedRows.map((r) => toPackageRelative(packageDir, r.name)))].sort();
  const passing = new Set(results.filter((r) => r.status === "passed").map((r) => toPackageRelative(packageDir, r.name)));
  const unexpected = failing.filter((file) => !knownSet.has(file));
  const nowPassing = known.filter((file) => passing.has(file) && !failing.includes(file));

  // A file reported in several rows is timeout-only only when every one of its failed rows is.
  const classified = new Map();
  for (const row of failedRows) {
    const file = toPackageRelative(packageDir, row.name);
    const { timeoutOnly, timeouts } = classifyLoadTimeout(row);
    const prior = classified.get(file);
    classified.set(file, prior ? { timeoutOnly: prior.timeoutOnly && timeoutOnly, timeouts: prior.timeouts + timeouts } : { timeoutOnly, timeouts });
  }
  const loadTimeouts = failing
    .filter((file) => classified.get(file)?.timeoutOnly)
    .map((file) => ({ file, known: knownSet.has(file), timeouts: classified.get(file).timeouts }));
  const timeoutOnlySet = new Set(loadTimeouts.map((entry) => entry.file));
  const unexpectedReal = unexpected.filter((file) => !timeoutOnlySet.has(file));
  const base = { unexpected, unexpectedReal, nowPassing, failing, loadTimeouts };

  if (unexpected.length > 0) {
    const unexpectedTimeouts = unexpected.length - unexpectedReal.length;
    let reason = `${unexpected.length} file(s) failed outside the known Windows list`;
    if (unexpectedTimeouts === unexpected.length) reason += "; all are timeout-only (runner load suspected)";
    else if (unexpectedTimeouts > 0) reason += `; ${unexpectedTimeouts} of them are timeout-only`;
    return { ok: false, reason, ...base };
  }
  if (exitCode !== 0 && failing.length === 0) {
    return { ok: false, reason: `the lane exited with exit code ${exitCode} but no test file failed`, ...base };
  }
  return { ok: true, reason: "only known Windows failures failed", ...base };
}

/** Renders the job-summary markdown for one compared shard. Pure; main() writes it to stdout and GITHUB_STEP_SUMMARY. */
export function renderWindowsSummary({ packageName, label, result, knownCount }) {
  const lines = [
    `### Windows ${packageName}${label ? ` — ${label}` : ""}: ${result.ok ? "pass" : "FAIL"}`,
    "",
    `${result.reason}. Failing files: ${result.failing.length}; known Windows failures: ${knownCount}.`,
  ];
  const unexpectedReal = result.unexpectedReal ?? result.unexpected;
  const loadTimeouts = result.loadTimeouts ?? [];
  if (unexpectedReal.length > 0) lines.push("", "Unexpected failures:", ...unexpectedReal.map((file) => `- \`${file}\``));
  if (loadTimeouts.length > 0) {
    lines.push(
      "",
      "Load timeouts (timeout-only failures; informational — the verdict above is unchanged):",
      ...loadTimeouts.map(({ file, known, timeouts }) => `- \`${file}\` (${known ? "known" : "unexpected"}; ${timeouts} timeout${timeouts === 1 ? "" : "s"})`),
    );
  }
  if (result.nowPassing.length > 0) lines.push("", "Known failures that now pass (remove them from the ledger and lower its ceiling):", ...result.nowPassing.map((file) => `- \`${file}\``));
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, "")] = argv[i + 1];
  return args;
}

function main() {
  const { package: packageName, label, report: reportPath, "exit-code": exitCodePath } = parseArgs(process.argv.slice(2));
  const relativeDir = Object.hasOwn(PACKAGE_DIRS, packageName ?? "") ? PACKAGE_DIRS[packageName] : undefined;
  if (!relativeDir || !reportPath || !exitCodePath) {
    console.error(`usage: check-windows-known-failing.mjs --package <${Object.keys(PACKAGE_DIRS).join("|")}> [--label <text>] --report <json> --exit-code <file>`);
    return 2;
  }
  const packageDir = path.join(repoRoot, relativeDir);
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : undefined;
  const exitCode = existsSync(exitCodePath) ? Number.parseInt(readFileSync(exitCodePath, "utf8").trim(), 10) : Number.NaN;
  const known = readKnownFailing().packages[packageName] ?? [];
  const result = compareWindowsRun({ report, exitCode: Number.isNaN(exitCode) ? 1 : exitCode, known, packageDir });

  const summary = renderWindowsSummary({ packageName, label, result, knownCount: known.length });
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  for (const file of result.nowPassing) console.log(`::warning title=Windows known failure now passes::${packageName} ${file}`);
  for (const { file, known: isKnown } of result.loadTimeouts) {
    if (!isKnown) console.log(`::notice title=Windows load timeout::${packageName} ${file}`);
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exitCode = main();
