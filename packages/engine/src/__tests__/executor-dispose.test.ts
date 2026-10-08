/*
FNXC:ExecutorLifecycle 2026-10-08-07:20 (KB-049):
A replaced TaskExecutor (engine restart in place, project reload, test teardown) must never react to
store events again. Before KB-049 the four store listeners had no teardown, so an executor from one
shared-PG test started executions for the next test's KB-001. These cases pin the invariant on every
subscription surface: the four store events, the already-captured listener (fence), the store-scoped
disposer registries, and the chat-memory capture, plus idempotence and per-instance removal.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { getTaskMoveDisposer, type TaskStore } from "@fusion/core";
import { TaskExecutor } from "../executor.js";

const ROOT = "/tmp/fusion-test-executor-dispose-root";
const EVENTS = ["task:moved", "task:deleted", "task:updated", "settings:updated"] as const;

function createStore(): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    logEntry: vi.fn().mockResolvedValue(undefined),
    getRunContextFor: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({}),
    getTask: vi.fn().mockResolvedValue(undefined),
  }) as unknown as TaskStore & EventEmitter;
}

function counts(store: EventEmitter): Record<string, number> {
  return Object.fromEntries(EVENTS.map((event) => [event, store.listenerCount(event)]));
}

type Spies = {
  execute: ReturnType<typeof vi.spyOn>;
  abort: ReturnType<typeof vi.spyOn>;
  markPausedAborted: ReturnType<typeof vi.spyOn>;
};

function spyOnReactions(executor: TaskExecutor): Spies {
  /* eslint-disable @typescript-eslint/no-explicit-any -- private executor surface under test */
  const execute = vi.spyOn(executor as any, "execute").mockResolvedValue(undefined);
  vi.spyOn(executor as any, "resetMergeStateIfNeeded").mockImplementation(async (task: unknown) => task);
  vi.spyOn(executor as any, "isBackwardMoveOutOfPlanning").mockReturnValue(false);
  const abort = vi.spyOn(executor as any, "awaitAbortInFlightTaskWork").mockResolvedValue(undefined);
  const markPausedAborted = vi.spyOn(executor as any, "markPausedAborted").mockImplementation(() => undefined);
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return { execute, abort, markPausedAborted };
}

/** Seeds an active session and a configured-command controller so pause/global-pause branches fire. */
function seedActiveWork(executor: TaskExecutor, taskId: string): AbortController {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (executor as any).activeSessions.set(taskId, { session: { dispose: vi.fn() } });
  const controller = new AbortController();
  (executor as any).activeConfiguredCommandControllers.set(taskId, new Set([controller]));
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return controller;
}

/** Emits each of the four store events in a way that would drive an executor-side reaction. */
async function emitAll(store: TaskStore & EventEmitter, taskId: string): Promise<void> {
  store.emit("task:moved", { task: { id: taskId, column: "in-progress" }, from: "todo", to: "in-progress", source: "user" });
  store.emit("task:moved", { task: { id: taskId, column: "todo" }, from: "in-progress", to: "todo", source: "user" });
  store.emit("task:deleted", { id: taskId });
  store.emit("task:updated", { id: taskId, column: "in-progress", paused: true });
  store.emit("settings:updated", { settings: { globalPause: true }, previous: { globalPause: false } });
  await new Promise((resolve) => setImmediate(resolve));
}

describe("TaskExecutor.dispose (KB-049)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds exactly one listener per store event and dispose returns each count to its baseline", () => {
    const store = createStore();
    const baseline = counts(store);
    const executor = new TaskExecutor(store, ROOT);
    for (const event of EVENTS) expect(store.listenerCount(event)).toBe(baseline[event] + 1);
    executor.dispose();
    expect(counts(store)).toEqual(baseline);
  });

  it("reacts to all four events before dispose and to none after", async () => {
    const store = createStore();
    const executor = new TaskExecutor(store, ROOT);
    const spies = spyOnReactions(executor);

    // Control: the same emissions drive real reactions while the executor is live.
    const liveController = seedActiveWork(executor, "KB-001");
    await emitAll(store, "KB-001");
    expect(spies.execute).toHaveBeenCalledTimes(1);
    expect(spies.abort).toHaveBeenCalled();
    expect(spies.markPausedAborted).toHaveBeenCalled();
    expect(liveController.signal.aborted).toBe(true);

    executor.dispose();
    spies.execute.mockClear();
    spies.abort.mockClear();
    spies.markPausedAborted.mockClear();
    const disposedController = seedActiveWork(executor, "KB-002");
    await emitAll(store, "KB-002");

    expect(spies.execute).not.toHaveBeenCalled();
    expect(spies.abort).not.toHaveBeenCalled();
    expect(spies.markPausedAborted).not.toHaveBeenCalled();
    expect(disposedController.signal.aborted).toBe(false);
  });

  it("fences a listener captured before dispose so invoking it afterwards has no effect", async () => {
    const store = createStore();
    const executor = new TaskExecutor(store, ROOT);
    const spies = spyOnReactions(executor);
    const captured = store.rawListeners("task:moved")[0] as (payload: unknown) => unknown;

    executor.dispose();
    captured({ task: { id: "KB-003", column: "in-progress" }, from: "todo", to: "in-progress", source: "user" });
    captured({ task: { id: "KB-003", column: "todo" }, from: "in-progress", to: "todo", source: "user" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(spies.execute).not.toHaveBeenCalled();
    expect(spies.abort).not.toHaveBeenCalled();
  });

  it("clears the store-scoped move disposer and detaches the chat memory capture", () => {
    const store = createStore();
    const executor = new TaskExecutor(store, ROOT);
    const chat = new EventEmitter();
    executor.attachChatMemoryCapture(chat);
    expect(getTaskMoveDisposer(store)).toBeDefined();
    expect(chat.eventNames().length).toBeGreaterThan(0);

    executor.dispose();

    expect(getTaskMoveDisposer(store)).toBeUndefined();
    for (const event of chat.eventNames()) expect(chat.listenerCount(event)).toBe(0);
  });

  it("is idempotent and tolerates a store that cannot remove listeners", () => {
    const store = createStore();
    const executor = new TaskExecutor(store, ROOT);
    executor.dispose();
    expect(() => executor.dispose()).not.toThrow();

    const onOnly = Object.assign(Object.create(null), {
      on: vi.fn(),
      logEntry: vi.fn().mockResolvedValue(undefined),
      getSettings: vi.fn().mockResolvedValue({}),
    }) as unknown as TaskStore;
    const fakeExecutor = new TaskExecutor(onOnly, ROOT);
    expect(() => fakeExecutor.dispose()).not.toThrow();
    expect(() => fakeExecutor.dispose()).not.toThrow();
  });

  it("removes only its own listeners when two executors share one store", async () => {
    const store = createStore();
    const baseline = counts(store);
    const first = new TaskExecutor(store, ROOT);
    const second = new TaskExecutor(store, ROOT);
    const firstSpies = spyOnReactions(first);
    const secondSpies = spyOnReactions(second);

    first.dispose();
    for (const event of EVENTS) expect(store.listenerCount(event)).toBe(baseline[event] + 1);

    store.emit("task:moved", { task: { id: "KB-004", column: "in-progress" }, from: "todo", to: "in-progress", source: "user" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(firstSpies.execute).not.toHaveBeenCalled();
    expect(secondSpies.execute).toHaveBeenCalledTimes(1);

    second.dispose();
    expect(counts(store)).toEqual(baseline);
  });
});
