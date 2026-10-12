// @ts-nocheck
/*
FNXC:MergeRunTimeout 2026-10-10-22:47:
The graph merge node's 30-minute bound exists to catch a hung merge. It must measure the merge's own run, never the wait behind other merges or for a capacity slot.

Original symptom (KB-097, KB-057): a card approved while two other merges were queued ahead of it waited 21 minutes for the single-flight merge pump, ran for 9 minutes, and was aborted exactly 30 minutes after the request as `merge-timeout`.

Surface enumeration (engine only, no UI):
- Both merge-requester call sites: the `requestMerge` runtime primitive and the legacy merge seam.
- Queue wait with no run start, a run that starts late, and a run that restarts on a new integration tip.
- The bound still fires for a merge that started and then hangs, and still aborts that merge on the primitive.
- A merge that settles clears the bound.

FNXC:MergeLandingCommitPoint 2026-10-12-10:05:
The bound stops when the merge reports that its landing started (KB-146 timed out three seconds after main fast-forwarded).
Covered on both call sites: a landing tail never times out or aborts the merge, a run that never reaches landing is still bounded, a rebuild after landing started re-arms the bound, and a graph abort during the tail still cancels.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { primitiveNodeContext } from "../execution/runtime-primitives.js";
import { GRAPH_MERGE_RUN_TIMEOUT_MS } from "../executor/merge-run-timeout.js";
import { createMockStore, mockedExistsSync, resetExecutorMocks } from "./executor-test-helpers.js";

const now = "2026-10-10T21:42:30.000Z";
const MINUTE = 60_000;

function approvedCard() {
  return {
    id: "KB-097",
    title: "Approved card queued behind other merges",
    description: "queue wait must not consume the merge run bound",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    noCommitsExpected: true,
    branch: null,
    worktree: null,
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
  };
}

function mergeCtx(signal?: AbortSignal) {
  return primitiveNodeContext(
    { runId: "KB-097:run", taskId: "KB-097", workflowId: "builtin:coding" },
    { id: "merge", kind: "prompt" },
    {},
    signal,
  );
}

/** Stands in for the merge pump: the request stays pending and the test decides when the merge starts running. */
function queuedMergeRequester() {
  const calls = [];
  const resolvers = [];
  const requester = vi.fn((taskId, options) => {
    calls.push(options);
    return new Promise((resolve) => { resolvers.push(resolve); });
  });
  return { requester, calls, resolvers };
}

const SURFACES = [
  {
    label: "requestMerge primitive",
    abortsMergeOnTimeout: true,
    request: (executor, task, signal) => executor.createAuthoritativeWorkflowPrimitives({ autoMerge: true }).requestMerge(mergeCtx(signal), task),
  },
  {
    label: "legacy merge seam",
    abortsMergeOnTimeout: false,
    request: (executor, task, signal) => executor.createAuthoritativeWorkflowSeams({ autoMerge: true }).merge(task, {}, signal),
  },
] as const;

describe.for(SURFACES)("merge run bound on the $label", ({ request, abortsMergeOnTimeout }) => {
  let settled;
  let calls;
  let resolvers;
  let card;

  async function start(signal?: AbortSignal) {
    const task = approvedCard();
    card = task;
    const store = createMockStore();
    store.getTask.mockResolvedValue(task);
    store.moveTask.mockResolvedValue({ ...task, column: "in-review" });
    const executor = new TaskExecutor(store, "/tmp/test");
    const queued = queuedMergeRequester();
    calls = queued.calls;
    resolvers = queued.resolvers;
    executor.setMergeRequester(queued.requester);
    settled = undefined;
    void request(executor, task, signal).then((result) => { settled = result; });
    while (calls.length === 0) await vi.advanceTimersByTimeAsync(0);
  }

  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not time out while the merge is still waiting for the pump", async () => {
    await start();

    await vi.advanceTimersByTimeAsync(GRAPH_MERGE_RUN_TIMEOUT_MS * 3);

    expect(settled).toBeUndefined();
  });

  it("times out a merge that hangs after it started, measured from the start", async () => {
    await start();
    await vi.advanceTimersByTimeAsync(21 * MINUTE);
    calls[0].onMergeRunStarted();

    await vi.advanceTimersByTimeAsync(GRAPH_MERGE_RUN_TIMEOUT_MS - 1);
    expect(settled).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toMatchObject({ outcome: "failure", value: "merge-timeout" });
    if (abortsMergeOnTimeout) expect(calls[0].signal.aborted).toBe(true);
  });

  it("gives a merge that restarts on a new integration tip a fresh bound", async () => {
    await start();
    calls[0].onMergeRunStarted();
    await vi.advanceTimersByTimeAsync(25 * MINUTE);
    calls[0].onMergeRunStarted();

    await vi.advanceTimersByTimeAsync(25 * MINUTE);
    expect(settled).toBeUndefined();

    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(settled).toMatchObject({ outcome: "failure", value: "merge-timeout" });
  });

  it("never times out or aborts a merge whose landing has started", async () => {
    await start();
    calls[0].onMergeRunStarted();
    await vi.advanceTimersByTimeAsync(29 * MINUTE);
    calls[0].onMergeLandingStarted();

    await vi.advanceTimersByTimeAsync(GRAPH_MERGE_RUN_TIMEOUT_MS * 3);
    expect(settled).toBeUndefined();
    expect(calls[0].signal?.aborted ?? false).toBe(false);

    resolvers[0]({ task: { ...card, column: "done" }, branch: "", merged: false, noOp: true, ok: true, mergeConfirmed: true, worktreeRemoved: false, branchDeleted: false });
    for (let turn = 0; turn < 50 && settled === undefined; turn++) await vi.advanceTimersByTimeAsync(0);
    expect(settled).toMatchObject({ outcome: "success", value: "merge-noop" });
  });

  it("still bounds a run that never reaches its landing", async () => {
    await start();
    calls[0].onMergeRunStarted();

    await vi.advanceTimersByTimeAsync(GRAPH_MERGE_RUN_TIMEOUT_MS);
    expect(settled).toMatchObject({ outcome: "failure", value: "merge-timeout" });
    if (abortsMergeOnTimeout) expect(calls[0].signal.aborted).toBe(true);
  });

  it("re-arms the bound when a merge rebuilds after its landing started", async () => {
    await start();
    calls[0].onMergeRunStarted();
    calls[0].onMergeLandingStarted();
    await vi.advanceTimersByTimeAsync(40 * MINUTE);
    calls[0].onMergeRunStarted();

    await vi.advanceTimersByTimeAsync(GRAPH_MERGE_RUN_TIMEOUT_MS - 1);
    expect(settled).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toMatchObject({ outcome: "failure", value: "merge-timeout" });
  });

  it("still cancels on a graph abort during the landing tail", async () => {
    const graphAbort = new AbortController();
    await start(graphAbort.signal);
    calls[0].onMergeRunStarted();
    calls[0].onMergeLandingStarted();

    graphAbort.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toMatchObject({ outcome: "failure", value: "merge-cancelled" });
  });
});
