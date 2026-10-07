/* Vendored ACP client from fusion-plugin-acp-runtime — see ./VENDORED.md (FNXC:GrokAcp 2026-07-11-16:00). */
// port-4040-allowlist: this file documents the reserved dashboard port in kill-guard comments only; no kill targets it.
// Subprocess lifecycle for the ACP runtime.
//
// Mirrors the hardening conventions in
// `plugins/fusion-plugin-droid-runtime/src/process-manager.ts`: a self-cleaning
// process registry, SIGKILL teardown scoped to agent subprocesses only (never
// the dashboard/port-4040 — KTD4), bounded stderr capture with secret redaction
// (Risk S8), and a high inactivity ceiling (the engine's StuckTaskDetector is
// the authoritative aborter — KTD4).
//
// The ACP agent is UNTRUSTED. The spawn env is built from an explicit allow-list
// (KTD6b), never inherited `process.env`, so secret-bearing vars are not handed
// to the agent.

import { spawn, type ChildProcess } from "node:child_process";
import { killProcessTree, redactSecrets, resolveShellFreeLaunch, withPlatformBaseEnvKeys } from "@fusion/core";

function debugLog(message: string): void {
  if (process.env.PI_ACP_DEBUG !== "1" && process.env.FUSION_GROK_ACP_DEBUG !== "1") return;
  console.error(`[grok-acp] ${message}`);
}

/*
FNXC:ProcessLifecycle 2026-07-16-07:00:
Vitest resets the Grok plugin module graph while retaining the worker's `process`.
Keep the ACP child registry on `process` so the one guarded exit listener also
reaps children registered by later module evaluations; adding one listener per
evaluation causes MaxListenersExceededWarning in the dashboard backfill lane.
*/
const ACTIVE_PROCESSES_KEY = Symbol.for("fusion.plugin.grok-runtime.activeProcesses");
const processWithActiveProcesses = process as typeof process & {
  [key: symbol]: Set<ChildProcess> | undefined;
};

/** Registry of active agent subprocesses for teardown. Self-cleans on exit. */
const activeProcesses =
  processWithActiveProcesses[ACTIVE_PROCESSES_KEY] ??
  (processWithActiveProcesses[ACTIVE_PROCESSES_KEY] = new Set<ChildProcess>());

/**
 * Register a subprocess in the agent process registry.
 * Auto-removed from the registry when it exits.
 */
export function registerProcess(child: ChildProcess): void {
  activeProcesses.add(child);
  child.on("exit", () => activeProcesses.delete(child));
}

/** Remove a subprocess from the registry (idempotent). */
export function unregisterProcess(child: ChildProcess): void {
  activeProcesses.delete(child);
}

/** Number of registered (presumed-live) agent subprocesses — for diagnostics/tests. */
export function activeProcessCount(): number {
  return activeProcesses.size;
}

/**
 * Force-kill a subprocess and every process it started. No-op once it has exited.
 *
 * FNXC:WindowsProcessLaunch 2026-10-07-18:02: Windows `child.kill` ends only the direct child, so the agent's own subprocesses outlived the session; core's `killProcessTree` uses `taskkill /T /F` there and SIGKILL elsewhere.
 */
export function forceKill(child: ChildProcess): void {
  killProcessTree(child);
}

/**
 * Force-kill every registered agent subprocess and clear the registry.
 *
 * Scoped to agent subprocesses tracked here only — never the dashboard / port
 * 4040 / any other process (KTD4 / kill-guard conventions). Safe to call
 * repeatedly; no-ops on already-dead processes.
 */
export function killAllProcesses(): void {
  for (const child of activeProcesses) {
    forceKill(child);
  }
  activeProcesses.clear();
}

/*
FNXC:ProcessLifecycle 2026-07-18-07:40:
Install the process.exit reaper here (not only from index.ts) so lifecycle
ownership lives with the registry module. Full-suite shards previously timed
out process-lifecycle.test while repeatedly importing the full plugin graph
just to exercise Symbol.for; re-importing this module is enough to prove the
bound and still runs when the plugin entry loads killAllProcesses.
*/
const PROCESS_EXIT_HOOK_KEY = Symbol.for("fusion.plugin.grok-runtime.exitCleanup");
const processWithExitHook = process as typeof process & { [key: symbol]: boolean | undefined };
if (!processWithExitHook[PROCESS_EXIT_HOOK_KEY]) {
  process.on("exit", killAllProcesses);
  processWithExitHook[PROCESS_EXIT_HOOK_KEY] = true;
}

export class MissingAcpEnvError extends Error {
  readonly code = "ACP_MISSING_ENV";
  constructor(readonly missingKeys: string[]) {
    super(`Missing required ACP environment variable(s): ${missingKeys.join(", ")}`);
    this.name = "MissingAcpEnvError";
  }
}

export interface BuildSpawnEnvOptions {
  required?: string[];
  sourceEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/**
 * Build the subprocess environment from an explicit allow-list (KTD6b).
 *
 * Returns ONLY allow-listed vars copied from `process.env`. The full env is
 * never inherited — the agent is untrusted and must not receive secret-bearing
 * vars. Returns an empty env by default (empty allow-list).
 */
export function buildSpawnEnv(allowList: string[], options: BuildSpawnEnvOptions = {}): NodeJS.ProcessEnv {
  /*
  FNXC:ACP-RouteB 2026-06-14-19:52:
  Claude bridge subprocesses may receive HOME so the real `claude` can read ~/.claude auth and PATH so the bridge can locate sub-executables. Do not forward ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or inherited process.env because the bridge is an untrusted external process.
  */
  const sourceEnv = options.sourceEnv ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  /*
  FNXC:WindowsProcessLaunch 2026-10-07-18:02:
  POSIX allow-lists (HOME, TMPDIR, XDG_*) mean nothing on Windows, where an agent without SystemRoot, PATHEXT, USERPROFILE, APPDATA, LOCALAPPDATA and TEMP cannot start or find its config and auth.
  The platform's non-secret base keys are always added; credentials still cross only when explicitly allow-listed.
  */
  for (const key of withPlatformBaseEnvKeys(allowList, options.platform)) {
    const value = sourceEnv[key];
    if (typeof value === "string") env[key] = value;
  }
  const missing = (options.required ?? []).filter((key) => typeof env[key] !== "string");
  if (missing.length > 0) {
    throw new MissingAcpEnvError(missing);
  }
  return env;
}

export interface SpawnAgentOptions {
  binaryPath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Spawn the ACP agent subprocess with piped stdio.
 *
 * Registers the child on spawn and unregisters it on exit. The caller wraps
 * stdin/stdout into a web stream for `ndJsonStream`.
 */
export function spawnAgent(options: SpawnAgentOptions): ChildProcess {
  /*
  FNXC:WindowsProcessLaunch 2026-10-07-18:02:
  Node refuses `.cmd` bridges and npm shims without a shell (EINVAL) and resolves bare names to `.exe` only, so every Windows ACP session failed before the handshake while the shell-based probe reported "available".
  Resolve through core's shell-free launch seam against the child's own PATH, exactly as the probe does, so the untrusted agent's argv never reaches cmd.exe.
  */
  const launch = resolveShellFreeLaunch(options.binaryPath, options.args, { env: options.env });
  const child = spawn(launch.command, launch.args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
  });
  registerProcess(child);
  debugLog(`spawnAgent: pid=${child.pid} binary=${options.binaryPath}`);
  return child;
}

// --- stderr capture + secret redaction (Risk S8) --------------------------

/** Maximum stderr bytes retained; older output is dropped to bound memory. */
const STDERR_BUFFER_CEILING = 64 * 1024;

// Secret redaction (Risk S8) lives in @fusion/core so PTY/process owners share
// one implementation; re-exported here to preserve this module's public surface.
export { redactSecrets };

/**
 * Accumulate stderr into a bounded, secret-redacted buffer.
 * Returns a getter for the current (redacted) buffer contents.
 */
export function captureStderr(child: ChildProcess): () => string {
  // FIX 5: redacting each chunk in isolation leaks a secret that straddles a
  // chunk boundary (the token is split across two `data` events so neither half
  // matches a pattern). Accumulate the RAW bytes into a bounded buffer first,
  // then redact across the whole (bounded) buffer after each append so a
  // boundary-spanning secret is caught. The buffer stays bounded by the existing
  // ceiling; the returned getter always reports the redacted view.
  let raw = "";
  child.stderr?.on("data", (data: Buffer) => {
    raw += data.toString();
    if (raw.length > STDERR_BUFFER_CEILING) {
      raw = raw.slice(raw.length - STDERR_BUFFER_CEILING);
    }
  });
  return () => redactSecrets(raw);
}
