/*
FNXC:MergeRetryReliability 2026-10-10-22:57:
An interrupted merge is retried within the transient merge budget; it is never parked on a bare abort message.

Original symptom (KB-097): the graph's bounded auto-merge retry was rejected with "This operation was aborted" and the approved card was parked `AUTO_MERGE_RETRY_REJECTED: This operation was aborted` until an operator pressed Retry.

Surface enumeration (engine only, no UI):
- Every abort shape the merge pump can reject with: the provider's bare abort error, a DOM `AbortError`, and the engine's own `MergeAbortedError`.
- Budget states: unused, partly used, spent.
- Operator holds keep their handling: task pause, user pause, global pause, engine pause, and a card that left its lane.
- A rejection that is not an interruption keeps the immediate park.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "@fusion/core";
import { routeGraphMergeFailureToRetry } from "../executor/route-graph-merge-failure-to-retry.js";
import { MAX_AUTO_MERGE_TRANSIENT_RETRIES } from "../errors/transient-merge-error-classifier.js";

const now = "2026-10-10T22:12:31.000Z";

function named(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

const INTERRUPTIONS = [
  { label: "provider abort surfaced as a plain error", error: () => new Error("This operation was aborted") },
  { label: "DOM AbortError", error: () => named("AbortError", "The user aborted a request.") },
  { label: "engine MergeAbortedError", error: () => named("MergeAbortedError", "AI merge aborted for KB-097") },
] as const;

function harness(taskOverrides: Partial<TaskDetail> = {}, settings: Record<string, unknown> = {}) {
  const task = {
    id: "KB-097",
    column: "in-review",
    columnMovedAt: now,
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    autoMerge: true,
    mergeRetries: 0,
    ...taskOverrides,
  } as TaskDetail;
  const live = { ...task } as TaskDetail;
  const logs: string[] = [];
  const store = {
    logEntry: vi.fn(async (_id: string, line: string) => { logs.push(line); }),
    getTask: vi.fn(async () => task),
    getSettings: vi.fn(async () => ({ autoMerge: true, ...settings })),
    updateTaskAtomic: vi.fn(async (_id: string, reduce: (current: TaskDetail) => Partial<TaskDetail> | null) => {
      const patch = reduce(task);
      if (patch) Object.assign(task, patch);
      return task;
    }),
  };
  const mergeRequester = vi.fn();
  const route = () => routeGraphMergeFailureToRetry({
    store: store as never,
    getRunContextFor: () => undefined,
    mergeRequester,
    ensureWorkflowMergeBoundaryTask: async (boundaryTask) => ({ task: boundaryTask }),
    persistTokenUsage: async () => undefined,
  }, live, { disposition: "failed", outcome: "failure", value: "merge-timeout", visitedNodeIds: ["merge"], context: {} } as never, undefined);
  return { task, logs, mergeRequester, route };
}

async function settleWithTimers<T>(pending: Promise<T>): Promise<T> {
  let done = false;
  void pending.finally(() => { done = true; }).catch(() => undefined);
  while (!done) await vi.advanceTimersByTimeAsync(60_000);
  return pending;
}

describe("bounded auto-merge retry interrupted by an abort", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.for(INTERRUPTIONS)("re-requests the merge instead of parking ($label)", async ({ error }) => {
    const { task, mergeRequester, route } = harness();
    mergeRequester.mockRejectedValueOnce(error()).mockResolvedValue({ merged: true, task: { id: "KB-097" } });

    await expect(settleWithTimers(route())).resolves.toBe(true);

    expect(mergeRequester).toHaveBeenCalledTimes(2);
    expect(task.status).toBeNull();
    expect(task.error).toBeNull();
    expect(task.mergeTransientRetryCount).toBe(1);
  });

  it("parks with the spent budget named once the transient merge budget is used up", async () => {
    const { task, mergeRequester, route } = harness({ mergeTransientRetryCount: 2 } as Partial<TaskDetail>);
    mergeRequester.mockRejectedValue(new Error("This operation was aborted"));

    await expect(settleWithTimers(route())).resolves.toBe(true);

    expect(mergeRequester).toHaveBeenCalledTimes(1 + MAX_AUTO_MERGE_TRANSIENT_RETRIES - 2);
    expect(task.mergeTransientRetryCount).toBe(MAX_AUTO_MERGE_TRANSIENT_RETRIES);
    expect(task.status).toBe("failed");
    expect(task.error).toBe(
      `AUTO_MERGE_RETRY_REJECTED: merge was interrupted and the transient retry budget (${MAX_AUTO_MERGE_TRANSIENT_RETRIES}) is spent: This operation was aborted`,
    );
  });

  it.for([
    { label: "task pause", task: { paused: true }, settings: {}, parks: false },
    { label: "user pause", task: { userPaused: true }, settings: {}, parks: false },
    { label: "global pause", task: {}, settings: { globalPause: true }, parks: true },
    { label: "engine pause", task: {}, settings: { enginePaused: true }, parks: true },
  ] as const)("does not re-request under an operator hold ($label)", async ({ task: overrides, settings, parks }) => {
    const { task, mergeRequester, route } = harness(overrides as Partial<TaskDetail>, settings);
    mergeRequester.mockRejectedValue(named("MergeAbortedError", "Merge aborted for KB-097: pause or cancel requested"));

    await expect(settleWithTimers(route())).resolves.toBe(true);

    expect(mergeRequester).toHaveBeenCalledTimes(1);
    expect(task.mergeTransientRetryCount).toBeUndefined();
    expect(task.status).toBe(parks ? "failed" : null);
  });

  it("does not re-request for a card that left its lane while the merge ran", async () => {
    const { task, mergeRequester, route } = harness();
    mergeRequester.mockImplementation(async () => {
      task.columnMovedAt = "2026-10-10T22:20:00.000Z";
      throw new Error("This operation was aborted");
    });

    await expect(settleWithTimers(route())).resolves.toBe(true);

    expect(mergeRequester).toHaveBeenCalledTimes(1);
    expect(task.status).toBeNull();
  });

  it("parks at once on a rejection that is not an interruption", async () => {
    const { task, mergeRequester, route } = harness();
    mergeRequester.mockRejectedValue(new Error("Cannot merge KB-097: task is marked 'needs-replan'"));

    await expect(settleWithTimers(route())).resolves.toBe(true);

    expect(mergeRequester).toHaveBeenCalledTimes(1);
    expect(task.error).toBe("AUTO_MERGE_RETRY_REJECTED: Cannot merge KB-097: task is marked 'needs-replan'");
  });
});
