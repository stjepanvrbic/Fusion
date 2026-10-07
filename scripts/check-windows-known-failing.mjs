#!/usr/bin/env node
/*
FNXC:CI 2026-10-07-21:10:
The non-blocking Windows Full Suite lane runs the full core and engine suites, where some files still fail on Windows only. A permanently red run hides every new regression, so this comparator reads the lane's Vitest JSON report and fails only on a failure outside scripts/lib/windows-known-failing-tests.json, a missing or empty report, or a nonzero exit that no failing file explains.
Known files that now pass are reported as warnings so the ledger shrinks. The ledger has a ceiling and may never grow; a new Windows-only failure is fixed or quarantined under the normal rules, not added here.
*/
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER_PATH = path.join(repoRoot, "scripts", "lib", "windows-known-failing-tests.json");
const PACKAGE_DIRS = { "@fusion/core": "packages/core", "@fusion/engine": "packages/engine" };

export function readKnownFailing(ledgerPath = LEDGER_PATH) {
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  return { ceiling: ledger.ceiling, packages: ledger.packages ?? {} };
}

function toPackageRelative(packageDir, file) {
  return path.relative(packageDir, file).split(path.sep).join("/");
}

/** Compares one lane's Vitest JSON report with that package's known Windows failures. */
export function compareWindowsRun({ report, exitCode, known, packageDir }) {
  const results = Array.isArray(report?.testResults) ? report.testResults : [];
  if (results.length === 0) {
    return { ok: false, reason: "the lane produced no test results", unexpected: [], nowPassing: [], failing: [] };
  }
  const knownSet = new Set(known);
  const failing = [...new Set(results.filter((r) => r.status === "failed").map((r) => toPackageRelative(packageDir, r.name)))].sort();
  const passing = new Set(results.filter((r) => r.status === "passed").map((r) => toPackageRelative(packageDir, r.name)));
  const unexpected = failing.filter((file) => !knownSet.has(file));
  const nowPassing = known.filter((file) => passing.has(file) && !failing.includes(file));
  if (unexpected.length > 0) {
    return { ok: false, reason: `${unexpected.length} file(s) failed outside the known Windows list`, unexpected, nowPassing, failing };
  }
  if (exitCode !== 0 && failing.length === 0) {
    return { ok: false, reason: `the lane exited with exit code ${exitCode} but no test file failed`, unexpected, nowPassing, failing };
  }
  return { ok: true, reason: "only known Windows failures failed", unexpected, nowPassing, failing };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, "")] = argv[i + 1];
  return args;
}

function main() {
  const { package: packageName, report: reportPath, "exit-code": exitCodePath } = parseArgs(process.argv.slice(2));
  const relativeDir = PACKAGE_DIRS[packageName];
  if (!relativeDir || !reportPath || !exitCodePath) {
    console.error("usage: check-windows-known-failing.mjs --package <@fusion/core|@fusion/engine> --report <json> --exit-code <file>");
    return 2;
  }
  const packageDir = path.join(repoRoot, relativeDir);
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : undefined;
  const exitCode = existsSync(exitCodePath) ? Number.parseInt(readFileSync(exitCodePath, "utf8").trim(), 10) : Number.NaN;
  const known = readKnownFailing().packages[packageName] ?? [];
  const result = compareWindowsRun({ report, exitCode: Number.isNaN(exitCode) ? 1 : exitCode, known, packageDir });

  const lines = [
    `### Windows ${packageName}: ${result.ok ? "pass" : "FAIL"}`,
    "",
    `${result.reason}. Failing files: ${result.failing.length}; known Windows failures: ${known.length}.`,
  ];
  if (result.unexpected.length > 0) lines.push("", "Unexpected failures:", ...result.unexpected.map((file) => `- \`${file}\``));
  if (result.nowPassing.length > 0) lines.push("", "Known failures that now pass (remove them from the ledger and lower its ceiling):", ...result.nowPassing.map((file) => `- \`${file}\``));
  const summary = `${lines.join("\n")}\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  for (const file of result.nowPassing) console.log(`::warning title=Windows known failure now passes::${packageName} ${file}`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exitCode = main();
