import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { CentralCore, Task } from "@fusion/core";
import { ChildProcessRuntime } from "../child-process-runtime.js";
import type {
  ProjectRuntimeConfig,
  RuntimeMetrics,
  RuntimeStatus,
} from "../../project/project-runtime.js";
import { runtimeLog } from "../../logger.js";
import {
  START_RUNTIME,
  STOP_RUNTIME,
  GET_METRICS,
  TASK_CREATED,
  TASK_MOVED,
  TASK_UPDATED,
  ERROR_EVENT,
  HEALTH_CHANGED,
  OK,
  ERROR,
  PONG,
} from "../../ipc/ipc-protocol.js";

type Listener = (...args: any[]) => void;

type CommandMessage = {
  type: string;
  id: string;
  payload: unknown;
};

type MockChildOptions = {
  pingResults?: boolean[];
  metricsResponse?: RuntimeMetrics;
  sendCallbackErrors?: Partial<Record<string, Error>>;
  /** The child receives SIGTERM but keeps running, like a worker hung in its shutdown handler. */
  ignoreSigterm?: boolean;
};

type MockChildProcess = EventEmitter & {
  send: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  stdout: PassThrough;
  stderr: PassThrough;
  stdio: Array<PassThrough | null>;
  pid: number;
  /** `close` was emitted, so the process supervisor deregistered this child. */
  closed: boolean;
  connected: boolean;
  killed: boolean;
  exitCode: number | null;
  signalCode: string | null;
  sentMessages: CommandMessage[];
  /** Exit as a real process does: the IPC channel closes, then `exit` and `close` fire. */
  exitNow: (code: number | null, signal: string | null) => void;
};

const workerChildren: MockChildProcess[] = [];
/** Worker children that have not exited; the runtime must never hold more than one. */
const liveChildren = new Set<MockChildProcess>();
let maxLiveChildren = 0;
const queuedWorkerOptions: MockChildOptions[] = [];

let nextPid = 5000;

function createMockChildProcess(options: MockChildOptions = {}): MockChildProcess {
  const pingResults = [...(options.pingResults ?? [])];

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    // The supervisor may destroy stdio after a kill; stdin and the IPC slot are not streams here.
    stdio: [null, stdout, stderr, null],
    pid: nextPid++,
    closed: false,
    exitCode: null as number | null,
    signalCode: null as string | null,
    exitNow: (code: number | null, signal: string | null) => {
      if (child.closed) return;
      if (child.exitCode === null && child.signalCode === null) {
        child.exitCode = code;
        child.signalCode = signal;
      }
      liveChildren.delete(child);
      if (child.connected) {
        child.connected = false;
        child.emit("disconnect");
      }
      child.emit("exit", child.exitCode, child.signalCode);
      // `close` settles the supervisor's waitExit and deregisters the child.
      child.closed = true;
      child.emit("close", child.exitCode, child.signalCode);
    },
    send: vi.fn((message: CommandMessage, callback?: (error: Error | null) => void) => {
      child.sentMessages.push(message);

      const sendError = options.sendCallbackErrors?.[message.type];
      if (sendError) {
        callback?.(sendError);
        return false;
      }

      callback?.(null);

      const respond = (type: string, payload: unknown) => {
        Promise.resolve().then(() => {
          child.emit("message", {
            type,
            id: message.id,
            payload,
          });
        });
      };

      if (message.type === START_RUNTIME) {
        respond(OK, { data: { status: "active" } });
      } else if (message.type === STOP_RUNTIME) {
        respond(OK, { data: { stopped: true } });
      } else if (message.type === GET_METRICS) {
        respond(OK, {
          data:
            options.metricsResponse ??
            {
              inFlightTasks: 4,
              activeAgents: 2,
              lastActivityAt: "2026-04-08T00:00:00.000Z",
            },
        });
      } else if (message.type === "PING") {
        const pingOk = pingResults.shift() ?? true;
        if (pingOk) {
          respond(PONG, { timestamp: "2026-04-08T00:00:00.000Z" });
        } else {
          respond(ERROR, { message: "Ping failed", code: "PING_FAILED" });
        }
      }

      return true;
    }),
    kill: vi.fn((signal?: string | number) => {
      // `killed` means a signal was delivered, not that the process exited.
      child.killed = true;
      if (signal === "SIGTERM" && options.ignoreSigterm) return true;
      queueMicrotask(() => child.exitNow(null, typeof signal === "string" ? signal : "SIGTERM"));
      return true;
    }),
    disconnect: vi.fn(() => {
      child.connected = false;
      child.emit("disconnect");
    }),
    connected: true,
    killed: false,
    sentMessages: [] as CommandMessage[],
  }) as MockChildProcess;

  liveChildren.add(child);
  return child;
}

/** Worker creation through the process supervisor's spawn: `spawn(process.execPath, [workerPath], { stdio: [..., "ipc"] })`. */
const mockWorkerSpawn = vi.fn((_command: string, _args: string[], _options: { stdio?: unknown[] }) => {
  const options = queuedWorkerOptions.shift() ?? {};
  const child = createMockChildProcess(options);
  workerChildren.push(child);
  maxLiveChildren = Math.max(maxLiveChildren, liveChildren.size);
  return child;
});

// taskkill for the Windows tree kill; resolves the target's exit like the real one.
function mockTaskkill(args: string[]) {
  const killer = Object.assign(new EventEmitter(), { unref: vi.fn() });
  const pid = Number(args[1]);
  queueMicrotask(() => {
    workerChildren.find((child) => child.pid === pid)?.exitNow(1, null);
    killer.emit("exit", 0);
  });
  return killer;
}

/** Every `node:child_process` spawn: the supervised worker (IPC stdio) or a taskkill tree kill. */
const mockSpawn = vi.fn((command: string, args: string[], options: { stdio?: unknown[] } = {}) => {
  if (command === process.execPath && Array.isArray(options.stdio) && options.stdio.includes("ipc")) {
    return mockWorkerSpawn(command, args, options);
  }
  return mockTaskkill(args);
});

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: (...args: unknown[]) => (mockSpawn as (...mockArgs: unknown[]) => unknown)(...args),
}));

function queueChild(options: MockChildOptions = {}): void {
  queuedWorkerOptions.push(options);
}

function getLatestChild(): MockChildProcess {
  const child = workerChildren.at(-1);
  if (!child) {
    throw new Error("Expected a spawned worker child process");
  }
  return child;
}

function getMessages(child: MockChildProcess, type: string): CommandMessage[] {
  return child.sentMessages.filter((message) => message.type === type);
}

function createMockTask(id: string): Task {
  return {
    id,
    title: `${id} title`,
    description: `${id} description`,
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    createdAt: "2026-04-08T00:00:00.000Z",
    updatedAt: "2026-04-08T00:00:00.000Z",
    size: "M",
    reviewLevel: 1,
    log: [],
    attachments: [],
  } as Task;
}

describe("ChildProcessRuntime", () => {
  let runtime: ChildProcessRuntime;
  let runtimeAny: any;

  const testConfig: ProjectRuntimeConfig = {
    projectId: "proj_test123",
    workingDirectory: "/tmp/test-project",
    isolationMode: "child-process",
    maxConcurrent: 2,
    maxWorktrees: 4,
  };

  beforeEach(() => {
    mockWorkerSpawn.mockClear();
    mockSpawn.mockClear();
    workerChildren.length = 0;
    queuedWorkerOptions.length = 0;
    liveChildren.clear();
    maxLiveChildren = 0;
    // Termination is platform-specific; the default suite asserts the POSIX signals.
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    /*
    FNXC:ChildProcessRuntime 2026-10-08-05:13:
    The supervised worker is signalled as a POSIX process group (`process.kill(-pgid)`).
    Route a mock worker's group kill to that mock; never let a fake pid reach the real process.kill.
    */
    vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
      if (pid < 0) {
        const worker = workerChildren.find((child) => child.pid === -pid);
        if (worker && !worker.closed) (worker.kill as (signal?: string | number) => boolean)(signal);
      }
      return true;
    });

    const mockCentralCore = {
      getGlobalConcurrencyState: vi.fn().mockResolvedValue({
        globalMaxConcurrent: 4,
        currentlyActive: 0,
        queuedCount: 0,
        projectsActive: {},
      }),
    } as unknown as CentralCore;

    runtime = new ChildProcessRuntime(testConfig, mockCentralCore);
    runtimeAny = runtime as any;
  });

  afterEach(async () => {
    try {
      await runtime.stop();
    } catch {
      // Ignore cleanup failures
    }
    // Safety drain: deregister every mock worker from the process supervisor, or its real parent-exit handler would kill their fake pids on the host.
    for (const child of workerChildren) child.exitNow(0, null);
    expect(workerChildren.every((child) => child.closed)).toBe(true);

    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("startup sequence", () => {
    it("transitions stopped → starting → active, spawns the worker under supervision, and sends START_RUNTIME config", async () => {
      queueChild();

      const transitions: RuntimeStatus[] = [];
      runtime.on("health-changed", (data) => transitions.push(data.status));

      await runtime.start();

      const child = getLatestChild();

      expect(transitions).toEqual(["starting", "active"]);
      expect(runtime.getStatus()).toBe("active");
      // `detached: true` is set only by superviseSpawn on POSIX, so it proves the worker is supervised.
      expect(mockWorkerSpawn).toHaveBeenCalledTimes(1);
      expect(mockWorkerSpawn).toHaveBeenCalledWith(
        process.execPath,
        [expect.stringMatching(/child-process-worker\.(ts|js)$/)],
        expect.objectContaining({
          stdio: ["pipe", "pipe", "pipe", "ipc"],
          detached: true,
        })
      );
      expect(mockWorkerSpawn.mock.calls[0]?.[2]).not.toHaveProperty("execArgv");

      const startMessages = getMessages(child, START_RUNTIME);
      expect(startMessages).toHaveLength(1);
      expect(startMessages[0]?.payload).toEqual({ config: testConfig });
    });

    it("sets status to errored and emits error when startup fails", async () => {
      queueChild({
        sendCallbackErrors: {
          [START_RUNTIME]: new Error("start send failed"),
        },
      });

      const errorSpy = vi.fn();
      runtime.on("error", errorSpy);

      await expect(runtime.start()).rejects.toThrow("Failed to send command: start send failed");
      expect(runtime.getStatus()).toBe("errored");
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    });

    it("throws when start() is called in non-stopped states", async () => {
      const blockedStates: RuntimeStatus[] = ["starting", "active", "stopping"];

      for (const status of blockedStates) {
        runtimeAny.status = status;
        await expect(runtime.start()).rejects.toThrow(`Cannot start runtime: current status is ${status}`);
      }
    });
  });

  describe("shutdown sequence", () => {
    it("transitions active → stopping → stopped and sends STOP_RUNTIME with timeout", async () => {
      queueChild();
      await runtime.start();
      const child = getLatestChild();

      const transitions: RuntimeStatus[] = [];
      runtime.on("health-changed", (data) => transitions.push(data.status));

      await runtime.stop();

      expect(transitions).toEqual(["stopping", "stopped"]);
      expect(runtime.getStatus()).toBe("stopped");
      expect(getMessages(child, STOP_RUNTIME)).toHaveLength(1);
      expect(getMessages(child, STOP_RUNTIME)[0]?.payload).toEqual({ timeoutMs: 30000 });
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    });

    it("is idempotent and does not send duplicate STOP_RUNTIME commands", async () => {
      queueChild();
      await runtime.start();
      const child = getLatestChild();

      await runtime.stop();
      await runtime.stop();

      expect(getMessages(child, STOP_RUNTIME)).toHaveLength(1);
      expect(child.kill).toHaveBeenCalledTimes(1);
    });

    it("returns without error when stop() is called while already stopped", async () => {
      await expect(runtime.stop()).resolves.toBeUndefined();
      expect(runtime.getStatus()).toBe("stopped");
    });

    it("handles stop() gracefully when IPC is already disconnected", async () => {
      queueChild();
      runtime.on("error", () => {
        // swallow asynchronous error events from disconnection path
      });

      await runtime.start();
      const child = getLatestChild();

      child.connected = false;
      child.emit("disconnect");

      await expect(runtime.stop()).resolves.toBeUndefined();
      expect(runtime.getStatus()).toBe("stopped");
    });

    it("force-kills the same child with SIGKILL when it ignores SIGTERM, and waits for it to exit", async () => {
      vi.useFakeTimers();
      queueChild({ ignoreSigterm: true });

      await runtime.start();
      const child = getLatestChild();

      let stopped = false;
      const stopping = runtime.stop().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
      expect(stopped).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await stopping;

      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(child.signalCode).toBe("SIGKILL");
      expect(liveChildren.size).toBe(0);
      expect(runtime.getStatus()).toBe("stopped");
    });
  });

  describe("health monitoring and restart", () => {
    it("starts health monitoring after start() and performs periodic pings", async () => {
      vi.useFakeTimers();
      queueChild({ pingResults: [true, true] });

      await runtime.start();
      const child = getLatestChild();

      expect(getMessages(child, "PING")).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(5000);
      expect(getMessages(child, "PING")).toHaveLength(1);
    });

    it("resets missed heartbeat count to 0 after a successful ping", async () => {
      vi.useFakeTimers();
      queueChild({ pingResults: [false, true] });
      runtime.on("error", () => {
        // swallow
      });

      await runtime.start();

      await vi.advanceTimersByTimeAsync(5000);
      expect(runtimeAny.healthMonitor.getMissedHeartbeats()).toBe(1);

      await vi.advanceTimersByTimeAsync(5000);
      expect(runtimeAny.healthMonitor.getMissedHeartbeats()).toBe(0);
    });

    it("triggers handleUnhealthy after three missed heartbeats", async () => {
      vi.useFakeTimers();
      queueChild({ pingResults: [false, false, false] });

      const unhealthySpy = vi.spyOn(runtimeAny, "handleUnhealthy").mockImplementation(() => {});

      await runtime.start();
      await vi.advanceTimersByTimeAsync(15000);

      expect(unhealthySpy).toHaveBeenCalledTimes(1);
    });

    it("uses exponential restart delays: 1000ms, 5000ms, 15000ms", () => {
      vi.useFakeTimers();
      runtimeAny.status = "active";

      const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

      runtimeAny.handleUnhealthy();
      runtimeAny.handleUnhealthy();
      runtimeAny.handleUnhealthy();

      const delays = timeoutSpy.mock.calls.map((call) => Number(call[1]));
      expect(delays.slice(0, 3)).toEqual([1000, 5000, 15000]);
    });

    it("transitions to errored and emits error after max restart attempts", () => {
      runtimeAny.status = "active";

      const errorSpy = vi.fn();
      runtime.on("error", errorSpy);

      runtimeAny.handleUnhealthy();
      runtimeAny.handleUnhealthy();
      runtimeAny.handleUnhealthy();
      runtimeAny.handleUnhealthy();

      expect(runtime.getStatus()).toBe("errored");
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]?.[0]).toBeInstanceOf(Error);
      expect((errorSpy.mock.calls[0]?.[0] as Error).message).toContain("max restart attempts");
    });

    it("resets restart attempt counter after a successful health check", async () => {
      vi.useFakeTimers();
      queueChild({ pingResults: [true] });

      await runtime.start();

      runtimeAny.healthMonitor.incrementRestartAttempts();
      runtimeAny.healthMonitor.incrementRestartAttempts();
      expect(runtimeAny.healthMonitor.getRestartAttempts()).toBe(2);

      await vi.advanceTimersByTimeAsync(5000);

      expect(runtimeAny.healthMonitor.getRestartAttempts()).toBe(0);
    });

    it("stops health checks after stop()", async () => {
      vi.useFakeTimers();
      queueChild({ pingResults: [true, true, true] });

      await runtime.start();
      const child = getLatestChild();

      await vi.advanceTimersByTimeAsync(5000);
      const pingCountBeforeStop = getMessages(child, "PING").length;

      await runtime.stop();
      await vi.advanceTimersByTimeAsync(20000);

      expect(getMessages(child, "PING").length).toBe(pingCountBeforeStop);
    });
  });

  describe("child process exit and disconnect", () => {
    it("unexpected child exit while active triggers restart handling", async () => {
      queueChild();
      await runtime.start();

      const child = getLatestChild();
      const unhealthySpy = vi.spyOn(runtimeAny, "handleUnhealthy").mockImplementation(() => {});

      child.emit("exit", 1, null);

      expect(unhealthySpy).toHaveBeenCalled();
    });

    it("child exit while stopping does not trigger restart", async () => {
      queueChild();
      await runtime.start();

      const child = getLatestChild();
      const unhealthySpy = vi.spyOn(runtimeAny, "handleUnhealthy").mockImplementation(() => {});
      runtimeAny.status = "stopping";

      child.emit("exit", 1, null);

      expect(unhealthySpy).not.toHaveBeenCalled();
    });

    it("child exit while stopped does not trigger restart", async () => {
      queueChild();
      await runtime.start();

      const child = getLatestChild();
      const unhealthySpy = vi.spyOn(runtimeAny, "handleUnhealthy").mockImplementation(() => {});
      runtimeAny.status = "stopped";

      child.emit("exit", 1, null);

      expect(unhealthySpy).not.toHaveBeenCalled();
    });

    it("IPC disconnect while active triggers restart handling", async () => {
      queueChild();
      await runtime.start();

      const child = getLatestChild();
      const unhealthySpy = vi.spyOn(runtimeAny, "handleUnhealthy").mockImplementation(() => {});

      child.emit("disconnect");

      expect(unhealthySpy).toHaveBeenCalled();
    });

    it("IPC disconnect while stopping does not trigger restart", async () => {
      queueChild();
      await runtime.start();

      const child = getLatestChild();
      const unhealthySpy = vi.spyOn(runtimeAny, "handleUnhealthy").mockImplementation(() => {});
      runtimeAny.status = "stopping";

      child.emit("disconnect");

      expect(unhealthySpy).not.toHaveBeenCalled();
    });
  });

  /*
  FNXC:ChildProcessRuntime 2026-10-07-20:07:
  At most one live child per runtime and none after stop(); one failure per child generation; failed starts leave no child.
  */
  describe("child lifecycle invariants", () => {
    it("charges one restart attempt when a crash fires both exit and disconnect", async () => {
      vi.useFakeTimers();
      queueChild();
      queueChild();
      runtime.on("error", () => {});
      await runtime.start();

      getLatestChild().exitNow(1, null);
      expect(runtimeAny.healthMonitor.getRestartAttempts()).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(mockWorkerSpawn).toHaveBeenCalledTimes(2);
      expect(runtime.getStatus()).toBe("active");
    });

    it("keeps the healthy replacement when the old child's late exit arrives after a heartbeat restart", async () => {
      vi.useFakeTimers();
      queueChild({ pingResults: [false, false, false], ignoreSigterm: true });
      queueChild({ pingResults: [true, true, true, true] });
      runtime.on("error", () => {});
      await runtime.start();
      const first = getLatestChild();

      // Three missed heartbeats, then the 1s backoff: the old child is signalled but has not exited yet.
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(first.kill).toHaveBeenCalledWith("SIGTERM");
      expect(mockWorkerSpawn).toHaveBeenCalledTimes(1);

      // The replacement forks only after the old child is gone.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(first.signalCode).toBe("SIGKILL");
      expect(mockWorkerSpawn).toHaveBeenCalledTimes(2);
      const second = getLatestChild();

      first.emit("exit", 137, "SIGKILL");
      first.emit("disconnect");
      await vi.advanceTimersByTimeAsync(20_000);

      expect(second.kill).not.toHaveBeenCalled();
      expect(mockWorkerSpawn).toHaveBeenCalledTimes(2);
      expect(runtime.getStatus()).toBe("active");
      expect(maxLiveChildren).toBe(1);
      // Every generation, including the restart, is spawned by the supervisor (its own process group).
      expect(mockWorkerSpawn.mock.calls.every(([, , options]) => (options as { detached?: boolean }).detached === true)).toBe(true);
    });

    it("charges one restart attempt for repeated missed heartbeats from the same child", async () => {
      vi.useFakeTimers();
      queueChild({ pingResults: Array(10).fill(false), ignoreSigterm: true });
      queueChild();
      runtime.on("error", () => {});
      await runtime.start();

      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(4_000);

      expect(runtimeAny.healthMonitor.getRestartAttempts()).toBe(1);

      // The SIGTERM-ignoring child is still being retired; let stop() escalate on the fake clock.
      const stopping = runtime.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      await stopping;
      expect(liveChildren.size).toBe(0);
    });

    it("kills the forked child when START_RUNTIME fails", async () => {
      queueChild({ sendCallbackErrors: { [START_RUNTIME]: new Error("start send failed") } });
      runtime.on("error", () => {});

      await expect(runtime.start()).rejects.toThrow("start send failed");

      const child = getLatestChild();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(liveChildren.size).toBe(0);
    });

    it("leaves no child when stop() lands during restart backoff", async () => {
      vi.useFakeTimers();
      queueChild();
      runtime.on("error", () => {});
      await runtime.start();

      getLatestChild().exitNow(1, null);
      await runtime.stop();
      await vi.advanceTimersByTimeAsync(20_000);

      expect(mockWorkerSpawn).toHaveBeenCalledTimes(1);
      expect(liveChildren.size).toBe(0);
      expect(runtime.getStatus()).toBe("stopped");
    });

    it("retires the child when restarts are exhausted", async () => {
      queueChild();
      runtime.on("error", () => {});
      await runtime.start();
      const child = getLatestChild();
      runtimeAny.healthMonitor.incrementRestartAttempts();
      runtimeAny.healthMonitor.incrementRestartAttempts();
      runtimeAny.healthMonitor.incrementRestartAttempts();

      child.emit("disconnect");
      await Promise.resolve();

      expect(runtime.getStatus()).toBe("errored");
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    });

    it("drains the child's piped stdout and stderr into the runtime log", async () => {
      const logSpy = vi.spyOn(runtimeLog, "log");
      const warnSpy = vi.spyOn(runtimeLog, "warn");
      queueChild();
      await runtime.start();
      const child = getLatestChild();

      child.stdout.emit("data", Buffer.from("worker says hi\n"));
      child.stderr.emit("data", Buffer.from("worker warns\n"));

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("worker says hi"));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("worker warns"));
    });

    it("terminates the child's whole process tree on Windows", async () => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      queueChild();
      await runtime.start();
      const child = getLatestChild();

      await runtime.stop();

      expect(mockWorkerSpawn).toHaveBeenCalledWith(
        process.execPath,
        [expect.stringMatching(/child-process-worker\.(ts|js)$/)],
        expect.objectContaining({ stdio: ["pipe", "pipe", "pipe", "ipc"], detached: false }),
      );
      const taskkills = mockSpawn.mock.calls.filter(([command]) => command !== process.execPath);
      expect(taskkills).toHaveLength(1);
      expect(mockSpawn).toHaveBeenCalledWith(
        // Core resolves taskkill under %SystemRoot%\System32 when it is set.
        expect.stringMatching(/(^|[\\/])taskkill(\.exe)?$/i),
        ["/PID", String(child.pid), "/T", "/F"],
        expect.objectContaining({ shell: false }),
      );
      expect(liveChildren.size).toBe(0);
    });

    /*
    FNXC:ChildProcessRuntime 2026-10-08-05:13:
    The supervised worker opts out of the supervisor's 10-minute default lifetime cap; a healthy runtime must outlive it.
    */
    it("never lifetime-kills a healthy supervised worker past the supervisor's 10-minute default", async () => {
      vi.useFakeTimers();
      queueChild({ pingResults: Array(200).fill(true) });
      await runtime.start();
      const child = getLatestChild();

      await vi.advanceTimersByTimeAsync(11 * 60_000);

      expect(child.kill).not.toHaveBeenCalled();
      expect(liveChildren.size).toBe(1);
      expect(mockWorkerSpawn).toHaveBeenCalledTimes(1);
      expect(runtime.getStatus()).toBe("active");
    });
  });

  describe("event forwarding", () => {
    it("forwards TASK_CREATED as task:created", async () => {
      queueChild();
      await runtime.start();
      const child = getLatestChild();

      const task = createMockTask("FN-1279-A");
      const createdSpy = vi.fn();
      runtime.on("task:created", createdSpy);

      child.emit("message", {
        type: TASK_CREATED,
        id: "evt-created",
        payload: { task },
      });

      expect(createdSpy).toHaveBeenCalledWith(task);
    });

    it("forwards TASK_MOVED as task:moved with { task, from, to } shape", async () => {
      queueChild();
      await runtime.start();
      const child = getLatestChild();

      const task = createMockTask("FN-1279-B");
      const movedSpy = vi.fn();
      runtime.on("task:moved", movedSpy);

      child.emit("message", {
        type: TASK_MOVED,
        id: "evt-moved",
        payload: { task, from: "todo", to: "in-progress" },
      });

      expect(movedSpy).toHaveBeenCalledWith({ task, from: "todo", to: "in-progress" });
    });

    it("forwards TASK_UPDATED as task:updated", async () => {
      queueChild();
      await runtime.start();
      const child = getLatestChild();

      const task = createMockTask("FN-1279-C");
      const updatedSpy = vi.fn();
      runtime.on("task:updated", updatedSpy);

      child.emit("message", {
        type: TASK_UPDATED,
        id: "evt-updated",
        payload: { task },
      });

      expect(updatedSpy).toHaveBeenCalledWith(task);
    });

    it("forwards ERROR_EVENT as Error instance and preserves error code", async () => {
      queueChild();
      await runtime.start();
      const child = getLatestChild();

      const errorSpy = vi.fn();
      runtime.on("error", errorSpy);

      child.emit("message", {
        type: ERROR_EVENT,
        id: "evt-error",
        payload: { message: "worker failed", code: "WORKER_FAILURE" },
      });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const forwardedError = errorSpy.mock.calls[0]?.[0] as Error & { code?: string };
      expect(forwardedError).toBeInstanceOf(Error);
      expect(forwardedError.message).toBe("worker failed");
      expect(forwardedError.code).toBe("WORKER_FAILURE");
    });

    it("applies HEALTH_CHANGED payload to status and emits health-changed", async () => {
      queueChild();
      await runtime.start();
      const child = getLatestChild();

      const healthSpy = vi.fn();
      runtime.on("health-changed", healthSpy);
      healthSpy.mockClear();

      child.emit("message", {
        type: HEALTH_CHANGED,
        id: "evt-health",
        payload: { status: "paused", previous: "active" },
      });

      expect(runtime.getStatus()).toBe("paused");
      expect(healthSpy).toHaveBeenCalledWith({ status: "paused", previous: "active" });
    });
  });

  describe("metrics and inaccessible accessors", () => {
    it("returns cached metrics when IPC is disconnected", () => {
      runtimeAny.lastMetrics = {
        inFlightTasks: 9,
        activeAgents: 3,
        lastActivityAt: "2026-04-08T01:00:00.000Z",
      };

      const metrics = runtime.getMetrics();

      expect(metrics.inFlightTasks).toBe(9);
      expect(metrics.activeAgents).toBe(3);
      expect(typeof metrics.lastActivityAt).toBe("string");
    });

    it("updates cached metrics when GET_METRICS response is received", async () => {
      queueChild({
        metricsResponse: {
          inFlightTasks: 12,
          activeAgents: 5,
          lastActivityAt: "2026-04-08T02:00:00.000Z",
        },
      });
      await runtime.start();

      runtime.getMetrics();

      await vi.waitFor(() => {
        expect(runtimeAny.lastMetrics).toEqual({
          inFlightTasks: 12,
          activeAgents: 5,
          lastActivityAt: "2026-04-08T02:00:00.000Z",
        });
      });
    });

    it("ignores GET_METRICS IPC errors and returns the last known metrics", async () => {
      queueChild({
        sendCallbackErrors: {
          [GET_METRICS]: new Error("metrics unavailable"),
        },
      });
      await runtime.start();

      runtimeAny.lastMetrics = {
        inFlightTasks: 21,
        activeAgents: 8,
        lastActivityAt: "2026-04-08T03:00:00.000Z",
      };

      const metrics = runtime.getMetrics();

      expect(metrics.inFlightTasks).toBe(21);
      expect(metrics.activeAgents).toBe(8);

      await Promise.resolve();
      expect(runtimeAny.lastMetrics).toEqual({
        inFlightTasks: 21,
        activeAgents: 8,
        lastActivityAt: "2026-04-08T03:00:00.000Z",
      });
    });

    it("logs warning when GET_METRICS IPC query fails", async () => {
      const warnSpy = vi.spyOn(runtimeLog, "warn").mockImplementation(() => {});

      queueChild({
        sendCallbackErrors: {
          [GET_METRICS]: new Error("metrics unavailable"),
        },
      });
      await runtime.start();

      runtimeAny.lastMetrics = {
        inFlightTasks: 1,
        activeAgents: 0,
        lastActivityAt: "2026-04-08T04:00:00.000Z",
      };

      const metrics = runtime.getMetrics();
      expect(metrics.inFlightTasks).toBe(1);
      expect(metrics.activeAgents).toBe(0);

      await vi.waitFor(() => {
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("GET_METRICS IPC query failed, using cached value"),
        );
      });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("metrics unavailable"));

      warnSpy.mockRestore();
    });

    it("getTaskStore() always throws not accessible error", () => {
      expect(() => runtime.getTaskStore()).toThrow("not accessible in ChildProcessRuntime");
    });

    it("getScheduler() always throws not accessible error", () => {
      expect(() => runtime.getScheduler()).toThrow("not accessible in ChildProcessRuntime");
    });
  });
});
