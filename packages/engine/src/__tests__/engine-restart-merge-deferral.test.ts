// @ts-nocheck
/*
FNXC:MergeRestartDeferral 2026-10-08-06:10:
An engine restart is never a merge failure.

Original symptom (KB-020, KB-024): a supervised restart rejected every pending merge with "Engine shutting down — merge for <id> aborted", and the
dying engine refused new enqueues with "Merge enqueue rejected for <id>". The graph failure handler routed the first rejection to the bounded
auto-merge retry, the retry's own request was refused the same way, and the card was parked `failed` with `AUTO_MERGE_RETRY_REJECTED:`. Nothing
recovered that park, so 21 of 24 review cards sat dead after a morning of restarts.

Surface enumeration (engine only, no UI):
- Both merge-requester call sites: the `requestMerge` runtime primitive and the legacy merge seam.
- The merge-attempt runner, whose classifier must preserve the typed shutdown value.
- The graph failure handler, reached with the typed value from either call site.
- The bounded retry router, reached after a pause/resume abort and after an ordinary merge failure, for both shutdown rejection shapes
  (a pending request rejected by stop, and an enqueue refused while shutting down).
- Any other requester rejection keeps today's park.
*/
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { primitiveNodeContext } from "../execution/runtime-primitives.js";
import { classifyMergePrimitiveResult } from "../workflows/workflow-merge-nodes.js";
import { createMergeAttemptHandler } from "../workflow-node-runners/merge-runner.js";
import { routeGraphMergeFailureToRetry } from "../executor/route-graph-merge-failure-to-retry.js";
import { createMockStore, mockedExistsSync, resetExecutorMocks } from "./executor-test-helpers.js";

const now = "2026-10-08T06:10:00.000Z";

/** The shape ProjectEngine rejects with while it is stopping or not yet started. */
function engineShutdown(message: string): Error {
  const error = new Error(message);
  error.name = "EngineShutdownError";
  return error;
}

const SHUTDOWN_REJECTIONS = [
  { label: "pending request rejected by stop()", error: () => engineShutdown("Engine shutting down — merge for KB-020 aborted") },
  { label: "enqueue refused while shutting down", error: () => engineShutdown("Merge enqueue rejected for KB-020: engine is shutting down") },
  { label: "deferred merge rejected by stop()", error: () => engineShutdown("Engine shutting down — deferred merge for KB-020 aborted") },
] as const;

function approvedReviewCard(overrides = {}) {
  return {
    id: "KB-020",
    title: "Approved card whose merge was interrupted by a restart",
    description: "an engine restart must never park this card",
    column: "in-review",
    dependencies: [],
    steps: [{ name: "Implement", status: "done" }],
    currentStep: 1,
    log: [],
    branch: "fusion/kb-020",
    baseBranch: "main",
    worktree: null,
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    autoMerge: true,
    mergeRetries: 0,
    enabledWorkflowSteps: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function harness(liveOverrides = {}) {
  const worktree = await mkdtemp(join(tmpdir(), "fusion-restart-merge-wt-"));
  const live = approvedReviewCard({ worktree, ...liveOverrides });
  const store = createMockStore();
  store.getTask.mockResolvedValue(live);
  store.moveTask.mockResolvedValue(live);
  store.getSettings.mockResolvedValue({ autoMerge: true, maxAutoMergeRetries: 3, maxConcurrent: 2, maxWorktrees: 4, pollIntervalMs: 15000 });
  store.updateTaskAtomic = vi.fn(async (id, reducer, context) => {
    const patch = reducer(live);
    return patch ? store.updateTask(id, patch, context) : live;
  });
  const executor = new TaskExecutor(store, await mkdtemp(join(tmpdir(), "fusion-restart-merge-root-")), {});
  return { store, executor, live };
}

function mergeCtx(nodeId = "merge") {
  return primitiveNodeContext(
    { runId: "KB-020:run", taskId: "KB-020", workflowId: "builtin:coding" },
    { id: nodeId, kind: "prompt" },
    {},
    undefined,
  );
}

function failedPatches(store) {
  return store.updateTask.mock.calls.filter(([, patch]) => patch?.status === "failed");
}

function lifecyclePatches(store) {
  return store.updateTask.mock.calls.filter(([, patch]) =>
    patch && ("status" in patch || "error" in patch || "mergeRetries" in patch || "paused" in patch || "column" in patch));
}

function deferralLines(store) {
  return store.logEntry.mock.calls.map((call) => call[1]).filter((line) => /resume after (the )?engine restart/.test(String(line)));
}

describe("an engine restart is never a merge failure", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it.for(SHUTDOWN_REJECTIONS)("the requestMerge primitive returns a typed shutdown value instead of throwing ($label)", async ({ error }) => {
    const { executor, live } = await harness();
    const rejection = error();
    const requester = vi.fn().mockRejectedValue(rejection);
    executor.setMergeRequester(requester);

    const result = await executor.createAuthoritativeWorkflowPrimitives({ autoMerge: true }).requestMerge(mergeCtx(), live);

    expect(result).toMatchObject({ outcome: "failure", value: "engine-shutdown" });
    expect(requester).toHaveBeenCalledTimes(1);
  });

  it("the legacy merge seam returns the same typed shutdown value", async () => {
    const { executor, live } = await harness();
    const requester = vi.fn().mockRejectedValue(engineShutdown("Engine shutting down — merge for KB-020 aborted"));
    executor.setMergeRequester(requester);

    const result = await executor.createAuthoritativeWorkflowSeams({ autoMerge: true }).merge(live, {}, undefined);

    expect(result).toMatchObject({ outcome: "failure", value: "engine-shutdown" });
    expect(requester).toHaveBeenCalledTimes(1);
  });

  it("the merge-attempt runner keeps the typed shutdown value", async () => {
    const { executor, live } = await harness();
    executor.setMergeRequester(vi.fn().mockRejectedValue(engineShutdown("Engine shutting down — merge for KB-020 aborted")));
    const handler = createMergeAttemptHandler({
      primitives: executor.createAuthoritativeWorkflowPrimitives({ autoMerge: true }),
      seams: { merge: vi.fn() },
      buildPrimitiveContext: (node) => mergeCtx(node.id),
    });

    const result = await handler({ id: "merge-attempt", kind: "merge-attempt" }, { task: live, settings: undefined, context: {}, signal: undefined });

    expect(result).toMatchObject({ outcome: "failure", value: "engine-shutdown", contextPatch: { "workflow:merge-status": "engine-shutdown" } });
    expect(classifyMergePrimitiveResult({ status: "failed", reason: "Engine shutting down — merge for KB-020 aborted" }, "engine-shutdown", "failure"))
      .toEqual({ outcome: "failure", value: "engine-shutdown" });
  });

  it.for(["merge", "merge-attempt"])("the graph failure handler leaves a shutdown-interrupted card untouched for re-dispatch (node %s)", async (nodeId) => {
    const { executor, store } = await harness();
    const requester = vi.fn();
    executor.setMergeRequester(requester);
    const retry = vi.spyOn(executor as any, "routeGraphMergeFailureToRetry");

    await (executor as any).handleGraphFailure(approvedReviewCard(), {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["review", nodeId],
      context: { [`node:${nodeId}:value`]: "engine-shutdown" },
    });

    expect(retry).not.toHaveBeenCalled();
    expect(requester).not.toHaveBeenCalled();
    expect(lifecyclePatches(store)).toEqual([]);
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
    expect(deferralLines(store)).toHaveLength(1);
  });

  it("the graph failure handler defers a shutdown even when the run also carries a pause/resume abort marker", async () => {
    const { executor, store } = await harness();
    executor.setMergeRequester(vi.fn());
    (executor as any).markPausedAborted("KB-020", "pause-resume");

    await (executor as any).handleGraphFailure(approvedReviewCard(), {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["review", "merge"],
      context: { "node:merge:value": "engine-shutdown" },
    });

    expect(failedPatches(store)).toEqual([]);
    expect(lifecyclePatches(store)).toEqual([]);
    expect(deferralLines(store)).toHaveLength(1);
  });

  it.for(SHUTDOWN_REJECTIONS)("the bounded retry after a pause/resume abort does not park when the engine is shutting down ($label)", async ({ error }) => {
    const { executor, store } = await harness();
    const requester = vi.fn().mockRejectedValue(error());
    executor.setMergeRequester(requester);
    (executor as any).markPausedAborted("KB-020", "pause-resume");

    await (executor as any).handleGraphFailure(approvedReviewCard(), {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["review", "merge"],
      context: {},
    });

    expect(requester).toHaveBeenCalledTimes(1);
    expect(failedPatches(store)).toEqual([]);
    expect(lifecyclePatches(store)).toEqual([]);
    expect(deferralLines(store)).toHaveLength(1);
    const logText = store.logEntry.mock.calls.map((call) => call[1]).join("\n");
    expect(logText).not.toContain("parking task for human intervention");
  });

  it.for(SHUTDOWN_REJECTIONS)("the bounded retry after an ordinary merge failure does not park when the engine is shutting down ($label)", async ({ error }) => {
    const live = approvedReviewCard();
    const store = { logEntry: vi.fn(), updateTask: vi.fn(), updateTaskAtomic: vi.fn() };
    const persistTokenUsage = vi.fn();

    const handled = await routeGraphMergeFailureToRetry({
      store,
      getRunContextFor: () => undefined,
      mergeRequester: vi.fn().mockRejectedValue(error()),
      ensureWorkflowMergeBoundaryTask: vi.fn().mockResolvedValue({ task: live }),
      persistTokenUsage,
    }, live, { visitedNodeIds: ["merge"], context: { "node:merge:value": "merge-failed" } }, undefined);

    expect(handled).toBe(true);
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(deferralLines(store)).toHaveLength(1);
    expect(persistTokenUsage).toHaveBeenCalledTimes(1);
  });

  it("still parks a non-shutdown requester rejection exactly as before", async () => {
    const { executor, store } = await harness();
    executor.setMergeRequester(vi.fn().mockRejectedValue(new Error("Cannot merge KB-020: task is marked 'needs-replan'")));
    (executor as any).markPausedAborted("KB-020", "pause-resume");

    await (executor as any).handleGraphFailure(approvedReviewCard(), {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["review", "merge"],
      context: {},
    });

    const parks = failedPatches(store);
    expect(parks).toHaveLength(1);
    expect(parks[0][1].error).toBe("AUTO_MERGE_RETRY_REJECTED: Cannot merge KB-020: task is marked 'needs-replan'");
    expect(deferralLines(store)).toEqual([]);
  });

  it("treats an unnamed error whose text merely mentions shutdown as an ordinary rejection", async () => {
    const live = approvedReviewCard();
    const store = { logEntry: vi.fn(), updateTask: vi.fn(), updateTaskAtomic: vi.fn(async (_id, reducer) => reducer(live)) };

    await routeGraphMergeFailureToRetry({
      store,
      getRunContextFor: () => undefined,
      mergeRequester: vi.fn().mockRejectedValue(new Error("Engine shutting down — merge for KB-020 aborted")),
      ensureWorkflowMergeBoundaryTask: vi.fn().mockResolvedValue({ task: live }),
      persistTokenUsage: vi.fn(),
    }, live, { visitedNodeIds: ["merge"], context: { "node:merge:value": "merge-failed" } }, undefined);

    expect(store.updateTaskAtomic).toHaveBeenCalledTimes(1);
    expect(deferralLines(store)).toEqual([]);
  });
});
