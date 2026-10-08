import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { InProcessRuntime } from "../../runtimes/in-process-runtime.js";
import { TaskExecutor } from "../../executor.js";

const STORE_EVENTS = ["task:moved", "task:deleted", "task:updated", "settings:updated"] as const;

/** EventEmitter-backed store that a real TaskExecutor can wire onto and a runtime can stop against. */
function makeEmitterStore() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    logEntry: vi.fn().mockResolvedValue(undefined),
    getRunContextFor: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({ runtimeStopDrainMs: 1 }),
    getTask: vi.fn().mockResolvedValue(undefined),
  });
}

function listenerCounts(store: EventEmitter): Record<string, number> {
  return Object.fromEntries(STORE_EVENTS.map((event) => [event, store.listenerCount(event)]));
}

function makeExecutor(overrides: Record<string, unknown> = {}) {
  return {
    activeWorktrees: new Map(),
    abortAllSessionBash: vi.fn(),
    abortAllInFlight: vi.fn().mockResolvedValue(undefined),
    disposeEphemeralTimers: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  };
}

describe("FN-5403 reliability interactions: engine stop aborts execution", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("closes every runtime admission source without aborting active execution", () => {
    const runtime = new InProcessRuntime({ projectId: "p", workingDirectory: "/tmp", isolationMode: "in-process" } as any, {} as any) as any;
    runtime.status = "active";
    runtime.workflowContinuationTimer = setInterval(() => undefined, 1_000);
    runtime.selfHealingManager = { stop: vi.fn() };
    runtime.routineScheduler = { stop: vi.fn() };
    runtime.triggerScheduler = { stop: vi.fn() };
    runtime.stuckTaskDetector = { stop: vi.fn() };
    runtime.heartbeatMonitor = { stop: vi.fn() };
    runtime.triageProcessor = { stop: vi.fn() };
    runtime.scheduler = { stop: vi.fn() };
    runtime.missionAutopilot = { stop: vi.fn() };
    runtime.missionExecutionLoop = { stop: vi.fn() };
    runtime.executor = makeExecutor();

    runtime.beginDrain();

    expect(runtime.getStatus()).toBe("paused");
    expect(runtime.workflowContinuationTimer).toBeUndefined();
    for (const source of [
      runtime.selfHealingManager,
      runtime.routineScheduler,
      runtime.triggerScheduler,
      runtime.stuckTaskDetector,
      runtime.heartbeatMonitor,
      runtime.triageProcessor,
      runtime.scheduler,
      runtime.missionAutopilot,
      runtime.missionExecutionLoop,
    ]) {
      expect(source.stop).toHaveBeenCalledOnce();
    }
    expect(runtime.executor.abortAllInFlight).not.toHaveBeenCalled();
  });

  it("continues closing admission sources when one stop throws", () => {
    const runtime = new InProcessRuntime({ projectId: "p", workingDirectory: "/tmp", isolationMode: "in-process" } as any, {} as any) as any;
    runtime.status = "active";
    runtime.selfHealingManager = { stop: vi.fn(() => {
      throw new Error("stop failed");
    }) };
    runtime.routineScheduler = { stop: vi.fn() };

    expect(() => runtime.beginDrain()).not.toThrow();

    expect(runtime.selfHealingManager.stop).toHaveBeenCalledOnce();
    expect(runtime.routineScheduler.stop).toHaveBeenCalledOnce();
  });

  it("FN-5403: engine stop aborts executor AI sessions before drain completes", async () => {
    const runtime = new InProcessRuntime({ projectId: "p", workingDirectory: "/tmp", isolationMode: "in-process" } as any, {} as any) as any;
    let aborted = false;
    let disposed = false;
    runtime.status = "active";
    runtime.taskStore = { getSettings: vi.fn().mockResolvedValue({ runtimeStopDrainMs: 1 }) };
    runtime.pluginRunner = { shutdown: vi.fn().mockResolvedValue(undefined) };
    runtime.worktreePool = { drain: vi.fn().mockReturnValue([]) };
    runtime.executor = makeExecutor({
      abortAllInFlight: vi.fn().mockImplementation(async () => {
        aborted = true;
        disposed = true;
      }),
    });

    await runtime.stop();
    expect(aborted).toBe(true);
    expect(disposed).toBe(true);
  });

  it("FN-5403: engine stop does not wait the legacy 30 s for natural completion", async () => {
    const runtime = new InProcessRuntime({ projectId: "p", workingDirectory: "/tmp", isolationMode: "in-process" } as any, {} as any) as any;
    runtime.status = "active";
    runtime.taskStore = { getSettings: vi.fn().mockResolvedValue({ runtimeStopDrainMs: 10 }) };
    runtime.pluginRunner = { shutdown: vi.fn().mockResolvedValue(undefined) };
    runtime.worktreePool = { drain: vi.fn().mockReturnValue([]) };
    runtime.executor = makeExecutor({ activeWorktrees: new Map([["FN-1", { taskId: "FN-1" }]]) });

    const stopPromise = runtime.stop();
    await vi.advanceTimersByTimeAsync(50);
    await expect(stopPromise).resolves.toBeUndefined();
  });

  it("FN-5403: engine stop interacts with TriageProcessor.stop", async () => {
    const runtime = new InProcessRuntime({ projectId: "p", workingDirectory: "/tmp", isolationMode: "in-process" } as any, {} as any) as any;
    runtime.status = "active";
    const triageSessions = new Map([["FN-T", {}]]);
    runtime.triageProcessor = { stop: vi.fn().mockImplementation(() => triageSessions.clear()) };
    runtime.taskStore = { getSettings: vi.fn().mockResolvedValue({ runtimeStopDrainMs: 0 }) };
    runtime.pluginRunner = { shutdown: vi.fn().mockResolvedValue(undefined) };
    runtime.worktreePool = { drain: vi.fn().mockReturnValue([]) };
    runtime.executor = makeExecutor();

    await runtime.stop();
    expect(runtime.triageProcessor.stop).toHaveBeenCalledTimes(1);
    expect(runtime.executor.abortAllInFlight).toHaveBeenCalledWith("engine stop");
    expect(triageSessions.size).toBe(0);
  });

  it("FN-5403: engine stop preserves task:moved cleanup contract", async () => {
    const runtime = new InProcessRuntime({ projectId: "p", workingDirectory: "/tmp", isolationMode: "in-process" } as any, {} as any) as any;
    runtime.status = "active";
    const updateTask = vi.fn();
    const moveTask = vi.fn();
    runtime.taskStore = { getSettings: vi.fn().mockResolvedValue({ runtimeStopDrainMs: 0 }), updateTask, moveTask };
    runtime.pluginRunner = { shutdown: vi.fn().mockResolvedValue(undefined) };
    runtime.worktreePool = { drain: vi.fn().mockReturnValue([]) };
    runtime.executor = makeExecutor();

    await runtime.stop();
    expect(updateTask).not.toHaveBeenCalled();
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("FN-5403: engine stop with runtimeStopDrainMs=0 still aborts before exiting", async () => {
    const runtime = new InProcessRuntime({ projectId: "p", workingDirectory: "/tmp", isolationMode: "in-process" } as any, {} as any) as any;
    runtime.status = "active";
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    runtime.taskStore = { getSettings: vi.fn().mockResolvedValue({ runtimeStopDrainMs: 0 }) };
    runtime.pluginRunner = { shutdown: vi.fn().mockResolvedValue(undefined) };
    runtime.worktreePool = { drain: vi.fn().mockReturnValue([]) };
    runtime.executor = makeExecutor({ activeWorktrees: new Map([["FN-1", { taskId: "FN-1" }]]) });

    await runtime.stop();
    expect(runtime.executor.abortAllInFlight).toHaveBeenCalledWith("engine stop");
    expect(timeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 500);
  });

  it("releases the PostgreSQL backend exactly once when an earlier cleanup step fails", async () => {
    const runtime = new InProcessRuntime({ projectId: "p", workingDirectory: "/tmp", isolationMode: "in-process" } as any, {} as any) as any;
    const backendShutdown = vi.fn().mockResolvedValue(undefined);
    runtime.status = "active";
    runtime.backendShutdown = backendShutdown;
    runtime.taskStore = { getSettings: vi.fn().mockRejectedValue(new Error("settings unavailable")) };
    runtime.executor = makeExecutor();

    await expect(runtime.stop()).rejects.toThrow("settings unavailable");
    expect(backendShutdown).toHaveBeenCalledTimes(1);

    await runtime.stop().catch(() => undefined);
    expect(backendShutdown).toHaveBeenCalledTimes(1);
  });
  /*
  FNXC:ExecutorLifecycle 2026-10-08-08:13 (KB-049):
  A stopped or replaced runtime executor must release its store subscriptions, even when aborting in-flight work rejects, because the store can outlive the runtime across a restart in place.
  */
  it("KB-049: stop disposes the executor after aborting in-flight work", async () => {
    const runtime = new InProcessRuntime({ projectId: "p", workingDirectory: "/tmp", isolationMode: "in-process" } as any, {} as any) as any;
    const order: string[] = [];
    runtime.status = "active";
    runtime.taskStore = { getSettings: vi.fn().mockResolvedValue({ runtimeStopDrainMs: 1 }) };
    runtime.pluginRunner = { shutdown: vi.fn().mockResolvedValue(undefined) };
    runtime.worktreePool = { drain: vi.fn().mockReturnValue([]) };
    const executor = makeExecutor({
      abortAllInFlight: vi.fn().mockImplementation(async () => { order.push("abort"); }),
      dispose: vi.fn(() => { order.push("dispose"); }),
    });
    runtime.executor = executor;

    await runtime.stop();
    expect(executor.dispose).toHaveBeenCalledOnce();
    expect(order).toEqual(["abort", "dispose"]);
  });

  it("KB-049: stop still disposes the executor when abortAllInFlight rejects", async () => {
    const runtime = new InProcessRuntime({ projectId: "p", workingDirectory: "/tmp", isolationMode: "in-process" } as any, {} as any) as any;
    runtime.status = "active";
    runtime.taskStore = { getSettings: vi.fn().mockResolvedValue({ runtimeStopDrainMs: 1 }) };
    runtime.pluginRunner = { shutdown: vi.fn().mockResolvedValue(undefined) };
    runtime.worktreePool = { drain: vi.fn().mockReturnValue([]) };
    const executor = makeExecutor({ abortAllInFlight: vi.fn().mockRejectedValue(new Error("abort failed")) });
    runtime.executor = executor;

    await runtime.stop();
    expect(executor.dispose).toHaveBeenCalledOnce();
  });

  it("KB-049: stop removes a real executor's store listeners and it ignores later moves", async () => {
    const runtime = new InProcessRuntime({ projectId: "p", workingDirectory: "/tmp", isolationMode: "in-process" } as any, {} as any) as any;
    const store = makeEmitterStore();
    const baseline = listenerCounts(store);
    const executor = new TaskExecutor(store as any, "/tmp/fusion-test-kb049-runtime");
    for (const event of STORE_EVENTS) expect(store.listenerCount(event)).toBe(baseline[event] + 1);
    const execute = vi.spyOn(executor as any, "execute").mockResolvedValue(undefined);
    vi.spyOn(executor as any, "resetMergeStateIfNeeded").mockImplementation(async (task: unknown) => task);
    runtime.status = "active";
    runtime.taskStore = store;
    runtime.pluginRunner = { shutdown: vi.fn().mockResolvedValue(undefined) };
    runtime.worktreePool = { drain: vi.fn().mockReturnValue([]) };
    runtime.executor = executor;

    await runtime.stop();

    expect(listenerCounts(store)).toEqual(baseline);
    store.emit("task:moved", { task: { id: "KB-001", column: "in-progress" }, from: "todo", to: "in-progress", source: "user" });
    await Promise.resolve();
    expect(execute).not.toHaveBeenCalled();
  });

  it("KB-049: replacing the executor disposes the previous one", () => {
    const runtime = new InProcessRuntime({ projectId: "p", workingDirectory: "/tmp", isolationMode: "in-process" } as any, {} as any) as any;
    const store = makeEmitterStore();
    const baseline = listenerCounts(store);
    const previous = new TaskExecutor(store as any, "/tmp/fusion-test-kb049-runtime");
    runtime.replaceExecutor(previous);
    const previousMoved = store.rawListeners("task:moved").at(-1);
    const next = new TaskExecutor(store as any, "/tmp/fusion-test-kb049-runtime");

    runtime.replaceExecutor(next);

    expect(runtime.getExecutor()).toBe(next);
    for (const event of STORE_EVENTS) expect(store.listenerCount(event)).toBe(baseline[event] + 1);
    expect(store.rawListeners("task:moved")).not.toContain(previousMoved);
    next.dispose();
    expect(listenerCounts(store)).toEqual(baseline);
  });
});
