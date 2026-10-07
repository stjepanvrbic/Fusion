import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { join } from "node:path";
import { createLogger } from "./logger.js";

const log = createLogger("process-supervisor");

/*
FNXC:SystemPanel 2026-07-12-10:40:
Exit code contract for operator-requested in-place restarts (dashboard System
panel "Restart"/"Rebuild & restart"). A supervised fusion process exits with
this code to signal "respawn me immediately"; supervisors (`fn dashboard
--supervise`'s runDashboardSupervised loop and scripts/dev-with-memory.mjs,
which hardcodes 86 because plain .mjs cannot import TS) treat it as an
intentional restart — no crash-backoff, no restart-budget consumption. Any
other non-zero exit remains a crash. Keep the literal in sync with
scripts/dev-with-memory.mjs.
*/
export const FUSION_RESTART_EXIT_CODE = 86;

/* FNXC:ProjectPartitionMerge 2026-07-20-12:00: A classified unique-constraint startup failure is deterministic, so supervised dashboard boot must stop once rather than consume the crash-restart budget. */
export const FUSION_NON_RETRYABLE_EXIT_CODE = 87;

const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_MAX_LIFETIME_MS = 600_000;
const MAX_KILL_WAIT_MS = 1_000;
const DEFAULT_STDIO_RELEASE_GRACE_MS = 1_000;
const TREE_KILL_SYNC_TIMEOUT_MS = 5_000;

/*
FNXC:ProcessLifecycle 2026-10-07-18:00:
A killed supervised command must not leave descendants alive, and its caller's wait must stay bounded on every platform.
Windows has no process groups and `shell: true` makes cmd.exe the direct child, so `child.kill` reached only cmd.exe while the real command kept running and held the stdout/stderr pipes, which kept `close` from ever firing.
On win32 the tree is killed with `taskkill /T /F` (console processes ignore the non-forced close request, and Node's own win32 kill is already forced), and only while the root is still alive, because a dead root's pid can be reused by an unrelated process.
*/
export interface ProcessTreeKillLauncher {
  spawn: typeof spawn;
  spawnSync: typeof spawnSync;
}

// Resolved at call time so a partial `node:child_process` test mock cannot break this module at import.
let treeKillLauncher: ProcessTreeKillLauncher | null = null;

function currentTreeKillLauncher(): ProcessTreeKillLauncher {
  return treeKillLauncher ?? { spawn, spawnSync };
}

function taskkillExecutable(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  return systemRoot ? join(systemRoot, "System32", "taskkill.exe") : "taskkill";
}

function windowsTreeKillArgs(pids: readonly number[]): string[] {
  return [...pids.flatMap((pid) => ["/PID", String(pid)]), "/T", "/F"];
}

export interface KillProcessTreeOptions {
  /** Block until the tree kill completes. Only for synchronous contexts such as `process.on("exit")`. */
  sync?: boolean;
  /** Called when the platform tree kill could not be launched or reported failure. */
  onTreeKillFailed?: () => void;
}

/**
 * Terminate `pid` and every process it started.
 *
 * POSIX signals the process group `-pid` (the caller must have spawned the root `detached`) and falls
 * back to the single pid. Windows runs `taskkill /PID <pid> /T /F`. The call never throws.
 */
export function killProcessTree(
  pid: number,
  signal: NodeJS.Signals = "SIGTERM",
  options: KillProcessTreeOptions = {},
): void {
  if (currentPlatform() !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Not a group leader, or the group is already gone.
    }
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
    return;
  }
  killWindowsProcessTrees([pid], options);
}

function killWindowsProcessTrees(pids: readonly number[], options: KillProcessTreeOptions = {}): void {
  if (pids.length === 0) {
    return;
  }
  const args = windowsTreeKillArgs(pids);
  if (options.sync) {
    try {
      const result = currentTreeKillLauncher().spawnSync(taskkillExecutable(), args, {
        stdio: "ignore",
        windowsHide: true,
        timeout: TREE_KILL_SYNC_TIMEOUT_MS,
      });
      if (result.error || result.status !== 0) {
        options.onTreeKillFailed?.();
      }
    } catch {
      options.onTreeKillFailed?.();
    }
    return;
  }
  try {
    const killer = currentTreeKillLauncher().spawn(taskkillExecutable(), args, { stdio: "ignore", windowsHide: true });
    killer.once("error", () => options.onTreeKillFailed?.());
    killer.once("exit", (code) => {
      if (code !== 0) {
        options.onTreeKillFailed?.();
      }
    });
    killer.unref?.();
  } catch {
    options.onTreeKillFailed?.();
  }
}

type ShutdownReason =
  | { kind: "signal"; signal: NodeJS.Signals }
  | { kind: "fatal"; source: "uncaughtException" | "unhandledRejection"; error: unknown }
  | { kind: "exit"; code: number }
  | { kind: "lifetime"; pid: number }
  | { kind: "test"; label: string };

export interface SuperviseSpawnOptions extends Omit<SpawnOptions, "detached"> {
  /** Override spawn for tests or alternate process factories. */
  spawnImpl?: typeof spawn;
  /**
   * Grace period between SIGTERM and SIGKILL when the supervisor tears a child
   * down because the parent is exiting or a lifetime limit expires.
   */
  killGraceMs?: number;
  /**
   * Maximum time a supervised child may live before the supervisor forces it
   * down. The timer is `unref()`'d so it never keeps the parent process alive.
   */
  maxLifetimeMs?: number;
  /**
   * After a kill, how long to wait between the root process exiting and force-closing the child's
   * stdio pipes. A descendant that escaped the tree kill can hold those pipes open, which would
   * otherwise keep `close` (and `waitExit()`) pending forever.
   */
  stdioReleaseGraceMs?: number;
}

export interface SupervisedExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface SupervisedChild {
  pid: number | undefined;
  /**
   * POSIX process-group id (same as child pid when `detached: true`).
   * Windows cannot target negative PIDs, so `pgid` is `null` there.
   */
  pgid: number | null;
  child: ChildProcess;
  kill(signal?: NodeJS.Signals): void;
  waitExit(): Promise<SupervisedExit>;
}

interface RegistryEntry {
  child: ChildProcess;
  pid: number | undefined;
  pgid: number | null;
  killGraceMs: number;
  waitExit: Promise<SupervisedExit>;
  lifetimeTimer: NodeJS.Timeout | null;
  settled: boolean;
  closeResult: SupervisedExit | null;
  /** The root process has exited; its pid may be reused, so win32 must not tree-kill it again. */
  exited: boolean;
  killRequested: boolean;
  /** First signal a win32 tree kill was issued for while the root was alive. */
  treeKillSignal: NodeJS.Signals | null;
  stdioReleaseGraceMs: number;
  stdioReleaseTimer: NodeJS.Timeout | null;
}

const registry = new Map<number, RegistryEntry>();
let handlersInstalled = false;
let activeShutdown: Promise<void> | null = null;
const cleanupHandlers = new Map<string, (...args: unknown[]) => void>();

function currentPlatform(): NodeJS.Platform {
  return process.platform;
}

function usesProcessGroup(platform = currentPlatform()): boolean {
  return platform !== "win32";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatReason(reason: ShutdownReason): string {
  switch (reason.kind) {
    case "signal":
      return reason.signal;
    case "fatal":
      return reason.source;
    case "exit":
      return `exit:${reason.code}`;
    case "lifetime":
      return `maxLifetime:${reason.pid}`;
    case "test":
      return `test:${reason.label}`;
  }
}

function clearLifetimeTimer(entry: RegistryEntry): void {
  if (entry.lifetimeTimer) {
    clearTimeout(entry.lifetimeTimer);
    entry.lifetimeTimer = null;
  }
}

function deregister(entry: RegistryEntry, result: SupervisedExit): void {
  if (entry.settled) {
    return;
  }
  entry.settled = true;
  entry.closeResult = result;
  clearLifetimeTimer(entry);
  clearStdioReleaseTimer(entry);
  if (typeof entry.pid === "number") {
    registry.delete(entry.pid);
    // FNXC:EngineDiagnostics 2026-07-26-09:45: natural close pairs with spawn chatter — debug-only.
    log.debug(`child pid=${entry.pid} exited naturally code=${result.code ?? "null"} signal=${result.signal ?? "null"}`);
  }
}

function clearStdioReleaseTimer(entry: RegistryEntry): void {
  if (entry.stdioReleaseTimer) {
    clearTimeout(entry.stdioReleaseTimer);
    entry.stdioReleaseTimer = null;
  }
}

/*
FNXC:ProcessLifecycle 2026-10-07-18:00:
Every caller settles on the child's `close`, which Node emits only after the root exits AND every stdio pipe closes.
Once a kill was requested and the root has exited, wait `stdioReleaseGraceMs` for trailing output, then destroy the pipes so `close` fires even when a surviving descendant still holds them.
*/
function armStdioRelease(entry: RegistryEntry): void {
  if (entry.settled || entry.stdioReleaseTimer || !entry.exited || !entry.killRequested) {
    return;
  }
  entry.stdioReleaseTimer = setTimeout(() => {
    entry.stdioReleaseTimer = null;
    if (entry.settled) {
      return;
    }
    log.warn(`pid=${entry.pid ?? "unknown"} exited after kill but its stdio is still held open; releasing pipes`);
    for (const stream of entry.child.stdio ?? []) {
      stream?.destroy();
    }
  }, entry.stdioReleaseGraceMs);
  entry.stdioReleaseTimer.unref();
}

/*
FNXC:ProcessLifecycle 2026-10-07-18:00:
`taskkill /F` ends the root with exit code 1 and no signal, while Node's own kill reports the signal.
waitExit() reports the requested signal for a tree-killed root so supervised exits keep one shape on every platform.
*/
function normalizeTreeKilledExit(entry: RegistryEntry, result: SupervisedExit): SupervisedExit {
  if (entry.treeKillSignal && result.signal === null && result.code === 1) {
    return { code: null, signal: entry.treeKillSignal };
  }
  return result;
}

function killEntry(entry: RegistryEntry, signal: NodeJS.Signals = "SIGTERM", options: { sync?: boolean } = {}): void {
  if (typeof entry.pid !== "number") {
    return;
  }
  entry.killRequested = true;

  if (entry.pgid !== null && usesProcessGroup()) {
    // A POSIX group outlives its leader, so the post-close reap still reaches background descendants.
    try {
      process.kill(-entry.pgid, signal);
    } catch {
      // Process group may already be gone.
    }
  } else if (currentPlatform() === "win32") {
    if (!entry.exited) {
      const pid = entry.pid;
      entry.treeKillSignal ??= signal;
      killWindowsProcessTrees([pid], {
        sync: options.sync,
        onTreeKillFailed: () => {
          log.warn(`taskkill could not terminate the tree of pid=${pid}; falling back to direct kill`);
          try {
            entry.child.kill(signal);
          } catch {
            // Already gone.
          }
        },
      });
    }
  } else {
    try {
      entry.child.kill(signal);
    } catch {
      // Child may already be gone.
    }
  }

  armStdioRelease(entry);
}

async function terminateEntry(entry: RegistryEntry, reason: ShutdownReason): Promise<void> {
  if (entry.settled) {
    return;
  }

  log.warn(`terminating pid=${entry.pid ?? "unknown"} pgid=${entry.pgid ?? "n/a"} reason=${formatReason(reason)}`);
  killEntry(entry, "SIGTERM");

  const exitedWithinGrace = await Promise.race([
    entry.waitExit.then(() => true),
    sleep(entry.killGraceMs).then(() => false),
  ]);

  if (exitedWithinGrace || entry.settled) {
    return;
  }

  log.warn(`grace expired for pid=${entry.pid ?? "unknown"}; escalating to SIGKILL`);
  killEntry(entry, "SIGKILL");
  log.warn(`sent SIGKILL to pid=${entry.pid ?? "unknown"} pgid=${entry.pgid ?? "n/a"}`);
  await Promise.race([entry.waitExit, sleep(MAX_KILL_WAIT_MS)]);
}

async function terminateAll(reason: ShutdownReason): Promise<void> {
  if (registry.size === 0) {
    return;
  }

  if (!activeShutdown) {
    activeShutdown = Promise.allSettled(
      [...registry.values()].map((entry) => terminateEntry(entry, reason)),
    ).then(() => undefined).finally(() => {
      activeShutdown = null;
    });
  }

  await activeShutdown;
}

function installHandlers(): void {
  if (handlersInstalled) {
    return;
  }
  handlersInstalled = true;

  const onExit = (code: number) => {
    // `exit` handlers are synchronous: an async taskkill would never run, so win32 kills every live tree in one blocking call.
    if (currentPlatform() === "win32") {
      const livePids: number[] = [];
      for (const entry of registry.values()) {
        if (typeof entry.pid === "number" && !entry.exited) {
          livePids.push(entry.pid);
        }
      }
      killWindowsProcessTrees(livePids, { sync: true });
    } else {
      for (const entry of registry.values()) {
        killEntry(entry, "SIGTERM");
      }
    }
    void code;
  };

  const makeSignalHandler = (signal: NodeJS.Signals) => {
    const handler = () => {
      void terminateAll({ kind: "signal", signal }).finally(() => {
        const listener = cleanupHandlers.get(signal);
        if (listener) {
          process.removeListener(signal, listener as () => void);
        }
        process.kill(process.pid, signal);
      });
    };
    return handler;
  };

  const handleFatal = (source: "uncaughtException" | "unhandledRejection", error: unknown) => {
    void terminateAll({ kind: "fatal", source, error }).finally(() => {
      const listener = cleanupHandlers.get(source);
      if (listener) {
        process.removeListener(source, listener as (value: unknown) => void);
      }
      if (source === "uncaughtException") {
        throw error instanceof Error ? error : new Error(String(error));
      }
      throw error instanceof Error ? error : new Error(`Unhandled rejection: ${String(error)}`);
    });
  };

  cleanupHandlers.set("exit", onExit as (...args: unknown[]) => void);
  process.on("exit", onExit);

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = makeSignalHandler(signal);
    cleanupHandlers.set(signal, handler as (...args: unknown[]) => void);
    process.on(signal, handler);
  }

  const uncaughtHandler = (error: unknown) => {
    handleFatal("uncaughtException", error);
  };
  cleanupHandlers.set("uncaughtException", uncaughtHandler as (...args: unknown[]) => void);
  process.on("uncaughtException", uncaughtHandler);

  const rejectionHandler = (reason: unknown) => {
    handleFatal("unhandledRejection", reason);
  };
  cleanupHandlers.set("unhandledRejection", rejectionHandler as (...args: unknown[]) => void);
  process.on("unhandledRejection", rejectionHandler);
}

/**
 * Spawn a child process under parent-death supervision.
 *
 * On POSIX, the child is spawned with `detached: true`, which makes it the
 * leader of a new process group. That lets the supervisor tear down the full
 * subtree via `process.kill(-pgid, signal)` when the parent exits, receives a
 * termination signal, throws an uncaught error, or hits `maxLifetimeMs`.
 *
 * On Windows, Node cannot signal a negative PID process group, so the child is
 * spawned attached and killed as a tree with `taskkill /T /F` while it is alive.
 * A descendant that already outlived its own parent is invisible to `/T`; the
 * stdio release after a kill still bounds the caller's wait in that case.
 */
export function superviseSpawn(
  command: string,
  args: readonly string[] = [],
  options: SuperviseSpawnOptions = {},
): SupervisedChild {
  installHandlers();

  const {
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    maxLifetimeMs = DEFAULT_MAX_LIFETIME_MS,
    stdioReleaseGraceMs = DEFAULT_STDIO_RELEASE_GRACE_MS,
    spawnImpl = spawn,
    ...spawnOptions
  } = options;

  const processGroup = usesProcessGroup();
  const child = spawnImpl(command, [...args], {
    ...spawnOptions,
    detached: processGroup,
  });

  let resolveExit: ((result: SupervisedExit) => void) | null = null;
  const waitExit = new Promise<SupervisedExit>((resolve) => {
    resolveExit = resolve;
  });

  const entry: RegistryEntry = {
    child,
    pid: child.pid,
    pgid: processGroup && typeof child.pid === "number" ? child.pid : null,
    killGraceMs,
    waitExit,
    lifetimeTimer: null,
    settled: false,
    closeResult: null,
    exited: false,
    killRequested: false,
    treeKillSignal: null,
    stdioReleaseGraceMs,
    stdioReleaseTimer: null,
  };

  child.once("exit", () => {
    entry.exited = true;
    armStdioRelease(entry);
  });

  child.once("close", (code, signal) => {
    const result = normalizeTreeKilledExit(entry, { code, signal });
    deregister(entry, result);
    resolveExit?.(result);
  });

  if (typeof child.pid === "number") {
    registry.set(child.pid, entry);
    /*
    FNXC:EngineDiagnostics 2026-07-26-09:45:
    Every supervised subprocess (verification, scripts, tools) logged spawn+exit at info and flooded the TUI. Keep on debug (FUSION_DEBUG=process-supervisor). Terminations, lifetime kills, and missing-pid stay warn.
    */
    log.debug(`spawned pid=${child.pid} pgid=${entry.pgid ?? "n/a"} command=${command}`);
  } else {
    log.warn(`spawned child without pid for command=${command}`);
  }

  if (Number.isFinite(maxLifetimeMs) && maxLifetimeMs > 0) {
    entry.lifetimeTimer = setTimeout(() => {
      log.warn(`maxLifetime exceeded for pid=${entry.pid ?? "unknown"} after ${maxLifetimeMs}ms`);
      void terminateEntry(entry, { kind: "lifetime", pid: entry.pid ?? -1 });
    }, maxLifetimeMs);
    entry.lifetimeTimer.unref();
  }

  return {
    pid: child.pid,
    pgid: entry.pgid,
    child,
    kill(signal = "SIGTERM") {
      killEntry(entry, signal);
    },
    waitExit() {
      return waitExit;
    },
  };
}

/**
 * FNXC:RemoteAccess 2026-09-01-02:54:
 * Hand a supervised child OVER to the machine, so this process exiting no longer kills it.
 *
 * `installHandlers()` registers a `process.on("exit")` hook that SIGTERMs the process group of every
 * registered child, plus signal handlers that do the same. That is correct for the children this
 * process owns — verification runs, dev servers, tools — but it is exactly wrong for the Tailscale
 * funnel across a SUPERVISED RESTART: the dashboard exits with FUSION_RESTART_EXIT_CODE and the
 * supervisor relaunches it seconds later, so killing remote access on the way out takes the operator's
 * only route to the box down with it (measured twice on the operator's container: dashboard healthy
 * after restart, public URL dead). Releasing removes the entry from the kill registry WITHOUT
 * signalling anything, so the detached child (its own process group leader) is simply reparented to
 * the supervisor and keeps running.
 *
 * Returns false when the pid is unknown — nothing was released and the caller must not claim it was.
 *
 * Callers own the released process from here on: `waitExit()` still settles on close, but no
 * lifetime timer and no parent-death teardown apply any more.
 */
export function releaseSupervisedChild(pid: number | undefined): boolean {
  if (typeof pid !== "number") {
    return false;
  }
  const entry = registry.get(pid);
  if (!entry) {
    return false;
  }
  clearLifetimeTimer(entry);
  clearStdioReleaseTimer(entry);
  registry.delete(pid);
  log.debug(`released pid=${pid} pgid=${entry.pgid ?? "n/a"} from parent-death supervision`);
  return true;
}

export const ProcessSupervisor = {
  superviseSpawn,
  releaseSupervisedChild,
  killProcessTree,
} as const;

/** Replace the launcher that runs `taskkill`, so tests can observe win32 tree kills on any host. */
export function __setProcessTreeKillLauncherForTests(launcher: ProcessTreeKillLauncher | null): void {
  treeKillLauncher = launcher;
}

export function __getProcessSupervisorStateForTests(): { registrySize: number; handlersInstalled: boolean } {
  return {
    registrySize: registry.size,
    handlersInstalled,
  };
}

export async function __terminateSupervisedChildrenForTests(label = "test"): Promise<void> {
  await terminateAll({ kind: "test", label });
}

export function __resetProcessSupervisorForTests(): void {
  for (const entry of registry.values()) {
    clearLifetimeTimer(entry);
    killEntry(entry, "SIGKILL");
    clearStdioReleaseTimer(entry);
  }
  registry.clear();
  treeKillLauncher = null;
  activeShutdown = null;
  for (const [event, handler] of cleanupHandlers.entries()) {
    process.removeListener(event as NodeJS.Signals | "uncaughtException" | "unhandledRejection" | "exit", handler as (...args: unknown[]) => void);
  }
  cleanupHandlers.clear();
  handlersInstalled = false;
}
