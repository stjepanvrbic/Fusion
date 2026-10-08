// @ts-nocheck
/*
FNXC:FileScopeInvariant 2026-10-08-05:09:
A squash the file-scope invariant refused is a verdict on the candidate, so no retry can change it.

Original symptom (KB-008): the reviewer approved the squash twice, the invariant refused it, and the refusal escaped the graph merge primitive as an exception. The graph's per-node retry re-requested the merge. That request waited behind the full concurrency cap until the 30-minute primitive timeout. The bounded auto-merge retry then ran a third, full AI merge before the card was finally parked, so the lane went quiet for about 1h47m.

Surface enumeration (engine only, no UI):
- Both requester call sites: the `requestMerge` runtime primitive and the legacy merge seam.
- The merge-attempt runner, whose classifier must preserve the typed value and the free-text reason.
- The graph failure handler: a terminal park carrying the refusal text, never a bounded retry.
- Any other requester rejection keeps its existing exception path.
*/
import { describe, it, expect, vi, beforeEach } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { primitiveNodeContext } from "../execution/runtime-primitives.js";
import { classifyMergePrimitiveResult } from "../workflows/workflow-merge-nodes.js";
import { createMergeAttemptHandler } from "../workflow-node-runners/merge-runner.js";
import { isTerminalMergeGraphFailureValue } from "../executor/task-predicates.js";
import { routeGraphMergeFailureToRetry } from "../executor/route-graph-merge-failure-to-retry.js";
import { FileScopeViolationError } from "../merge/merger-file-scope.js";
import { createMockStore, mockedExistsSync, resetExecutorMocks } from "./executor-test-helpers.js";

const now = "2026-10-08T05:09:00.000Z";

function mergeReadyTask(overrides = {}) {
  return {
    id: "KB-008",
    title: "Approved squash refused by the file-scope invariant",
    description: "exercise the terminal file-scope refusal at the merge node",
    column: "in-review",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    noCommitsExpected: true,
    branch: null,
    worktree: null,
    status: null,
    error: null,
    autoMerge: true,
    enabledWorkflowSteps: [],
    workflowStepResults: [{
      workflowStepId: "execute",
      workflowStepName: "Execute",
      source: "node",
      phase: "pre-merge",
      status: "passed",
      completedAt: now,
    }],
    prompt: "# Task\n\n## Steps\n\n### Step 1: Decide\n- [ ] Record no-code decision",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function harness(liveTask = mergeReadyTask()) {
  const store = createMockStore();
  store.getTask.mockResolvedValue(liveTask);
  store.moveTask.mockResolvedValue(liveTask);
  store.getSettings.mockResolvedValue({ autoMerge: true, maxAutoMergeRetries: 3, maxConcurrent: 2, maxWorktrees: 4 });
  const executor = new TaskExecutor(store, "/tmp/test");
  return { store, executor, liveTask };
}

function violation() {
  return new FileScopeViolationError(
    "KB-008",
    ["packages/core/src/process/process-supervisor.ts", "packages/engine/src/execution/branch-conflicts.ts"],
    ["packages/dashboard/src/__tests__/task-reset-lifecycle.test.ts"],
  );
}

function mergeCtx(nodeId = "merge") {
  return primitiveNodeContext(
    { runId: "KB-008:run", taskId: "KB-008", workflowId: "builtin:coding" },
    { id: nodeId, kind: "prompt" },
    {},
    undefined,
  );
}

describe("an approved squash refused by the file-scope invariant", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("returns a typed terminal failure from the requestMerge primitive instead of throwing into the node retry", async () => {
    const { executor, liveTask } = harness();
    const error = violation();
    const requester = vi.fn().mockRejectedValue(error);
    executor.setMergeRequester(requester);

    const result = await executor
      .createAuthoritativeWorkflowPrimitives({ autoMerge: true })
      .requestMerge(mergeCtx(), liveTask);

    expect(result).toMatchObject({
      outcome: "failure",
      value: "file-scope-violation",
      data: { status: "failed", reason: error.message },
      contextPatch: { "node:merge:error": error.message },
    });
    expect(requester).toHaveBeenCalledTimes(1);
  });

  it("returns the same typed terminal failure from the legacy merge seam", async () => {
    const { executor, liveTask } = harness();
    const error = violation();
    const requester = vi.fn().mockRejectedValue(error);
    executor.setMergeRequester(requester);

    const result = await executor
      .createAuthoritativeWorkflowSeams({ autoMerge: true })
      .merge(liveTask, {}, undefined);

    expect(result).toMatchObject({
      outcome: "failure",
      value: "file-scope-violation",
      contextPatch: { "node:merge:error": error.message },
    });
    expect(requester).toHaveBeenCalledTimes(1);
  });

  it("keeps the typed value and the refusal text through the merge-attempt runner", async () => {
    const { executor } = harness();
    const error = violation();
    executor.setMergeRequester(vi.fn().mockRejectedValue(error));
    const primitives = executor.createAuthoritativeWorkflowPrimitives({ autoMerge: true });
    const handler = createMergeAttemptHandler({
      primitives,
      seams: { merge: vi.fn() },
      buildPrimitiveContext: (node) => mergeCtx(node.id),
    });

    const result = await handler({ id: "merge-attempt", kind: "merge-attempt" }, {
      task: mergeReadyTask(),
      settings: undefined,
      context: {},
      signal: undefined,
    });

    expect(result).toMatchObject({
      outcome: "failure",
      value: "file-scope-violation",
      contextPatch: { "node:merge-attempt:error": error.message, "workflow:merge-status": "file-scope-violation" },
    });
  });

  it("classifies the real invariant message as a file-scope violation, not a conflict hold", () => {
    expect(classifyMergePrimitiveResult({ status: "failed", reason: violation().message }, undefined, "failure")).toEqual({
      outcome: "failure",
      value: "file-scope-violation",
    });
    expect(classifyMergePrimitiveResult({ status: "failed", reason: "x" }, "file-scope-violation", "failure")).toEqual({
      outcome: "failure",
      value: "file-scope-violation",
    });
    expect(isTerminalMergeGraphFailureValue("file-scope-violation")).toBe(true);
  });

  it("keeps the exception path for any other requester rejection", async () => {
    const { executor, liveTask } = harness();
    executor.setMergeRequester(vi.fn().mockRejectedValue(new Error("Merge enqueue rejected for KB-008")));

    await expect(executor
      .createAuthoritativeWorkflowPrimitives({ autoMerge: true })
      .requestMerge(mergeCtx(), liveTask)).rejects.toThrow("Merge enqueue rejected for KB-008");
  });

  it("parks the card failed with the refusal text and never re-requests the merge", async () => {
    const { executor, store, liveTask } = harness();
    const error = violation();
    const requester = vi.fn();
    executor.setMergeRequester(requester);
    const retryMerge = vi.spyOn(executor as any, "routeGraphMergeFailureToRetry");

    await (executor as any).handleGraphFailure(liveTask, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["merge"],
      context: { "node:merge:value": "file-scope-violation", "node:merge:error": error.message },
    });

    expect(retryMerge).not.toHaveBeenCalled();
    expect(requester).not.toHaveBeenCalled();
    const failedPark = store.updateTask.mock.calls.find(([, patch]) => patch?.status === "failed");
    expect(failedPark?.[0]).toBe("KB-008");
    expect(failedPark?.[1].error).toContain("(file-scope-violation) — operator action required");
    expect(failedPark?.[1].error).toContain(error.message);
  });

  /*
  KB-008's second request ended by the 30-minute primitive timeout, yet the retry line read "after benign pause/resume abort".
  A retry that no pause caused must name the failure value it is retrying.
  */
  it("names the failure value, not a pause, when a non-pause merge failure is retried", async () => {
    const logEntry = vi.fn();
    const live = mergeReadyTask();
    await routeGraphMergeFailureToRetry({
      store: { logEntry, updateTaskAtomic: vi.fn() },
      getRunContextFor: () => undefined,
      mergeRequester: vi.fn().mockResolvedValue({ merged: true }),
      ensureWorkflowMergeBoundaryTask: vi.fn().mockResolvedValue({ task: live }),
      persistTokenUsage: vi.fn(),
    }, live, {
      visitedNodeIds: ["merge"],
      context: { "node:merge:value": "merge-timeout" },
    }, undefined);

    const line = logEntry.mock.calls[0]?.[1];
    expect(line).toContain("routed to bounded auto-merge retry after merge-timeout");
    expect(line).not.toContain("pause/resume");

    logEntry.mockClear();
    await routeGraphMergeFailureToRetry({
      store: { logEntry, updateTaskAtomic: vi.fn() },
      getRunContextFor: () => undefined,
      mergeRequester: vi.fn().mockResolvedValue({ merged: true }),
      ensureWorkflowMergeBoundaryTask: vi.fn().mockResolvedValue({ task: live }),
      persistTokenUsage: vi.fn(),
    }, live, { visitedNodeIds: ["merge"], context: { "node:merge:value": "aborted" } }, "engine-abort");
    expect(logEntry.mock.calls[0]?.[1]).toContain("after benign pause/resume abort");
  });
});
