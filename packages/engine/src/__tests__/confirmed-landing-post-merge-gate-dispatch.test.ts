// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { getBuiltinWorkflow } from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import { projectAdmissionCoordinator } from "../concurrency/concurrency.js";
import { createPlanningContinuationDispatcher, drainDuePlanningContinuations, listContinuationAdmissionCandidates } from "../runtimes/in-process-runtime.js";
import { finalizeProvenAutoMergeTask } from "../merge/auto-merge-finalization.js";
import { WorkflowGraphTaskRunner } from "../workflows/workflow-graph-task-runner.js";
import { createMockStore, mockedExistsSync, resetExecutorMocks } from "./executor-test-helpers.js";

/*
FNXC:ContinuationDispatch 2026-10-08-08:35:
A live task's continuation is a same-slot handoff and must not starve behind an over-capacity item (KB-032, KB-036).

Original symptom: a landed card whose leftover `landing` stamp made it a live capacity holder had a runnable post-merge-verification row for hours.
The admission provider leaves live tasks to the drain, and the drain stopped at the first capacity rejection; nine older plan-review rows were rejected first on every pass, so the same-slot handoff was never reached.

Surface enumeration (engine only, no UI):
- A live holder in the review lane (confirmed landing with a merge-active stamp) and in the WIP lane (a resumed execution node).
- A non-live continuation queued behind the rejection still waits for capacity.
- End to end: the drain hands the confirmed landing to the real executor, which enters the graph at its post-merge gate.
*/

const OLD = "2026-10-01T00:00:00.000Z";
const NOW = "2026-10-08T07:35:00.000Z";
const CAP = 6;

function card(id, patch = {}) {
  return {
    id, title: id, description: id, column: "todo", dependencies: [], steps: [], currentStep: 0, log: [],
    createdAt: NOW, updatedAt: NOW, ...patch,
  };
}

function landedCard(patch = {}) {
  return card("KB-036", {
    column: "in-review",
    status: "landing",
    autoMerge: true,
    paused: false,
    userPaused: false,
    steps: [{ name: "Implement", status: "done" }],
    currentStep: 1,
    mergeDetails: { mergeConfirmed: true, commitSha: "74d0bdf8af31", mergeTargetBranch: "main" },
    enabledWorkflowSteps: ["post-merge-verification"],
    workflowStepResults: [],
    ...patch,
  });
}

function item(taskId, nodeId, createdAt = NOW) {
  return { id: `wi-${taskId}-${nodeId}`, runId: `run-${taskId}`, taskId, nodeId, nodeInstanceId: nodeId, kind: "task", state: "runnable", waitReason: null, createdAt, updatedAt: createdAt };
}

/** Five live WIP holders plus the live card under a cap of six: the board is full. */
function holders() {
  return [1, 2, 3, 4, 5].map((n) => card(`KB-HOLD-${n}`, { column: "in-progress" }));
}

function selection(task) {
  return { workflowId: "builtin:coding", stepIds: task?.enabledWorkflowSteps ?? [] };
}

function drainStore(cards) {
  return {
    getSettings: vi.fn(async () => ({ maxConcurrent: CAP, maxWorktrees: 9 })),
    listTasks: vi.fn(async () => cards),
    getTask: vi.fn(async (id) => cards.find((candidate) => candidate.id === id)),
    getTaskWorkflowSelection: vi.fn((id) => selection(cards.find((candidate) => candidate.id === id))),
    getTaskWorkflowSelectionAsync: vi.fn(async (id) => selection(cards.find((candidate) => candidate.id === id))),
    getWorkflowDefinition: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    transitionWorkflowWorkItem: vi.fn(async () => null),
  };
}

async function drainOnce(store, items, execute, projectId) {
  const dispatch = createPlanningContinuationDispatcher({ store, execute, projectId });
  await drainDuePlanningContinuations({
    listDue: async () => items,
    getTask: store.getTask,
    cancelOrphan: vi.fn(),
    defer: vi.fn(),
    dispatch,
    nowMs: () => Date.now(),
    warn: vi.fn(),
  });
  // Same-slot handoffs start their run without awaiting it.
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
}

afterEach(() => {
  projectAdmissionCoordinator.clearReservationsForTests();
});

describe("continuation drain after a capacity rejection", () => {
  it.each([
    { label: "a confirmed landing holding the review lane", live: () => landedCard(), node: "post-merge-verification" },
    { label: "a resumed WIP execution", live: () => card("KB-WIP", { column: "in-progress" }), node: "step-execute" },
  ])("still hands $label its own slot", async ({ live, node }) => {
    const liveCard = live();
    const older = card("KB-PLAN");
    const store = drainStore([...holders(), liveCard, older]);
    const execute = vi.fn(async () => undefined);

    await drainOnce(store, [item(older.id, "plan-review", OLD), item(liveCard.id, node)], execute, `/drain/${liveCard.id}`);

    expect(execute.mock.calls.map(([task]) => task.id)).toEqual([liveCard.id]);
  });

  it("keeps a non-live continuation behind the rejection waiting for capacity", async () => {
    const older = card("KB-PLAN");
    const newer = card("KB-PLAN-2");
    const store = drainStore([...holders(), card("KB-HOLD-6", { column: "in-progress" }), older, newer]);
    const execute = vi.fn(async () => undefined);

    await drainOnce(store, [item(older.id, "plan-review", OLD), item(newer.id, "plan-review")], execute, "/drain/non-live");

    expect(execute).not.toHaveBeenCalled();
  });
});

describe("confirmed landing after the finalizer defers", () => {
  it("is offered to every admission pass in the review lane instead of holding a slot", async () => {
    const landed = landedCard();
    const cards = [...holders(), landed];
    const store = drainStore(cards);
    const gateRow = item(landed.id, "post-merge-verification");
    Object.assign(store, {
      getWorkflowDefinition: vi.fn(async (id) => getBuiltinWorkflow(id)),
      listDueWorkflowWorkItems: vi.fn(async () => [gateRow]),
      updateTaskAtomic: vi.fn(async (_id, update) => {
        const patch = await update(landed);
        return patch ? Object.assign(landed, patch) : landed;
      }),
      recordRunAuditEvent: vi.fn(),
    });
    const offered = () => listContinuationAdmissionCandidates({ store, projectId: "/provider/landing", isDispatchOpen: () => true, run: vi.fn() });

    expect(await offered()).toEqual([]);
    const deferral = await finalizeProvenAutoMergeTask({ store, taskId: landed.id, source: "merge-confirmed-fast-path" });

    expect(deferral).toMatchObject({ outcome: "blocked", postMergeEvidenceBlocked: true });
    expect(landed).toMatchObject({ status: null, column: "in-review" });
    expect((await offered()).map(({ taskId, lane }) => ({ taskId, lane }))).toEqual([{ taskId: landed.id, lane: "review" }]);
  });
});

describe("confirmed landing post-merge gate, end to end", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("enters the graph at the post-merge gate on the next drain pass", async () => {
    const landed = landedCard();
    const older = card("KB-PLAN");
    const cards = [...holders(), landed, older];
    const store = createMockStore();
    const gateRow = item(landed.id, "post-merge-verification");
    Object.assign(store, drainStore(cards), {
      getSettings: vi.fn(async () => ({ maxConcurrent: CAP, maxWorktrees: 9, autoMerge: true })),
      getWorkflowDefinition: vi.fn(async (id) => getBuiltinWorkflow(id)),
      listWorkflowWorkItemsForTask: vi.fn(async (id) => (id === landed.id ? [gateRow] : [])),
      transitionWorkflowWorkItem: vi.fn(async (_id, state, patch = {}) => ({ ...gateRow, state, ...patch })),
    });
    const run = vi.spyOn(WorkflowGraphTaskRunner.prototype, "run");
    const executor = new TaskExecutor(store, "/tmp/landing-gate");
    const runs = [];

    try {
      await drainOnce(store, [item(older.id, "plan-review", OLD), gateRow], (task) => {
        const pending = executor.execute(task);
        runs.push(pending);
        return pending;
      }, "/e2e/landing-gate");
      await Promise.all(runs);

      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0][0]).toMatchObject({ id: landed.id });
      expect(run.mock.calls[0][2]).toBe("post-merge-verification");
      expect(store.logEntry.mock.calls.map(([, message]) => String(message))).toContain("[post-merge] Starting workflow step: Post-merge verification");
    } finally {
      run.mockRestore();
    }
  });
});
