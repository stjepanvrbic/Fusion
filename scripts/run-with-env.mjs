#!/usr/bin/env node
/**
 * run-with-env.mjs
 *
 * Run one command with extra environment variables, without a shell, identically on Windows and POSIX.
 *
 * Usage:  node scripts/run-with-env.mjs NAME=value [NAME=value ...] -- command [args...]
 * e.g.:   node scripts/run-with-env.mjs FUSION_TEST_CONCURRENCY=1 -- pnpm test:full
 */

/*
FNXC:WindowsTestScripts 2026-10-08-05:03:
npm/pnpm scripts run under cmd.exe on Windows, which rejects the POSIX `VAR=1 command` prefix, so root test:serial/test:fast and the dashboard test:app/test:api/test:deep/test:build scripts could not start there.
Env-setting scripts route through this shell-free wrapper instead of cross-env: it needs no new dependency or lockfile change, and it never re-spawns through a second shell (cross-env@7 uses `shell: true`), so glob arguments reach the tool verbatim.
The arguments are fixed, trusted package.json script text, which is the class of input resolveCommandInvocation permits to go through its quoted cmd.exe path for `.cmd` shims.
*/

import { spawn } from "node:child_process";

import { isEntryPoint } from "./lib/is-entry-point.mjs";
import { describeSpawnFailure, resolveCommandInvocation } from "./lib/pnpm-invocation.mjs";

export const USAGE = "usage: node scripts/run-with-env.mjs NAME=value [NAME=value ...] -- command [args...]";
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

function usageError(reason) {
  return new Error(`${reason}\n${USAGE}`);
}

/**
 * Parse `NAME=value ... -- command args...`.
 * Values split on the first `=`, a later duplicate key wins, and everything after the first `--` passes through verbatim.
 *
 * @param {string[]} argv
 * @returns {{ assignments: Record<string, string>, command: string, args: string[] }}
 */
export function parseRunWithEnvArgs(argv) {
  const separator = argv.indexOf("--");
  if (separator === -1) throw usageError("missing `--` before the command");
  const pairs = argv.slice(0, separator);
  if (pairs.length === 0) throw usageError("at least one NAME=value assignment is required");
  const assignments = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    const key = eq === -1 ? pair : pair.slice(0, eq);
    if (eq === -1 || !KEY_PATTERN.test(key)) throw usageError(`invalid assignment: ${JSON.stringify(pair)}`);
    assignments[key] = pair.slice(eq + 1);
  }
  const [command, ...args] = argv.slice(separator + 1);
  if (!command) throw usageError("missing command after `--`");
  return { assignments, command, args };
}

/**
 * Spawn the parsed command with the merged env and mirror its exit status or terminating signal.
 *
 * @param {{
 *   argv: string[],
 *   env?: NodeJS.ProcessEnv,
 *   spawnChild?: typeof spawn,
 *   proc?: Pick<NodeJS.Process, "on" | "removeListener" | "exit" | "kill" | "pid">,
 *   resolve?: typeof resolveCommandInvocation,
 *   errorLog?: (message: string) => void,
 * }} options
 * @returns {import("node:child_process").ChildProcess | null}
 */
export function runWithEnv({ argv, env = process.env, spawnChild = spawn, proc = process, resolve = resolveCommandInvocation, errorLog = console.error }) {
  let parsed;
  try {
    parsed = parseRunWithEnvArgs(argv);
  } catch (err) {
    errorLog(`[run-with-env] ${err.message}`);
    proc.exit(2);
    return null;
  }

  const mergedEnv = { ...env, ...parsed.assignments };
  // The Windows PATH/PATHEXT lookup must see the child's env, not only the parent's.
  const invocation = resolve(parsed.command, parsed.args, { env: mergedEnv });

  let child;
  try {
    child = spawnChild(invocation.command, invocation.args, {
      stdio: "inherit",
      shell: false,
      env: mergedEnv,
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
  } catch (err) {
    errorLog(`[run-with-env] failed to spawn ${parsed.command}: ${err?.message ?? err}`);
    proc.exit(1);
    return null;
  }

  let settled = false;
  const handlers = FORWARDED_SIGNALS.map((signal) => {
    const handler = () => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill(signal); } catch { /* already gone */ }
      }
    };
    proc.on(signal, handler);
    return [signal, handler];
  });
  const detach = () => {
    for (const [signal, handler] of handlers) proc.removeListener(signal, handler);
  };

  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;
    // Detach first so a re-raised signal terminates this process instead of reaching our forwarder.
    detach();
    if (signal) {
      proc.kill(proc.pid, signal);
      return;
    }
    proc.exit(code ?? 1);
  });
  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    detach();
    errorLog(`[run-with-env] failed to spawn ${parsed.command}: ${describeSpawnFailure({ status: null, error: err })}`);
    proc.exit(1);
  });
  return child;
}

if (isEntryPoint(import.meta.url)) {
  runWithEnv({ argv: process.argv.slice(2) });
}
