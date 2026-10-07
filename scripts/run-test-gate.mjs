#!/usr/bin/env node
/*
FNXC:MergeGateWindows 2026-10-07-18:03:
`pnpm test:gate` must run the same fail-closed gate on every platform and must not depend on the machine's npm script-shell.
The old composition was a POSIX `sh -c '... & engine_pid=$!; ... wait ...'` program; cmd.exe split it at `&`, so on Windows only engine-core ran, pg-gate/unit-gate/ci-shape never started, and the failures read as stray "not recognized" lines.
Order and semantics are unchanged: every static validator runs and must pass first, then engine-core, pg-gate and unit-gate run concurrently and ALL are awaited, then ci-shape runs only after all three passed.
Lanes launch without a shell through the shared pnpm resolver, inherit the caller's environment, and any failed lane makes the gate exit nonzero.
*/

import { spawn } from "node:child_process";

import { isEntryPoint } from "./lib/is-entry-point.mjs";
import { describeSpawnFailure, resolveCommandInvocation } from "./lib/pnpm-invocation.mjs";
import { readStaticGateChecks, repoRoot, runStaticGateChecks } from "./run-static-gate-checks.mjs";

/** Test lanes that run concurrently once every static validator has passed. */
export const CONCURRENT_GATE_LANES = Object.freeze([
  Object.freeze({ name: "engine-core", args: Object.freeze(["--filter", "@fusion/engine", "test:core"]) }),
  Object.freeze({ name: "pg-gate", args: Object.freeze(["--filter", "@fusion/core", "test:pg-gate"]) }),
  Object.freeze({ name: "unit-gate", args: Object.freeze(["--filter", "@fusion/core", "test:unit-gate"]) }),
]);

/** Lane that runs only after every concurrent lane succeeded. */
export const FINAL_GATE_LANE = Object.freeze({ name: "ci-shape", args: Object.freeze(["--filter", "@runfusion/fusion", "test:ci-shape"]) });

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Run one pnpm lane and resolve to its outcome. A launch error is a failed lane, never a pass.
 *
 * @param {{ name: string, args: readonly string[] }} lane
 * @param {{ spawnImpl?: typeof spawn, cwd?: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, live?: Set<import("node:child_process").ChildProcess> }} [options]
 * @returns {Promise<{ name: string, code: number | null, signal: NodeJS.Signals | null, error?: Error }>}
 */
export function runGateLane(lane, { spawnImpl = spawn, cwd = repoRoot, env = process.env, platform = process.platform, live = new Set() } = {}) {
  return new Promise((resolveLane) => {
    const invocation = resolveCommandInvocation("pnpm", [...lane.args], { platform, env });
    let child;
    try {
      child = spawnImpl(invocation.command, invocation.args, {
        cwd,
        env,
        shell: false,
        stdio: "inherit",
        ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (error) {
      resolveLane({ name: lane.name, code: null, signal: null, error });
      return;
    }
    live.add(child);
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      live.delete(child);
      resolveLane(result);
    };
    child.once("error", (error) => settle({ name: lane.name, code: null, signal: null, error }));
    child.once("close", (code, signal) => settle({ name: lane.name, code, signal }));
  });
}

function laneFailed(result) {
  return Boolean(result.error) || result.code !== 0;
}

function describeLane(result) {
  return describeSpawnFailure({ status: result.code, signal: result.signal, error: result.error });
}

/**
 * Run the complete merge gate. Rejects when any static validator or lane fails.
 *
 * @param {{
 *   runStatic?: () => Promise<unknown>,
 *   spawnImpl?: typeof spawn,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform,
 *   log?: (message: string) => void,
 *   errorLog?: (message: string) => void,
 * }} [options]
 */
export async function runTestGate({
  runStatic = () => runStaticGateChecks(readStaticGateChecks()),
  spawnImpl = spawn,
  cwd = repoRoot,
  env = process.env,
  platform = process.platform,
  log = console.log,
  errorLog = console.error,
} = {}) {
  await runStatic();

  const live = new Set();
  const forwarders = FORWARDED_SIGNALS.map((signal) => {
    const handler = () => {
      for (const child of live) {
        try {
          child.kill(signal);
        } catch {
          /* already exited */
        }
      }
    };
    process.on(signal, handler);
    return [signal, handler];
  });
  const laneOptions = { spawnImpl, cwd, env, platform, live };

  try {
    const results = await Promise.all(CONCURRENT_GATE_LANES.map((lane) => runGateLane(lane, laneOptions)));
    const failures = results.filter(laneFailed);
    for (const failure of failures) errorLog(`[test-gate] lane failed: ${failure.name} (${describeLane(failure)})`);
    if (failures.length > 0) {
      throw new Error(`${failures.length} gate lane${failures.length === 1 ? "" : "s"} failed; ${FINAL_GATE_LANE.name} not run`);
    }

    const final = await runGateLane(FINAL_GATE_LANE, laneOptions);
    if (laneFailed(final)) {
      errorLog(`[test-gate] lane failed: ${final.name} (${describeLane(final)})`);
      throw new Error(`gate lane ${final.name} failed`);
    }
    log(`[test-gate] ${CONCURRENT_GATE_LANES.length + 1} lanes passed`);
    return [...results, final];
  } finally {
    for (const [signal, handler] of forwarders) process.removeListener(signal, handler);
  }
}

if (isEntryPoint(import.meta.url)) {
  try {
    await runTestGate();
  } catch (error) {
    console.error(`[test-gate] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
