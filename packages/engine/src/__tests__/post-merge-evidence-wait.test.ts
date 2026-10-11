import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getRequiredPostMergeEvidenceDecision,
  POST_MERGE_VERIFICATION_GROUP_ID,
  postMergeOptionalGroupNode,
  upsertWorkflowStepResult,
  type Task,
  type TaskDetail,
  type TaskStore,
  type WorkflowIr,
  type WorkflowStepResult,
} from "@fusion/core";

import { WorkflowGraphExecutor, type WorkflowNodeHandler } from "../workflows/workflow-graph-executor.js";
import { createWorkflowColumnBoundary } from "../workflows/workflow-column-boundary.js";
import { isPostMergeGateRecoveryDue, resumeMissingPostMergeGate } from "../merge/post-merge-gate-reseed.js";
import { finalizeProvenAutoMergeTask } from "../merge/auto-merge-finalization.js";

/*
FNXC:PostMergeEvidenceWait 2026-10-08-19:12:
KB-080 acceptance regression. A required post-merge gate that finds its post-landing CI run not started, queued or
in progress must record awaiting-evidence (never REVISE or failed), keep the card in review, be re-dispatched
automatically on the 5/10/20/30-minute backoff, and render a real verdict once the run concludes: green approves,
a red lane attributed to the task stays blocked as REVISE, and an unrelated red lane with a linked follow-up may
approve with notes. A wait that never concludes within 8 hours becomes a visible failed row with one bounded audit.
Original symptom: KB-049 (run 37759591738) and KB-008 (run 37763174330) recorded failed/REVISE "still queued" rows.
*/

const GATE_ID = POST_MERGE_VERIFICATION_GROUP_ID;
const GATE_STEP_ID = `${GATE_ID}-step`;
const MINUTE = 60_000;
const T0 = Date.parse("2026-10-08T10:00:00.000Z");

type Pending = { state: string; runId?: string };

function gateIr(gateMode: "gate" | "advisory" = "gate", phase: "post-merge" | "pre-merge" = "post-merge"): WorkflowIr {
  const group = postMergeOptionalGroupNode({ id: GATE_ID, name: "Post-merge verification", column: "done", prompt: "verify", gateMode, defaultOn: true });
  if (phase === "pre-merge") (group.config as { phase?: string }).phase = "pre-merge";
  return {
    version: "v2",
    name: "post-merge-evidence-wait",
    columns: [
      { id: "work", name: "Work", traits: [{ trait: "wip" }] },
      { id: "in-review", name: "Review", traits: [{ trait: "human-review" }, { trait: "merge-blocker" }] },
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "work" },
      { id: "execute", kind: "prompt", column: "work", config: { prompt: "x" } },
      { id: "merge-attempt", kind: "merge-attempt", column: "in-review", config: { capability: "task-merge" } },
      group,
      { id: "end", kind: "end", column: "done" },
    ],
    edges: [
      { from: "start", to: "execute" },
      { from: "execute", to: "merge-attempt", condition: "success" },
      { from: "merge-attempt", to: "end", condition: "success" },
      { from: "merge-attempt", to: GATE_ID, condition: "success" },
      { from: GATE_ID, to: "end", condition: "success" },
    ],
  };
}

type GateReply =
  | { kind: "wait"; pending: Pending }
  | { kind: "verdict"; verdict: "APPROVE" | "APPROVE_WITH_NOTES" | "REVISE"; notes: string };

function gateHandler(reply: () => GateReply, gateMode: "gate" | "advisory" = "gate"): WorkflowNodeHandler {
  return async (node) => {
    if (node.id !== GATE_STEP_ID) return { outcome: "success" };
    const next = reply();
    if (next.kind === "wait") {
      const notes = `Full Suite run ${next.pending.runId ?? "?"} is ${next.pending.state}.`;
      return {
        outcome: gateMode === "gate" ? "failure" : "success",
        value: "post-merge-evidence-pending",
        contextPatch: { output: notes, notes, evidencePending: next.pending },
      };
    }
    return {
      outcome: next.verdict === "REVISE" && gateMode === "gate" ? "failure" : "success",
      value: next.verdict,
      contextPatch: { output: next.notes, notes: next.notes },
    };
  };
}

/** A landed, merge-confirmed in-review task backed by a mutable store row. */
function landedTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "KB-049", column: "in-review", updatedAt: new Date(T0).toISOString(), autoMerge: true, steps: [],
    mergeDetails: { mergeConfirmed: true }, enabledWorkflowSteps: [GATE_ID], workflowStepResults: [],
    ...overrides,
  } as unknown as Task;
}

function makeStore(task: Task) {
  const items: Array<Record<string, unknown>> = [];
  const store = {
    getTask: vi.fn(async () => task),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(task, patch)),
    updateTaskAtomic: vi.fn(async (_id: string, update: (current: Task) => Partial<Task> | null | Promise<Partial<Task> | null>) => {
      const patch = await update(task);
      return patch ? Object.assign(task, patch) : null;
    }),
    moveTask: vi.fn(async (_id: string, column: string) => Object.assign(task, { column })),
    logEntry: vi.fn(), recordRunAuditEvent: vi.fn(), getSettings: vi.fn(async () => ({})),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: task.enabledWorkflowSteps ?? [] })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: task.enabledWorkflowSteps ?? [] })),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    listWorkflowWorkItemsForTask: vi.fn(async () => items),
    seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(async (input: Record<string, unknown>) => {
      if (items.length) return { seeded: false, reason: "active-continuation" as const };
      items.push(input);
      return { seeded: true, workItemId: "post-merge-continuation" };
    }),
  } as unknown as TaskStore;
  (store as unknown as { moveTaskIf: unknown }).moveTaskIf = vi.fn(async (_id: string, column: string, predicate: (t: Task) => boolean | Promise<boolean>) => {
    if (!await predicate(task)) return { task, moved: false };
    return { task: Object.assign(task, { column }), moved: true };
  });
  return { store, items };
}

/** Run the graph once over a snapshot of the store row, persisting step results into the row. */
async function runGate(task: Task, reply: GateReply, options: { gateMode?: "gate" | "advisory"; phase?: "post-merge" | "pre-merge"; onExhausted?: (taskId: string, metadata: Record<string, unknown>) => unknown } = {}) {
  const ir = gateIr(options.gateMode, options.phase);
  const logs: string[] = [];
  const moves: string[] = [];
  const boundary = createWorkflowColumnBoundary({
    taskId: task.id, workflowId: ir.name, ir, initialColumn: "in-review",
    moveTask: async (toColumn) => { moves.push(toColumn); Object.assign(task, { column: toColumn }); },
  });
  const executor = new WorkflowGraphExecutor({
    handlers: { prompt: gateHandler(() => reply, options.gateMode) },
    recordWorkflowStepResult: async (_taskId: string, result: WorkflowStepResult) => {
      task.workflowStepResults = upsertWorkflowStepResult(task.workflowStepResults, result);
    },
    logTaskEntry: (summary: string) => logs.push(summary),
    columnBoundary: boundary,
    onPostMergeEvidenceWaitExhausted: options.onExhausted as never,
  });
  const snapshot = structuredClone(task) as unknown as TaskDetail;
  const result = await executor.run(snapshot, { experimentalFeatures: { graphNativePostMerge: true } }, ir);
  return { result, logs, moves, gate: task.workflowStepResults?.find((entry) => entry.workflowStepId === GATE_ID) };
}

function expectWaitIsNotARejection(task: Task, logs: string[], moves: string[]) {
  expect(task.status).not.toBe("failed");
  expect(task.error).toBeUndefined();
  expect(task.column).toBe("in-review");
  expect(moves).not.toContain("done");
  expect(logs.some((line) => line.includes("Workflow step failed") || line.includes("requested revision"))).toBe(false);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("KB-080 post-merge gate waits for pending CI evidence", () => {
  it.each([
    { state: "run-not-started" },
    { state: "run-queued", runId: "37759591738" },
    { state: "run-in-progress", runId: "37763174330" },
  ])("records awaiting-evidence, not REVISE or failed, for $state", async (pending) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const task = landedTask();
    const { store } = makeStore(task);

    const { result, logs, moves, gate } = await runGate(task, { kind: "wait", pending });

    expect(result.outcome).toBe("failure");
    expect(result.visitedNodeIds).not.toContain("end");
    expect(gate).toMatchObject({
      status: "awaiting-evidence",
      phase: "post-merge",
      evidenceWait: { state: pending.state, firstObservedAt: new Date(T0).toISOString(), checkCount: 1 },
    });
    expect(gate?.verdict).toBeUndefined();
    if (pending.runId) expect(gate?.evidenceWait?.runId).toBe(pending.runId);
    expectWaitIsNotARejection(task, logs, moves);
    expect(logs).toContainEqual(expect.stringContaining(`[post-merge] Waiting for post-landing CI evidence: ${pending.state}`));
    expect(logs).toContainEqual(expect.stringContaining("next automatic check in 5 min (check 1"));

    const decision = await getRequiredPostMergeEvidenceDecision(store, task);
    expect(decision).toEqual({ outcome: "blocked", gateId: GATE_ID, reason: "awaiting-evidence" });

    vi.setSystemTime(T0 + 5 * MINUTE - 1);
    expect(isPostMergeGateRecoveryDue(task, decision)).toBe(false);
    vi.setSystemTime(T0 + 5 * MINUTE);
    expect(isPostMergeGateRecoveryDue(task, decision)).toBe(true);
    await expect(resumeMissingPostMergeGate(store, task.id)).resolves.toEqual({ outcome: "resumed", gateId: GATE_ID });
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: GATE_ID, sourceColumn: "in-review", targetColumn: "in-review",
    }));
    expect(store.logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("Rechecking pending CI evidence"));
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("carries the wait window forward and keeps the prior wait in history", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const task = landedTask();
    await runGate(task, { kind: "wait", pending: { state: "run-queued", runId: "37759591738" } });
    const first = structuredClone(task.workflowStepResults?.[0]);

    vi.setSystemTime(T0 + 6 * MINUTE);
    const { gate, logs } = await runGate(task, { kind: "wait", pending: { state: "run-in-progress", runId: "37759591738" } });

    expect(gate).toMatchObject({
      status: "awaiting-evidence",
      evidenceWait: { state: "run-in-progress", firstObservedAt: new Date(T0).toISOString(), checkCount: 2 },
    });
    expect(gate?.priorAttempts).toEqual([first]);
    expect(logs).toContainEqual(expect.stringContaining("next automatic check in 10 min (check 2"));
  });

  it("records an advisory post-merge WAIT as a non-blocking advisory failure", async () => {
    const task = landedTask();
    const { result, gate } = await runGate(task, { kind: "wait", pending: { state: "run-queued" } }, { gateMode: "advisory" });
    expect(result.outcome).toBe("success");
    expect(gate).toMatchObject({ status: "advisory_failure", notes: "Full Suite run ? is run-queued." });
    expect(gate?.evidenceWait).toBeUndefined();
  });

  it("never records awaiting-evidence for a pre-merge group", async () => {
    const task = landedTask();
    const { gate } = await runGate(task, { kind: "wait", pending: { state: "run-queued" } }, { phase: "pre-merge" });
    expect(gate?.status).not.toBe("awaiting-evidence");
    expect(gate?.evidenceWait).toBeUndefined();
  });

  it("records the same wait for a workspace landing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const task = landedTask({
      workspaceWorktrees: { "repo-a": { worktreePath: "ws/repo-a", branch: "fusion/kb-049-repo-a" } },
      mergeDetails: { mergeConfirmed: true, commitSha: "a".repeat(40), workspaceLandedShas: { "repo-a": "a".repeat(40) } },
    } as Partial<Task>);
    const { store } = makeStore(task);
    const { gate, logs, moves } = await runGate(task, { kind: "wait", pending: { state: "run-queued" } });
    expect(gate).toMatchObject({ status: "awaiting-evidence", evidenceWait: { checkCount: 1 } });
    expectWaitIsNotARejection(task, logs, moves);
    vi.setSystemTime(T0 + 5 * MINUTE);
    const gitRun = vi.fn();
    await expect(resumeMissingPostMergeGate(store, task.id, { git: gitRun as never })).resolves.toMatchObject({ outcome: "resumed" });
    expect(gitRun).not.toHaveBeenCalled();
  });

  it("surfaces an 8-hour wait as a visible failed row with exactly one bounded audit", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const task = landedTask();
    const { store, items } = makeStore(task);
    await runGate(task, { kind: "wait", pending: { state: "run-queued", runId: "37759591738" } });

    for (const hostile of [
      () => { throw new Error("sink down"); },
      () => Promise.reject(new Error("sink down")),
      () => new Promise<void>(() => {}),
    ]) {
      task.workflowStepResults = [{
        ...task.workflowStepResults![0], status: "awaiting-evidence", verdict: undefined, output: "queued",
        evidenceWait: { state: "run-queued", runId: "37759591738", firstObservedAt: new Date(T0).toISOString(), checkCount: 17 },
      }];
      vi.setSystemTime(T0 + 8 * 60 * MINUTE);
      const sink = vi.fn(hostile);
      const { gate, logs, moves } = await runGate(task, { kind: "wait", pending: { state: "run-queued", runId: "37759591738" } }, { onExhausted: sink });
      expect(gate).toMatchObject({
        status: "failed",
        evidenceWait: { state: "run-queued", checkCount: 18, exhaustedAt: new Date(T0 + 8 * 60 * MINUTE).toISOString() },
      });
      expect(gate?.verdict).toBeUndefined();
      expect(gate?.output).toContain("did not conclude within 8 hours (last state: run-queued, run 37759591738)");
      expect(gate?.output).toContain("Retry this step");
      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink.mock.calls[0][1]).toEqual({ taskId: task.id, nodeId: GATE_ID, state: "run-queued", checkCount: 18, waitedMs: 8 * 60 * MINUTE });
      expect(Object.keys(sink.mock.calls[0][1] as object).sort()).toEqual(["checkCount", "nodeId", "state", "taskId", "waitedMs"]);
      expect(task.status).toBeUndefined();
      expect(task.column).toBe("in-review");
      expect(moves).not.toContain("done");
      expect(logs).toContainEqual(expect.stringContaining("Post-merge CI evidence wait exhausted"));
    }

    // The exhausted row is never polled automatically, but an operator Retry starts a new window.
    const decision = await getRequiredPostMergeEvidenceDecision(store, task);
    expect(decision).toMatchObject({ outcome: "blocked", reason: "failed" });
    vi.setSystemTime(T0 + 12 * 60 * MINUTE);
    expect(isPostMergeGateRecoveryDue(task, decision)).toBe(false);
    await expect(resumeMissingPostMergeGate(store, task.id)).resolves.toEqual({ outcome: "not-resumable" });
    await expect(resumeMissingPostMergeGate(store, task.id, { manualRetry: true })).resolves.toMatchObject({ outcome: "resumed" });
    expect(items).toHaveLength(1);
    const { gate } = await runGate(task, { kind: "wait", pending: { state: "run-queued" } });
    expect(gate).toMatchObject({ status: "awaiting-evidence", evidenceWait: { checkCount: 1, firstObservedAt: new Date(T0 + 12 * 60 * MINUTE).toISOString() } });
  });
});

describe("KB-080 round trip: wait, automatic re-dispatch, then a real verdict", () => {
  it.each([
    { conclusion: "green", verdict: "APPROVE", notes: "Run 37759591738 passed every shard.", status: "passed", decision: { outcome: "finalizable" } },
    { conclusion: "red-attributed", verdict: "REVISE", notes: "Shard 2/4 fails in code this task changed.", status: "failed", decision: { outcome: "blocked", gateId: GATE_ID, reason: "failed" } },
    { conclusion: "red-unrelated", verdict: "APPROVE_WITH_NOTES", notes: "Shard 3/4 failure predates this task; follow-up KB-092 owns it.", status: "passed", decision: { outcome: "finalizable" } },
  ] as const)("renders a real verdict once the run concludes $conclusion", async ({ verdict, notes, status, decision }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const task = landedTask();
    const { store, items } = makeStore(task);
    const seen: Array<Pick<WorkflowStepResult, "status" | "verdict">> = [];
    const observe = () => {
      const gate = task.workflowStepResults?.find((entry) => entry.workflowStepId === GATE_ID);
      if (gate) seen.push({ status: gate.status, verdict: gate.verdict });
      expect(task.status).not.toBe("failed");
      expect(task.column).toBe("in-review");
    };

    // 1. The push run has not started yet.
    await runGate(task, { kind: "wait", pending: { state: "run-not-started" } });
    observe();
    // 2. Five minutes later the automatic due check re-dispatches the gate.
    vi.setSystemTime(T0 + 5 * MINUTE);
    await expect(resumeMissingPostMergeGate(store, task.id)).resolves.toMatchObject({ outcome: "resumed" });
    items.length = 0;
    // 3. The run is now in progress.
    await runGate(task, { kind: "wait", pending: { state: "run-in-progress", runId: "37759591738" } });
    observe();
    expect(task.workflowStepResults?.[0].evidenceWait?.checkCount).toBe(2);
    // 4. The second backoff is ten minutes.
    vi.setSystemTime(T0 + 14 * MINUTE);
    await expect(resumeMissingPostMergeGate(store, task.id)).resolves.toEqual({ outcome: "not-resumable" });
    vi.setSystemTime(T0 + 15 * MINUTE);
    await expect(resumeMissingPostMergeGate(store, task.id)).resolves.toMatchObject({ outcome: "resumed" });
    // 5. The run has concluded; the gate renders a real verdict.
    await runGate(task, { kind: "verdict", verdict, notes });
    const gate = task.workflowStepResults?.find((entry) => entry.workflowStepId === GATE_ID);
    expect(gate).toMatchObject({ status, verdict, notes });
    expect(gate?.evidenceWait).toBeUndefined();
    await expect(getRequiredPostMergeEvidenceDecision(store, task)).resolves.toEqual(decision);

    // No REVISE verdict and no failed status was recorded before the run concluded.
    expect(seen).toEqual([{ status: "awaiting-evidence", verdict: undefined }, { status: "awaiting-evidence", verdict: undefined }]);

    const finalization = await finalizeProvenAutoMergeTask({ store, taskId: task.id, source: "self-healing" });
    if (verdict === "REVISE") {
      expect(finalization.outcome).toBe("blocked");
      expect(finalization.reason).toContain("is not approved");
      expect(task.column).toBe("in-review");
    } else {
      expect(finalization.outcome).not.toBe("blocked");
    }
  });

  it("defers the shared finalizer with the waiting blocker and does not reseed before the backoff", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const task = landedTask();
    const { store, items } = makeStore(task);
    await runGate(task, { kind: "wait", pending: { state: "run-queued" } });
    vi.setSystemTime(T0 + MINUTE);
    const finalization = await finalizeProvenAutoMergeTask({ store, taskId: task.id, source: "self-healing" });
    expect(finalization).toMatchObject({ outcome: "blocked", awaitingPostMergeEvidence: true, postMergeEvidenceBlocked: true });
    expect(finalization.deferredPostMergeEvidence).toBeUndefined();
    expect(finalization.reason).toBe(`required post-merge evidence gate '${GATE_ID}' is waiting for post-landing CI evidence`);
    expect(items).toHaveLength(0);
    expect(task.column).toBe("in-review");
    expect(task.status).toBeUndefined();
  });
});
