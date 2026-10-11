import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowWorkItem } from "@fusion/core";
import { projectAdmissionCoordinator, type AdmissionCandidate } from "../concurrency/concurrency.js";
import {
  FILE_SCOPE_CONTINUATION_WAIT_PREFIX,
  createPlanningContinuationRun,
  registerContinuationAdmissionProvider,
  releaseFileScopeWaitingContinuations,
  settlePlanningContinuationDispatch,
} from "../runtimes/in-process-runtime.js";

/*
FNXC:OverlapWaitSynchronization 2026-09-17-01:25:
Reimplemented for FN-329 "fix immediate file-scope continuation wake", the prerequisite this
branch's FN-332 cherry-pick also excluded. Covers the park-on-settle / wake-on-release pair that
lets a file-scope-blocked continuation sleep instead of busy-polling.
*/

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id, column: "in-progress", description: id, dependencies: [],
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    ...patch,
  } as Task;
}

describe("settlePlanningContinuationDispatch", () => {
  it("parks the item held with a file-scope reason when the task is still queued behind its overlap blocker", async () => {
    const transitionWorkflowWorkItem = vi.fn(async (_id: string, state: string, patch: Record<string, unknown>) => ({
      id: "item-1", state, blockedReason: patch.blockedReason,
    } as unknown as WorkflowWorkItem));
    const store = {
      getTask: vi.fn(async () => task("FN-WAITING", { status: "queued", overlapBlockedBy: "FN-A" })),
      transitionWorkflowWorkItem,
    } as unknown as TaskStore;
    const kick = vi.fn();

    const outcome = await settlePlanningContinuationDispatch({ store, taskId: "FN-WAITING", itemId: "item-1", kick });

    expect(outcome).toBe("waiting");
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith("item-1", "held", expect.objectContaining({
      expectedState: "running",
      blockedReason: `${FILE_SCOPE_CONTINUATION_WAIT_PREFIX}FN-A`,
    }));
    expect(kick).not.toHaveBeenCalled();
  });

  it("returns the item to runnable and kicks the drain when the task is no longer queued", async () => {
    const transitionWorkflowWorkItem = vi.fn(async (_id: string, state: string) => ({ id: "item-1", state, blockedReason: null } as unknown as WorkflowWorkItem));
    const store = {
      getTask: vi.fn(async () => task("FN-WAITING", { status: undefined })),
      transitionWorkflowWorkItem,
    } as unknown as TaskStore;
    const kick = vi.fn();

    const outcome = await settlePlanningContinuationDispatch({ store, taskId: "FN-WAITING", itemId: "item-1", kick });

    expect(outcome).toBe("runnable");
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith("item-1", "runnable", expect.objectContaining({ expectedState: "running", blockedReason: null }));
    expect(kick).toHaveBeenCalledOnce();
  });

  it("is a no-op when the store cannot transition work items or the task is deleted", async () => {
    expect(await settlePlanningContinuationDispatch({ store: {} as TaskStore, taskId: "FN-1", itemId: "item-1" })).toBe("unchanged");
    const store = {
      getTask: vi.fn(async () => task("FN-1", { deletedAt: "2026-09-01T00:00:00.000Z" } as Partial<Task>)),
      transitionWorkflowWorkItem: vi.fn(),
    } as unknown as TaskStore;
    expect(await settlePlanningContinuationDispatch({ store, taskId: "FN-1", itemId: "item-1" })).toBe("unchanged");
    expect(store.transitionWorkflowWorkItem).not.toHaveBeenCalled();
  });
});

describe("releaseFileScopeWaitingContinuations", () => {
  it("wakes only held items whose blockedReason names the cleared blocker, on a task whose marker actually cleared", async () => {
    const items: WorkflowWorkItem[] = [
      { id: "item-match", state: "held", blockedReason: `${FILE_SCOPE_CONTINUATION_WAIT_PREFIX}FN-A` } as WorkflowWorkItem,
      { id: "item-other-blocker", state: "held", blockedReason: `${FILE_SCOPE_CONTINUATION_WAIT_PREFIX}FN-B` } as WorkflowWorkItem,
      { id: "item-not-held", state: "runnable", blockedReason: `${FILE_SCOPE_CONTINUATION_WAIT_PREFIX}FN-A` } as WorkflowWorkItem,
    ];
    const transitionWorkflowWorkItem = vi.fn(async (id: string, state: string) => ({ id, state } as unknown as WorkflowWorkItem));
    const store = {
      getTask: vi.fn(async () => task("FN-WAITING", { overlapBlockedBy: undefined })),
      listWorkflowWorkItemsForTask: vi.fn(async () => items),
      transitionWorkflowWorkItem,
    } as unknown as TaskStore;

    const released = await releaseFileScopeWaitingContinuations(store, [{ taskId: "FN-WAITING", blockerId: "FN-A" }]);

    expect(released).toEqual(["item-match"]);
    expect(transitionWorkflowWorkItem).toHaveBeenCalledTimes(1);
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith("item-match", "runnable", expect.objectContaining({ expectedState: "held", blockedReason: null }));
  });

  it("refuses to release while the task's overlap blocker marker is still set", async () => {
    const store = {
      getTask: vi.fn(async () => task("FN-WAITING", { overlapBlockedBy: "FN-A" })),
      listWorkflowWorkItemsForTask: vi.fn(async () => []),
      transitionWorkflowWorkItem: vi.fn(),
    } as unknown as TaskStore;

    const released = await releaseFileScopeWaitingContinuations(store, [{ taskId: "FN-WAITING", blockerId: "FN-A" }]);

    expect(released).toEqual([]);
    expect(store.listWorkflowWorkItemsForTask).not.toHaveBeenCalled();
  });
});

/*
FNXC:ContinuationWaitPark 2026-10-11-00:51:
The outer dispatch gates (file scope, dependencies) hold a card in place BEFORE the graph claims its
continuation, so the work item is still in the state the due poll saw when the dispatch settles.
Live incident: four planned cards queued behind one in-review file-scope holder stayed `runnable`, were
re-dispatched every few seconds as the oldest planning-lane candidates, and took every free slot, so no
newer Plan Review, planning continuation, or new planning session was admitted for hours.
*/
type CasItem = WorkflowWorkItem & { state: WorkflowWorkItem["state"] };

/** An in-memory work-item store with the real compare-and-set contract: a mismatch returns the row untouched. */
function casStore(tasks: Task[], items: CasItem[]) {
  const transitionWorkflowWorkItem = vi.fn(async (id: string, state: WorkflowWorkItem["state"], patch: Record<string, unknown> = {}) => {
    const row = items.find((entry) => entry.id === id)!;
    if (patch.expectedState !== undefined && row.state !== patch.expectedState) return { ...row };
    Object.assign(row, { state, blockedReason: patch.blockedReason ?? null, retryAfter: patch.retryAfter ?? null });
    return { ...row };
  });
  const store = {
    getSettings: vi.fn(async () => ({ maxConcurrent: 4, maxWorktrees: 12, worktreeLimitEnabled: false })),
    listTasks: vi.fn(async () => tasks),
    getTask: vi.fn(async (taskId: string) => tasks.find((candidate) => candidate.id === taskId)),
    listDueWorkflowWorkItems: vi.fn(async () => items
      .filter((entry) => entry.state === "runnable" || entry.state === "retrying")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((entry) => ({ ...entry }))),
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    getWorkflowDefinition: vi.fn(async () => undefined),
    transitionWorkflowWorkItem,
    logEntry: vi.fn(async () => undefined),
  } as unknown as TaskStore;
  return { store, transitionWorkflowWorkItem };
}

function planReviewItem(taskId: string, createdAt: string): CasItem {
  return {
    id: `wi-${taskId}`, runId: `run-${taskId}`, taskId, nodeId: "plan-review", kind: "task",
    state: "runnable", waitReason: "planning", blockedReason: null, retryAfter: null,
    createdAt, updatedAt: createdAt,
  } as unknown as CasItem;
}

describe("settlePlanningContinuationDispatch after an outer dispatch gate held the card", () => {
  it.each([
    ["file scope", { overlapBlockedBy: "KB-080" }, `${FILE_SCOPE_CONTINUATION_WAIT_PREFIX}KB-080`],
    ["dependency", { blockedBy: "KB-012" }, "dependency:KB-012"],
  ] as const)("parks the still-unclaimed item held behind its %s blocker", async (_label, marker, reason) => {
    const waiting = task("KB-064", { column: "todo", status: "queued", ...marker });
    const item = planReviewItem("KB-064", "2026-10-08T18:54:50.381Z");
    const { store } = casStore([waiting], [item]);
    const kick = vi.fn();

    const outcome = await settlePlanningContinuationDispatch({ store, taskId: "KB-064", itemId: item.id, dispatchedState: "runnable", kick });

    expect(outcome).toBe("waiting");
    expect(item.state).toBe("held");
    expect(item.blockedReason).toBe(reason);
    expect(kick).not.toHaveBeenCalled();
  });

  it("leaves an unclaimed item untouched when the card is not waiting on a blocker", async () => {
    const item = planReviewItem("KB-103", "2026-10-10T23:08:13.181Z");
    const { store, transitionWorkflowWorkItem } = casStore([task("KB-103", { column: "todo" })], [item]);

    await settlePlanningContinuationDispatch({ store, taskId: "KB-103", itemId: item.id, dispatchedState: "runnable" });

    expect(item.state).toBe("runnable");
    expect(transitionWorkflowWorkItem.mock.calls.every(([, , patch]) => (patch as { expectedState?: string }).expectedState === "running")).toBe(true);
  });
});

describe("planning-lane admission with continuations queued behind a file-scope holder", () => {
  const PROJECT_ID = "/test/file-scope-continuation-starvation";
  const unregisters: Array<() => void> = [];

  afterEach(() => {
    unregisters.splice(0).forEach((unregister) => unregister());
    projectAdmissionCoordinator.clearReservationsForTests();
  });

  it("admits a newer plan review and a new planning session once the gated continuations park", async () => {
    const holder = task("KB-080", { column: "in-progress" });
    const gatedIds = ["KB-064", "KB-095", "KB-076", "KB-099"];
    const tasks = [holder, ...gatedIds.map((id) => task(id, { column: "todo" })), task("KB-103", { column: "todo" })];
    const items = [
      ...gatedIds.map((id, index) => planReviewItem(id, `2026-10-08T18:5${index}:00.000Z`)),
      planReviewItem("KB-103", "2026-10-10T23:08:13.181Z"),
    ];
    const { store } = casStore(tasks, items);
    const executed: string[] = [];
    const execute = vi.fn(async (dispatched: Task) => {
      executed.push(dispatched.id);
      const live = tasks.find((candidate) => candidate.id === dispatched.id)!;
      if (gatedIds.includes(live.id)) {
        Object.assign(live, { status: "queued", overlapBlockedBy: holder.id });
        return;
      }
      Object.assign(items.find((entry) => entry.taskId === live.id)!, { state: "succeeded" });
    });
    unregisters.push(registerContinuationAdmissionProvider({
      store,
      projectId: PROJECT_ID,
      isDispatchOpen: () => true,
      run: createPlanningContinuationRun({ store, execute }),
    }));
    const planningStart = vi.fn(async () => true);

    for (let pass = 0; pass < gatedIds.length + 2; pass += 1) {
      await projectAdmissionCoordinator.admitNext({
        projectId: PROJECT_ID,
        maxConcurrent: 4,
        claimed: () => 1,
        claimedTaskIds: () => [holder.id],
        refresh: async (): Promise<AdmissionCandidate[]> => [{
          taskId: "KB-110",
          projectId: PROJECT_ID,
          lane: "planning",
          createdAt: "2026-10-10T23:30:00.000Z",
          start: planningStart,
        }],
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(executed).toContain("KB-103");
    expect(planningStart).toHaveBeenCalledOnce();
    for (const id of gatedIds) {
      expect(executed.filter((entry) => entry === id), id).toHaveLength(1);
      expect(items.find((entry) => entry.taskId === id), id).toMatchObject({ state: "held", blockedReason: `${FILE_SCOPE_CONTINUATION_WAIT_PREFIX}KB-080` });
    }
  });
});
