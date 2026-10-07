import { EventEmitter } from "node:events";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  killProcessTree,
  type TaskStore,
  type CentralCore,
} from "@fusion/core";
import type { Scheduler } from "../scheduler.js";
import type {
  ProjectRuntime,
  ProjectRuntimeConfig,
  RuntimeStatus,
  RuntimeMetrics,
  ProjectRuntimeEvents,
} from "../project/project-runtime.js";
import { IpcHost } from "../ipc/ipc-host.js";
import {
  START_RUNTIME,
  STOP_RUNTIME,
  GET_METRICS,
  TASK_CREATED,
  TASK_MOVED,
  TASK_UPDATED,
  TASK_DELETED,
  ERROR_EVENT,
  HEALTH_CHANGED,
  type TaskCreatedPayload,
  type TaskMovedPayload,
  type TaskUpdatedPayload,
  type TaskDeletedPayload,
  type ErrorEventPayload,
  type HealthChangedPayload,
} from "../ipc/ipc-protocol.js";
import { runtimeLog } from "../logger.js";

/**
 * Health monitor for tracking child process health.
 */
class HealthMonitor {
  private running = false;
  private missedHeartbeats = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private restartAttempts = 0;
  private restartDelays = [1000, 5000, 15000]; // Exponential backoff: 1s, 5s, 15s

  constructor(
    private onHealthCheck: () => Promise<boolean>,
    private onUnhealthy: () => void,
    private options: {
      intervalMs?: number;
      maxMissedHeartbeats?: number;
      maxRestartAttempts?: number;
    } = {}
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;

    const intervalMs = this.options.intervalMs ?? 5000;
    const maxMissed = this.options.maxMissedHeartbeats ?? 3;

    this.interval = setInterval(async () => {
      const healthy = await this.onHealthCheck();

      if (healthy) {
        if (this.missedHeartbeats > 0) {
          runtimeLog.log(`Health recovered after ${this.missedHeartbeats} missed heartbeats`);
        }
        this.missedHeartbeats = 0;
        this.restartAttempts = 0; // Reset restart attempts on success
      } else {
        this.missedHeartbeats++;
        runtimeLog.warn(`Missed heartbeat ${this.missedHeartbeats}/${maxMissed}`);

        if (this.missedHeartbeats >= maxMissed) {
          runtimeLog.error(`Health check failed after ${maxMissed} attempts`);
          this.onUnhealthy();
        }
      }
    }, intervalMs);

    runtimeLog.log(`Health monitor started (interval: ${intervalMs}ms)`);
  }

  stop(): void {
    this.running = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.missedHeartbeats = 0;
    runtimeLog.log("Health monitor stopped");
  }

  getRestartDelay(): number {
    const delay = this.restartDelays[this.restartAttempts] ?? this.restartDelays[this.restartDelays.length - 1];
    return delay;
  }

  incrementRestartAttempts(): void {
    this.restartAttempts++;
  }

  getRestartAttempts(): number {
    return this.restartAttempts;
  }

  getMissedHeartbeats(): number {
    return this.missedHeartbeats;
  }
}

/** Grace a retiring child gets to exit after the polite signal before it is force-killed. */
const CHILD_SIGKILL_GRACE_MS = 5_000;
/** How long to wait for the exit event after a force kill before giving up on observing it. */
const CHILD_EXIT_AFTER_SIGKILL_MS = 5_000;

/** One forked child and the IPC host bound to it. */
interface ChildGeneration {
  readonly id: number;
  readonly child: ChildProcess;
  readonly ipcHost: IpcHost;
  /** Set once the generation's failure was reported or it was retired; later exit/disconnect/heartbeat signals from it are ignored. */
  settled: boolean;
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode != null || child.signalCode != null;
}

/**
 * ChildProcessRuntime runs a project in an isolated child process.
 *
 * This provides stronger isolation between projects at the cost of
 * IPC overhead. The child process runs an InProcessRuntime internally
 * and communicates with the host via IPC messages.
 *
 * Features:
 * - Process isolation (separate memory space)
 * - Automatic restart on crash with exponential backoff
 * - Health monitoring via heartbeat protocol
 * - Graceful shutdown with configurable timeout
 * - Event forwarding from child process to host listeners
 *
 * FNXC:ChildProcessRuntime 2026-10-07-20:07:
 * At most one live child per runtime, and stop() leaves none.
 * Each fork is a generation that reports at most one failure: a crash fires both `exit` and IPC `disconnect`, and missed heartbeats keep firing, but they cost one restart attempt, not several.
 * A child is retired before its replacement starts or stop() returns: its listeners stop forwarding, it gets SIGTERM (a process-tree kill on Windows), and a SIGKILL bound to that child, not to a mutable field, if it ignores the signal. Termination is judged by its exit, not by `child.killed`, which only means a signal was sent.
 * A child whose START_RUNTIME fails is killed rather than left running, and its piped stdout/stderr are drained into the runtime log so a chatty worker cannot block on a full pipe.
 * Spawning through `superviseSpawn` is deferred: its default lifetime cap would kill a long-lived runtime child, and the worker exits on its own when the host's IPC channel closes.
 *
 * @example
 * ```typescript
 * const config: ProjectRuntimeConfig = {
 *   projectId: "proj_abc123",
 *   workingDirectory: "/path/to/project",
 *   isolationMode: "child-process",
 *   maxConcurrent: 2,
 *   maxWorktrees: 4,
 * };
 *
 * const runtime = new ChildProcessRuntime(config, centralCore);
 * await runtime.start();
 *
 * // Access metrics via IPC
 * const metrics = runtime.getMetrics();
 *
 * await runtime.stop();
 * ```
 */
export class ChildProcessRuntime
  extends EventEmitter<ProjectRuntimeEvents>
  implements ProjectRuntime
{
  private status: RuntimeStatus = "stopped";
  private current: ChildGeneration | null = null;
  private healthMonitor: HealthMonitor;
  /**
   * Monotonic child-process generation.
   *
   * Incremented before every spawn so delayed restart callbacks can invalidate themselves
   * if they were scheduled against an older process generation.
   */
  private generation = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** Terminations of retired children still waiting for their exit. */
  private readonly terminations = new Set<Promise<void>>();
  private lastMetrics: RuntimeMetrics = {
    inFlightTasks: 0,
    activeAgents: 0,
    lastActivityAt: new Date().toISOString(),
  };

  /**
   * @param config - Runtime configuration
   * @param centralCore - CentralCore reference for global coordination
   */
  constructor(
    private config: ProjectRuntimeConfig,
    private centralCore: CentralCore
  ) {
    super();
    this.setMaxListeners(100);

    // Initialize health monitor
    this.healthMonitor = new HealthMonitor(
      async () => this.checkHealth(),
      () => {
        if (this.current) this.reportFailure(this.current, "missed heartbeats");
      },
      { intervalMs: 5000, maxMissedHeartbeats: 3, maxRestartAttempts: 3 }
    );

    runtimeLog.log(`Created ChildProcessRuntime for project ${config.projectId}`);
  }

  /**
   * Start the runtime by spawning a child process.
   *
   * Startup sequence:
   * 1. Set status to "starting"
   * 2. Fork child process pointing to worker entry point
   * 3. Set up IPC host with the child process
   * 4. Send START_RUNTIME command with serialized config
   * 5. Wait for OK response or timeout (10s)
   * 6. Start health monitoring heartbeat
   * 7. Set status to "active"
   */
  async start(): Promise<void> {
    if (this.status !== "stopped") {
      throw new Error(`Cannot start runtime: current status is ${this.status}`);
    }

    this.setStatus("starting");
    runtimeLog.log(`Starting ChildProcessRuntime for project ${this.config.projectId}`);

    try {
      await this.spawnChild();
      this.setStatus("active");
      runtimeLog.log(`ChildProcessRuntime started for project ${this.config.projectId}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.setStatus("errored");
      runtimeLog.error(`Failed to start ChildProcessRuntime:`, err.message);
      this.emit("error", err);
      throw err;
    }
  }

  /**
   * Spawn the child process and set up IPC. A child whose START_RUNTIME fails is retired before the error propagates.
   */
  private async spawnChild(): Promise<void> {
    // Determine worker entry point
    const workerPath = this.getWorkerPath();

    this.generation += 1;

    runtimeLog.log(`Forking child process: ${workerPath}`);

    // Fork child process
    const child = fork(workerPath, [], {
      silent: true, // Pipe stdout/stderr
      execArgv: [], // Don't inherit exec arguments
    });
    const gen: ChildGeneration = {
      id: this.generation,
      child,
      ipcHost: new IpcHost(child, { commandTimeoutMs: 10000 }),
      settled: false,
    };
    this.current = gen;

    this.drainOutput(child);
    this.setupEventForwarding(gen);

    child.on("exit", (code, signal) => {
      runtimeLog.warn(`Child process exited (code: ${code}, signal: ${signal})`);
      this.reportFailure(gen, `exit (code: ${code}, signal: ${signal})`);
    });

    // Send START_RUNTIME command
    runtimeLog.log("Sending START_RUNTIME command to child");
    try {
      await gen.ipcHost.sendCommand(START_RUNTIME, { config: this.config });
    } catch (error) {
      await this.retire(gen);
      throw error;
    }

    // Start health monitoring
    this.healthMonitor.start();
  }

  /** Forward the child's piped output to the log; an unread pipe fills and blocks the worker's writes. */
  private drainOutput(child: ChildProcess): void {
    const prefix = `[child ${this.config.projectId}]`;
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk).trimEnd();
      if (text) runtimeLog.log(`${prefix} ${text}`);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk).trimEnd();
      if (text) runtimeLog.warn(`${prefix} ${text}`);
    });
  }

  /**
   * Get the path to the worker entry point.
   */
  private getWorkerPath(): string {
    // In production, use the compiled .js file
    // In development/tests, use .ts with tsx
    const isCompiled = !import.meta.url.endsWith(".ts");

    const currentDir = dirname(fileURLToPath(import.meta.url));
    const workerFile = isCompiled ? "child-process-worker.js" : "child-process-worker.ts";

    return join(currentDir, workerFile);
  }

  /**
   * Set up event forwarding from one generation's IPC host to runtime listeners.
   */
  private setupEventForwarding(gen: ChildGeneration): void {
    const { ipcHost } = gen;

    // Forward task events
    ipcHost.on(TASK_CREATED, (payload: TaskCreatedPayload) => {
      this.emit("task:created", payload.task);
    });

    ipcHost.on(TASK_MOVED, (payload: TaskMovedPayload) => {
      this.emit("task:moved", { task: payload.task, from: payload.from, to: payload.to });
    });

    ipcHost.on(TASK_UPDATED, (payload: TaskUpdatedPayload) => {
      this.emit("task:updated", payload.task);
    });

    ipcHost.on(TASK_DELETED, (payload: TaskDeletedPayload) => {
      this.emit("task:deleted", payload.task, payload.meta);
    });

    // Forward error events
    ipcHost.on(ERROR_EVENT, (payload: ErrorEventPayload) => {
      const error = new Error(payload.message);
      if (payload.code) {
        (error as Error & { code: string }).code = payload.code;
      }
      this.emit("error", error);
    });

    // Forward health change events
    ipcHost.on(HEALTH_CHANGED, (payload: HealthChangedPayload) => {
      this.status = payload.status as RuntimeStatus;
      this.emit("health-changed", { status: payload.status, previous: payload.previous });
    });

    // Handle disconnect
    ipcHost.on("disconnect", () => {
      runtimeLog.warn("IPC host disconnected");
      this.reportFailure(gen, "IPC channel disconnected");
    });
  }

  /**
   * Stop the runtime with graceful shutdown.
   *
   * Shutdown sequence:
   * 1. Set status to "stopping"
   * 2. Stop health monitoring
   * 3. Send STOP_RUNTIME command with 30s timeout
   * 4. Retire the child and wait for it (and any child still being retired) to exit
   * 5. Set status to "stopped"
   */
  async stop(): Promise<void> {
    if (this.status === "stopped" || this.status === "stopping") {
      return;
    }

    this.setStatus("stopping");
    runtimeLog.log(`Stopping ChildProcessRuntime for project ${this.config.projectId}`);

    // Cancel restart backoff
    this.clearAllTimers();

    // Stop health monitoring
    this.healthMonitor.stop();

    const gen = this.current;
    try {
      // Send graceful shutdown command
      if (gen?.ipcHost.isConnected()) {
        runtimeLog.log("Sending STOP_RUNTIME command to child");
        await gen.ipcHost.sendCommand(STOP_RUNTIME, { timeoutMs: 30000 }, 35000);
      }
    } catch (error) {
      runtimeLog.warn(`Graceful shutdown failed: ${error}`);
    }

    if (gen) void this.retire(gen);
    await Promise.all([...this.terminations]);

    this.setStatus("stopped");
    runtimeLog.log(`ChildProcessRuntime stopped for project ${this.config.projectId}`);
  }

  /**
   * Retire a generation: stop forwarding its events, ignore its late signals, and terminate its child.
   * Resolves once the child has exited (or could not be observed exiting after a force kill).
   */
  private retire(gen: ChildGeneration): Promise<void> {
    gen.settled = true;
    if (this.current === gen) this.current = null;
    gen.ipcHost.removeAllListeners();

    const termination = this.terminate(gen.child);
    this.terminations.add(termination);
    void termination.finally(() => this.terminations.delete(termination));
    return termination;
  }

  /** SIGTERM (a tree kill on Windows), then SIGKILL after a grace period, both bound to this child. */
  private terminate(child: ChildProcess): Promise<void> {
    if (hasExited(child)) return Promise.resolve();

    return new Promise<void>((resolve) => {
      let abandon: ReturnType<typeof setTimeout> | undefined;
      const escalation = setTimeout(() => {
        if (hasExited(child)) return finish();
        runtimeLog.warn("Force killing child process");
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        abandon = setTimeout(() => {
          runtimeLog.error(`Child process ${child.pid ?? "?"} did not report exit after SIGKILL`);
          finish();
        }, CHILD_EXIT_AFTER_SIGKILL_MS);
      }, CHILD_SIGKILL_GRACE_MS);
      function finish(): void {
        clearTimeout(escalation);
        clearTimeout(abandon);
        child.removeListener("exit", finish);
        resolve();
      }
      child.once("exit", finish);

      runtimeLog.log("Killing child process");
      try {
        if (process.platform === "win32") {
          // Windows has no graceful SIGTERM and `kill` ends only the direct child; take the worker's agents with it.
          killProcessTree(child);
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        // already gone; the exit event or the escalation settles it
      }
    });
  }

  /**
   * Clears the restart backoff timer.
   *
   * This is called during shutdown and before replacing a pending restart so
   * a stale restart cannot fire against newer runtime state.
   */
  private clearAllTimers(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  /**
   * Get the current runtime status.
   */
  getStatus(): RuntimeStatus {
    return this.status;
  }

  /**
   * Get the project's TaskStore instance.
   * @throws Error - Not accessible in child mode (use IPC instead)
   */
  getTaskStore(): TaskStore {
    throw new Error(
      "TaskStore is not accessible in ChildProcessRuntime. " +
        "Use IPC methods to access task data."
    );
  }

  /**
   * Get the project's Scheduler instance.
   * @throws Error - Not accessible in child mode
   */
  getScheduler(): Scheduler {
    throw new Error(
      "Scheduler is not accessible in ChildProcessRuntime. " +
        "Use IPC methods to interact with the scheduler."
    );
  }

  /**
   * Get current runtime metrics (via IPC query).
   */
  getMetrics(): RuntimeMetrics {
    const ipcHost = this.current?.ipcHost;
    // Query metrics via IPC if connected
    if (ipcHost?.isConnected()) {
      // Fire-and-forget metrics request - returns cached value immediately
      ipcHost
        .sendCommand(GET_METRICS, {})
        .then((metrics: unknown) => {
          this.lastMetrics = metrics as RuntimeMetrics;
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          runtimeLog.warn(`GET_METRICS IPC query failed, using cached value: ${msg}`);
        });
    }

    return {
      ...this.lastMetrics,
      lastActivityAt: new Date().toISOString(),
    };
  }

  /**
   * Check health by pinging the child process.
   */
  private async checkHealth(): Promise<boolean> {
    const ipcHost = this.current?.ipcHost;
    if (!ipcHost?.isConnected()) {
      return false;
    }

    try {
      await ipcHost.ping(5000);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Report a generation's failure once. Signals from a retired or already-failed generation, or while stopping, are ignored.
   */
  private reportFailure(gen: ChildGeneration, reason: string): void {
    if (gen.settled || this.current !== gen) return;
    if (this.isStopping()) return;
    gen.settled = true;
    runtimeLog.warn(`Unexpected child failure (${reason})`);
    this.handleUnhealthy();
  }

  /**
   * Schedule a restart with backoff, or transition to errored once restarts are exhausted.
   */
  private handleUnhealthy(): void {
    const maxRestarts = 3;

    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.healthMonitor.getRestartAttempts() >= maxRestarts) {
      runtimeLog.error(`Max restart attempts (${maxRestarts}) reached, transitioning to errored`);
      this.setStatus("errored");
      this.emit("error", new Error("Child process failed after max restart attempts"));
      if (this.current) void this.retire(this.current);
      return;
    }

    const delay = this.healthMonitor.getRestartDelay();
    this.healthMonitor.incrementRestartAttempts();

    runtimeLog.log(`Attempting restart ${this.healthMonitor.getRestartAttempts()}/${maxRestarts} after ${delay}ms`);

    const gen = this.generation;
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;

      if (this.generation !== gen) {
        return;
      }

      if (this.isStopping()) {
        return;
      }

      try {
        // The replacement starts only after the failed child is gone; a fresh heartbeat count goes with it.
        this.healthMonitor.stop();
        if (this.current) await this.retire(this.current);
        if (this.isStopping()) return;
        await this.spawnChild();
        if (this.isStopping()) {
          // stop() ran while the replacement was starting; it must not outlive the runtime.
          if (this.current) await this.retire(this.current);
          return;
        }
        runtimeLog.log("Child process restarted successfully");
      } catch (error) {
        if (this.isStopping()) return;
        runtimeLog.error("Failed to restart child process:", error);
        this.setStatus("errored");
        this.emit("error", error instanceof Error ? error : new Error(String(error)));
      }
    }, delay);
  }

  private isStopping(): boolean {
    return this.status === "stopping" || this.status === "stopped";
  }

  /**
   * Update status and emit health-changed event.
   */
  private setStatus(newStatus: RuntimeStatus): void {
    const previous = this.status;
    this.status = newStatus;

    if (previous !== newStatus) {
      this.emit("health-changed", { status: newStatus, previous });
    }
  }
}
