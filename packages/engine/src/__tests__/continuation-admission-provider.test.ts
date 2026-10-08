import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr, WorkflowWorkItem } from "@fusion/core";

import { projectAdmissionCoordinator, type AdmissionCandidate } from "../concurrency/concurrency.js";
import {
  admitPlanningContinuation,
  createPlanningContinuationDispatcher,
  listContinuationAdmissionCandidates,
  registerContinuationAdmissionProvider,
} from "../runtimes/in-process-runtime.js";

const PROJECT_ID = "/test/continuation-admission-provider";
const OLDER = "2026-10-01T00:00:00.000Z";
const NEWER = "2026-10-08T00:00:00.000Z";

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "todo",
    priority: "medium",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: NEWER,
    updatedAt: NEWER,
    ...patch,
  } as Task;
}

function workItem(taskId: string, nodeId: string, patch: Partial<WorkflowWorkItem> = {}): WorkflowWorkItem {
  return {
    id: `wi-${taskId}-${nodeId}`,
    runId: `run-${taskId}`,
    taskId,
    nodeId,
    kind: "task",
    state: "runnable",
    waitReason: null,
    createdAt: NEWER,
    updatedAt: NEWER,
    ...patch,
  } as WorkflowWorkItem;
}

/** Two live WIP holders under a cap of three: exactly one slot is free. */
const LIVE_HOLDERS = [task("KB-LIVE-1", { column: "in-progress" }), task("KB-LIVE-2", { column: "in-progress" })];
const CAP = 3;

function fakeStore(input: {
  tasks: Task[];
  items: WorkflowWorkItem[];
  workflowByTask?: Record<string, string>;
  definitions?: Record<string, WorkflowIr>;
}): TaskStore {
  const all = [...LIVE_HOLDERS, ...input.tasks];
  const selection = (taskId: string) => {
    const workflowId = input.workflowByTask?.[taskId];
    return workflowId ? { workflowId, stepIds: [] } : undefined;
  };
  return {
    getSettings: vi.fn(async () => ({ maxConcurrent: CAP, maxWorktrees: 9, worktreeLimitEnabled: false })),
    listTasks: vi.fn(async () => all),
    getTask: vi.fn(async (taskId: string) => all.find((candidate) => candidate.id === taskId)),
    listDueWorkflowWorkItems: vi.fn(async () => input.items),
    getTaskWorkflowSelection: vi.fn(selection),
    getTaskWorkflowSelectionAsync: vi.fn(async (taskId: string) => selection(taskId)),
    getWorkflowDefinition: vi.fn(async (id: string) => (input.definitions?.[id] ? { ir: input.definitions[id] } : undefined)),
    logEntry: vi.fn(async () => undefined),
  } as unknown as TaskStore;
}

/** Every pending run across the file, settled after each test so no run key stays owned. */
const pendingSettles: Array<() => void> = [];

/** A controllable resumed run: execute() stays pending until the test settles it. */
function controllableRun() {
  const settles = pendingSettles;
  const run = vi.fn((_task: Task, _item: WorkflowWorkItem) => new Promise<void>((resolve) => { settles.push(resolve); }));
  return { run, settleAll: async () => { settles.splice(0).forEach((settle) => settle()); await flush(); } };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

/** The scheduler's hold-release admission pass, in the exact candidate shape scheduler.ts offers. */
function schedulerHoldReleasePass(candidateTaskId: string, createdAt: string, maxConcurrent = CAP) {
  const start = vi.fn(async () => true);
  const admitted = projectAdmissionCoordinator.admitNext({
    projectId: PROJECT_ID,
    maxConcurrent,
    claimed: () => LIVE_HOLDERS.length,
    claimedTaskIds: () => LIVE_HOLDERS.map((holder) => holder.id),
    refresh: async (): Promise<AdmissionCandidate[]> => [{
      taskId: candidateTaskId,
      projectId: PROJECT_ID,
      lane: "execute",
      createdAt,
      start,
    }],
  });
  return { admitted, start };
}

const RENAMED_WORKFLOW_IR = {
  version: "v2",
  columns: [
    { id: "inbox", name: "Inbox", traits: [{ trait: "intake" }] },
    { id: "queue", name: "Queue", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "build", name: "Build", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "qa", name: "QA", traits: [{ trait: "merge-blocker" }, { trait: "human-review" }, { trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
  nodes: [
    { id: "craft", kind: "prompt", column: "build", config: { seam: "execute" } },
    {
      id: "after-ship",
      kind: "optional-group",
      column: "shipped",
      config: { phase: "post-merge", template: { nodes: [{ id: "after-ship-run", kind: "prompt", config: {} }], edges: [] } },
    },
  ],
  edges: [],
} as unknown as WorkflowIr;

const unregisters: Array<() => void> = [];

function register(store: TaskStore, run: (task: Task, item: WorkflowWorkItem) => Promise<void>, isDispatchOpen = () => true) {
  unregisters.push(registerContinuationAdmissionProvider({ store, projectId: PROJECT_ID, isDispatchOpen, run }));
}

afterEach(async () => {
  unregisters.splice(0).forEach((unregister) => unregister());
  pendingSettles.splice(0).forEach((settle) => settle());
  await flush();
  projectAdmissionCoordinator.clearReservationsForTests();
});

describe("workflow continuations compete in every project admission pass", () => {
  it("admits a waiting post-merge verification before an older hold-release executor in the scheduler's own pass", async () => {
    const reviewTask = task("KB-032", { column: "in-review" });
    const store = fakeStore({ tasks: [reviewTask], items: [workItem("KB-032", "post-merge-verification")] });
    const { run, settleAll } = controllableRun();
    register(store, run);

    const pass = schedulerHoldReleasePass("KB-048", OLDER);

    expect(await pass.admitted).toBe("KB-032");
    expect(pass.start).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0].id).toBe("KB-032");
    expect(projectAdmissionCoordinator.inspectProjectStateForTests(PROJECT_ID).reservedCount).toBe(1);

    await settleAll();
    expect(projectAdmissionCoordinator.inspectProjectStateForTests(PROJECT_ID).reservedCount).toBe(0);
  });

  it("gives browser verification, code review and merge resumes the review lane too", async () => {
    const tasks = ["KB-008", "KB-009", "KB-010"].map((id) => task(id, { column: "in-review" }));
    const items = [
      workItem("KB-008", "browser-verification"),
      workItem("KB-009", "code-review"),
      workItem("KB-010", "merge-attempt"),
    ];
    const candidates = await listContinuationAdmissionCandidates({
      store: fakeStore({ tasks, items }),
      projectId: PROJECT_ID,
      isDispatchOpen: () => true,
      run: async () => {},
    });
    expect(candidates.map((candidate) => [candidate.taskId, candidate.lane])).toEqual([
      ["KB-008", "review"],
      ["KB-009", "review"],
      ["KB-010", "review"],
    ]);
  });

  it("classifies a renamed custom workflow's post-merge gate as review and lets it win the freed slot", async () => {
    const reviewTask = task("KB-100", { column: "qa" });
    const store = fakeStore({
      tasks: [reviewTask],
      items: [workItem("KB-100", "after-ship")],
      workflowByTask: { "KB-100": "custom:renamed" },
      definitions: { "custom:renamed": RENAMED_WORKFLOW_IR },
    });
    const { run, settleAll } = controllableRun();
    register(store, run);

    const pass = schedulerHoldReleasePass("KB-048", OLDER);

    expect(await pass.admitted).toBe("KB-100");
    expect(pass.start).not.toHaveBeenCalled();
    await settleAll();
  });

  it("keeps a plan-review continuation in the planning lane, behind ready execute work", async () => {
    const planning = task("KB-049", { column: "todo" });
    const store = fakeStore({ tasks: [planning], items: [workItem("KB-049", "plan-review", { createdAt: OLDER })] });
    const { run, settleAll } = controllableRun();
    register(store, run);

    const losing = schedulerHoldReleasePass("KB-048", NEWER);
    expect(await losing.admitted).toBe("KB-048");
    expect(run).not.toHaveBeenCalled();

    projectAdmissionCoordinator.releaseReservation("KB-048");
    const admitted = await projectAdmissionCoordinator.admitNext({
      projectId: PROJECT_ID,
      maxConcurrent: CAP,
      claimed: () => LIVE_HOLDERS.length,
      claimedTaskIds: () => LIVE_HOLDERS.map((holder) => holder.id),
    });
    expect(admitted).toBe("KB-049");
    expect(run).toHaveBeenCalledOnce();
    await settleAll();
  });

  it("keeps step-execute and parse resumes in the execute lane with today's age ordering", async () => {
    const stepwise = { "KB-060": "builtin:stepwise-coding", "KB-061": "builtin:stepwise-coding" };
    const older = fakeStore({
      tasks: [task("KB-060")],
      items: [workItem("KB-060", "step-execute", { createdAt: OLDER, waitReason: "capacity" })],
      workflowByTask: stepwise,
    });
    const first = controllableRun();
    register(older, first.run);
    const beaten = schedulerHoldReleasePass("KB-048", NEWER);
    expect(await beaten.admitted).toBe("KB-060");
    expect(beaten.start).not.toHaveBeenCalled();
    await first.settleAll();
    unregisters.splice(0).forEach((unregister) => unregister());

    const newer = fakeStore({
      tasks: [task("KB-061")],
      items: [workItem("KB-061", "parse", { createdAt: NEWER, waitReason: "capacity" })],
      workflowByTask: stepwise,
    });
    const second = controllableRun();
    register(newer, second.run);
    const winning = schedulerHoldReleasePass("KB-048", OLDER);
    expect(await winning.admitted).toBe("KB-048");
    expect(second.run).not.toHaveBeenCalled();
  });

  it("offers nothing while dispatch is closed (paused or stopping runtime)", async () => {
    const store = fakeStore({ tasks: [task("KB-032", { column: "in-review" })], items: [workItem("KB-032", "post-merge-verification")] });
    const { run } = controllableRun();
    register(store, run, () => false);

    const pass = schedulerHoldReleasePass("KB-048", OLDER);
    expect(await pass.admitted).toBe("KB-048");
    expect(run).not.toHaveBeenCalled();
  });

  it("does not offer a same-slot handoff, a paused card, an approval hold, or a terminal card", async () => {
    const tasks = [
      task("KB-ACTIVE", { column: "in-progress" }),
      task("KB-PAUSED", { column: "in-review", paused: true }),
      task("KB-APPROVAL", { column: "todo", status: "awaiting-approval" }),
      task("KB-DONE", { column: "done" }),
      task("KB-READY", { column: "in-review" }),
    ];
    const items = [
      workItem("KB-ACTIVE", "code-review"),
      workItem("KB-PAUSED", "post-merge-verification"),
      workItem("KB-APPROVAL", "plan-review"),
      workItem("KB-DONE", "post-merge-verification"),
      workItem("KB-MISSING", "post-merge-verification"),
      workItem("KB-READY", "post-merge-verification"),
      workItem("KB-READY", "merge-attempt", { id: "wi-ready-duplicate" }),
    ];
    const candidates = await listContinuationAdmissionCandidates({
      store: fakeStore({ tasks, items }),
      projectId: PROJECT_ID,
      isDispatchOpen: () => true,
      run: async () => {},
    });
    expect(candidates.map((candidate) => candidate.taskId)).toEqual(["KB-READY"]);
  });

  it("unregisters with the drain", () => {
    const unregister = registerContinuationAdmissionProvider({
      store: fakeStore({ tasks: [], items: [] }),
      projectId: PROJECT_ID,
      isDispatchOpen: () => true,
      run: async () => {},
    });
    expect(projectAdmissionCoordinator.inspectProjectStateForTests(PROJECT_ID).providerIds).toContain(`continuation:${PROJECT_ID}`);
    unregister();
    expect(projectAdmissionCoordinator.inspectProjectStateForTests(PROJECT_ID).providerIds).not.toContain(`continuation:${PROJECT_ID}`);
  });
});

describe("the drain's one-shot admission and the provider share one ownership path", () => {
  it("uses the derived review lane, so a post-merge resume beats an older ready executor", async () => {
    const reviewTask = task("KB-032", { column: "in-review" });
    const item = workItem("KB-032", "post-merge-verification");
    const store = fakeStore({ tasks: [reviewTask], items: [] });
    const executorStart = vi.fn(async () => true);
    unregisters.push(projectAdmissionCoordinator.registerProvider(`execute:${PROJECT_ID}`, {
      projectId: PROJECT_ID,
      refresh: async () => [{ taskId: "KB-048", projectId: PROJECT_ID, lane: "execute", createdAt: OLDER, start: executorStart }],
    }));
    const { run, settleAll } = controllableRun();
    const dispatch = vi.fn(() => run(reviewTask, item));

    expect(await admitPlanningContinuation({ store, projectId: PROJECT_ID, task: reviewTask, item, dispatch })).toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(executorStart).not.toHaveBeenCalled();
    await settleAll();
  });

  it("dispatches a card offered by both the provider and the one-shot exactly once, holding one reservation", async () => {
    const reviewTask = task("KB-032", { column: "in-review" });
    const item = workItem("KB-032", "post-merge-verification");
    const store = fakeStore({ tasks: [reviewTask], items: [item] });
    const { run, settleAll } = controllableRun();
    register(store, run);
    const dispatch = createPlanningContinuationDispatcher({ store, projectId: PROJECT_ID, execute: (resumed) => run(resumed, item) });

    expect(await dispatch(reviewTask, item)).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(projectAdmissionCoordinator.inspectProjectStateForTests(PROJECT_ID).reservedCount).toBe(1);

    // The running continuation now holds the freed slot, so the next pass finds the cap full.
    const full = schedulerHoldReleasePass("KB-048", OLDER);
    expect(await full.admitted).toBeUndefined();
    expect(full.start).not.toHaveBeenCalled();

    // With room to spare, a later pass from another lane must still not re-offer the running card.
    const roomy = schedulerHoldReleasePass("KB-048", OLDER, CAP + 1);
    expect(await roomy.admitted).toBe("KB-048");
    expect(run).toHaveBeenCalledOnce();
    expect(projectAdmissionCoordinator.inspectProjectStateForTests(PROJECT_ID).reservedCount).toBe(2);
    projectAdmissionCoordinator.releaseReservation("KB-048");

    await settleAll();
    expect(projectAdmissionCoordinator.inspectProjectStateForTests(PROJECT_ID).reservedCount).toBe(0);
  });

  it("treats a stale duplicate candidate for a running card as a no-op that neither restarts nor releases it", async () => {
    const reviewTask = task("KB-032", { column: "in-review" });
    const item = workItem("KB-032", "post-merge-verification");
    const store = fakeStore({ tasks: [reviewTask], items: [item] });
    const { run, settleAll } = controllableRun();
    const deps = { store, projectId: PROJECT_ID, isDispatchOpen: () => true, run };
    const [first] = await listContinuationAdmissionCandidates(deps);
    const [stale] = await listContinuationAdmissionCandidates(deps);
    const passWith = (candidate: AdmissionCandidate) => projectAdmissionCoordinator.admitNext({
      projectId: PROJECT_ID,
      // Headroom so the stale candidate really reaches its start instead of stopping at a full cap.
      maxConcurrent: CAP + 1,
      claimed: () => LIVE_HOLDERS.length,
      claimedTaskIds: () => LIVE_HOLDERS.map((holder) => holder.id),
      refresh: async () => [candidate],
    });

    expect(await passWith(first!)).toBe("KB-032");
    expect(projectAdmissionCoordinator.inspectProjectStateForTests(PROJECT_ID).reservedCount).toBe(1);
    await passWith(stale!);
    expect(run).toHaveBeenCalledOnce();
    expect(projectAdmissionCoordinator.inspectProjectStateForTests(PROJECT_ID).reservedCount).toBe(1);

    await settleAll();
    expect(projectAdmissionCoordinator.inspectProjectStateForTests(PROJECT_ID).reservedCount).toBe(0);
  });
});
