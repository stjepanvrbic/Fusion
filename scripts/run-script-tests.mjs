#!/usr/bin/env node

import { globSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { isEntryPoint } from "./lib/is-entry-point.mjs";

/*
FNXC:TestInfrastructure 2026-06-21-10:00:
Script-test verification must honor forwarded file arguments so targeted checks stay fast inside Fusion tasks.
The old package script always expanded scripts/__tests__/*.test.mjs before forwarded args, turning `pnpm test:scripts -- scripts/__tests__/x.test.mjs` into the full script suite and making task completion look stalled.

FNXC:CI 2026-10-08-10:42:
KB-062's Windows Full Suite scripts lane needs a machine-readable report for scripts/check-windows-known-failing.mjs, so `--test-reporter` and `--test-reporter-destination` (both `--flag=value` and `--flag value` forms) are forwarded to `node --test` ahead of the files, in their original order (node pairs reporters and destinations by position).
Every other forwarded argument keeps its prior meaning: a test file resolved against the repo root, with no files meaning the sorted scripts/__tests__/*.test.mjs glob.
The spawn lives in main() behind the shared win32-safe isEntryPoint guard so tests can import splitForwardedArgs without running the suite.
*/

const REPORTER_FLAGS = new Set(["--test-reporter", "--test-reporter-destination"]);

/**
 * Splits forwarded CLI arguments into node:test reporter flags and test-file arguments. Drops `--`.
 * @param {string[]} argv
 * @returns {{ reporterArgs: string[], files: string[] }}
 */
export function splitForwardedArgs(argv) {
  const reporterArgs = [];
  const files = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    const flag = arg.split("=", 1)[0];
    if (REPORTER_FLAGS.has(flag)) {
      reporterArgs.push(arg);
      if (!arg.includes("=") && i + 1 < argv.length) reporterArgs.push(argv[(i += 1)]);
      continue;
    }
    files.push(arg);
  }
  return { reporterArgs, files };
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function main() {
  const { reporterArgs, files } = splitForwardedArgs(process.argv.slice(2));
  const testFiles = files.length > 0
    ? files.map((file) => resolve(repoRoot, file))
    : globSync("scripts/__tests__/*.test.mjs", { cwd: repoRoot }).sort().map((file) => resolve(repoRoot, file));

  if (testFiles.length === 0) {
    console.error("[run-script-tests] no script test files matched");
    process.exit(1);
  }

  const child = spawn(process.execPath, ["--test", ...reporterArgs, ...testFiles], {
    stdio: "inherit",
    cwd: repoRoot,
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });

  child.on("error", (error) => {
    console.error(error);
    process.exit(1);
  });
}

if (isEntryPoint(import.meta.url)) main();
