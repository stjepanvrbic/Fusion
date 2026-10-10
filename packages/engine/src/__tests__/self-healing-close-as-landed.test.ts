import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { EMPTY_MERGE_NO_LANDED_PROOF_REASON, type Settings, type Task, type TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";

/*
Surface enumeration: this covers the engine seam shared by `fn task close-landed` (CLI) and
`POST /tasks/:id/close-as-landed` (dashboard). Both surfaces only translate its result, so the
eligibility fences, the CAS write and the audit row are asserted here once.
*/

const PARKED_ERROR = `${EMPTY_MERGE_NO_LANDED_PROOF_REASON}; merge agent: main already contains everything on fusion/kb-057.`;

function parkedTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "KB-057",
    title: "Superseded branch",
    description: "",
    column: "in-review",
    status: "failed",
    error: PARKED_ERROR,
    branch: "fusion/kb-057",
    worktree: "/repo/.fusion/worktrees/kb-057",
    dependencies: [],
    steps: [{ name: "Implement", status: "done" }],
    currentStep: 0,
    log: [],
    mergeDetails: {},
    enabledWorkflowSteps: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as unknown as Task;
}

function storeWithTask(task: Task, settings: Partial<Settings> = {}) {
  const tasks = new Map<string, Task>([[task.id, task]]);
  const updateTaskAtomic = vi.fn(async (id: string, updater: (current: Task) => Partial<Task> | undefined) => {
    const current = tasks.get(id)!;
    const patch = updater(current);
    if (!patch) return current;
    const next = { ...current, ...patch } as Task;
    tasks.set(id, next);
    return next;
  });
  const recordRunAuditEvent = vi.fn(async () => undefined);
  const logEntry = vi.fn(async () => undefined);
  const store = Object.assign(new EventEmitter(), {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false, ...settings } as Settings)),
    getTask: vi.fn(async (id: string) => tasks.get(id)),
    updateTask: vi.fn(),
    updateTaskAtomic,
    moveTask: vi.fn(),
    logEntry,
    recordRunAuditEvent,
  }) as unknown as TaskStore & EventEmitter;
  return { store, tasks, updateTaskAtomic, recordRunAuditEvent, logEntry };
}

function manager(store: TaskStore, isTaskActive?: (taskId: string) => boolean) {
  const instance = new SelfHealingManager(store, { rootDir: "/repo", isTaskActive });
  const seams = {
    resolveSelfHealingMergeTarget: vi.fn(async () => ({ branch: "main", source: "project-default" })),
    readBranchTipSha: vi.fn(async () => "5e55bf98463ec87b4f45f1a4aa366c29dc75f9cf"),
    recordSelfHealingBranchGroupMemberLanding: vi.fn(async () => undefined),
    moveToCompleteLaneAfterLandedCleanup: vi.fn(async (task: Task, completeLane: string) => ({ ...task, column: completeLane })),
    emitTaskMerged: vi.fn(),
    reconcileCompletedTask: vi.fn(async () => undefined),
  };
  Object.assign(instance, seams);
  return { instance, seams };
}

describe("SelfHealingManager.closeEmptyMergeParkAsLanded", () => {
  it("finalizes an empty-merge park as a confirmed no-op landing with the operator's reason", async () => {
    const { store, tasks, recordRunAuditEvent, logEntry } = storeWithTask(parkedTask());
    const { instance, seams } = manager(store);

    const result = await instance.closeEmptyMergeParkAsLanded("KB-057", { reason: "KB-062 landed a superset in 029aaa3e6", actor: "cli-operator", source: "cli" });

    expect(result).toEqual({ outcome: "closed", baseBranch: "main", branchTipSha: "5e55bf98463ec87b4f45f1a4aa366c29dc75f9cf" });
    expect(tasks.get("KB-057")).toMatchObject({
      status: null,
      error: null,
      mergeDetails: { mergeConfirmed: true, noOpMerge: true, landedFiles: [], mergeTargetBranch: "main", noOpReason: "closed as already landed by cli-operator: KB-062 landed a superset in 029aaa3e6" },
    });
    expect(tasks.get("KB-057")?.mergeDetails?.commitSha).toBeUndefined();
    expect(seams.moveToCompleteLaneAfterLandedCleanup).toHaveBeenCalledWith(expect.objectContaining({ id: "KB-057" }), "done", "close-as-landed", expect.objectContaining({ mergeConfirmed: true }));
    expect(seams.reconcileCompletedTask).toHaveBeenCalledWith("KB-057", { worktreeHint: "/repo/.fusion/worktrees/kb-057" });
    expect(logEntry).toHaveBeenCalledWith("KB-057", "Closed as already landed by cli-operator (cli): KB-062 landed a superset in 029aaa3e6", expect.stringContaining("5e55bf98463ec87b4f45f1a4aa366c29dc75f9cf"));
    expect(recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:closed-as-landed",
      metadata: { taskId: "KB-057", source: "cli", baseBranch: "main", branchTipSha: "5e55bf98463ec87b4f45f1a4aa366c29dc75f9cf" },
    }));
  });

  it("refuses without a reason and changes nothing", async () => {
    const { store, updateTaskAtomic } = storeWithTask(parkedTask());
    const { instance } = manager(store);

    expect(await instance.closeEmptyMergeParkAsLanded("KB-057", { reason: "   ", actor: "cli-operator", source: "cli" }))
      .toEqual({ outcome: "ineligible", reason: "reason-required" });
    expect(updateTaskAtomic).not.toHaveBeenCalled();
  });

  it.each([
    ["a failed card with a different error", { error: "AI merge blocked: reviewer rejected" }],
    ["an empty-merge error that is no longer failed", { status: null }],
    ["a card whose landing is already confirmed", { mergeDetails: { mergeConfirmed: true, commitSha: "abc" } }],
  ])("refuses %s: only the empty-merge park may be closed this way", async (_label, overrides) => {
    const { store, updateTaskAtomic } = storeWithTask(parkedTask(overrides as Partial<Task>));
    const { instance } = manager(store);

    expect(await instance.closeEmptyMergeParkAsLanded("KB-057", { reason: "superseded", actor: "cli-operator", source: "cli" }))
      .toEqual({ outcome: "ineligible", reason: "not-empty-merge-park" });
    expect(updateTaskAtomic).not.toHaveBeenCalled();
  });

  it.each([
    ["not-in-review", { column: "todo" }],
    ["workspace", { workspaceWorktrees: { app: "/ws/app" } }],
    ["user-paused", { userPaused: true }],
    ["checkout-leased", { checkoutRunId: "run-1", checkoutLeaseRenewedAt: new Date().toISOString() }],
    ["workflow-approval-blocked", { steps: [{ name: "Implement", status: "pending" }] }],
  ])("refuses with %s", async (reason, overrides) => {
    const { store, updateTaskAtomic } = storeWithTask(parkedTask(overrides as Partial<Task>));
    const { instance } = manager(store);

    expect(await instance.closeEmptyMergeParkAsLanded("KB-057", { reason: "superseded", actor: "cli-operator", source: "cli" }))
      .toEqual({ outcome: "ineligible", reason });
    expect(updateTaskAtomic).not.toHaveBeenCalled();
  });

  it("refuses while the engine owns the card in process", async () => {
    const { store } = storeWithTask(parkedTask());
    const { instance } = manager(store, () => true);

    expect(await instance.closeEmptyMergeParkAsLanded("KB-057", { reason: "superseded", actor: "cli-operator", source: "cli" }))
      .toEqual({ outcome: "ineligible", reason: "executing" });
  });

  it("refuses while the engine is paused", async () => {
    const { store } = storeWithTask(parkedTask(), { enginePaused: true });
    const { instance } = manager(store);

    expect(await instance.closeEmptyMergeParkAsLanded("KB-057", { reason: "superseded", actor: "cli-operator", source: "cli" }))
      .toEqual({ outcome: "ineligible", reason: "engine-paused" });
  });

  it("reports raced and moves nothing when the card changes before the write", async () => {
    const { store, tasks } = storeWithTask(parkedTask());
    const { instance, seams } = manager(store);
    seams.readBranchTipSha.mockImplementation(async () => {
      tasks.set("KB-057", { ...tasks.get("KB-057")!, status: null, error: null });
      return "5e55bf98";
    });

    expect(await instance.closeEmptyMergeParkAsLanded("KB-057", { reason: "superseded", actor: "cli-operator", source: "cli" }))
      .toEqual({ outcome: "raced", reason: "task-state-changed" });
    expect(seams.moveToCompleteLaneAfterLandedCleanup).not.toHaveBeenCalled();
  });

  it("still closes when the audit sink throws", async () => {
    const { store, recordRunAuditEvent } = storeWithTask(parkedTask());
    recordRunAuditEvent.mockRejectedValue(new Error("sink down"));
    const { instance } = manager(store);

    expect(await instance.closeEmptyMergeParkAsLanded("KB-057", { reason: "superseded", actor: "dashboard-operator", source: "dashboard" }))
      .toMatchObject({ outcome: "closed" });
  });
});
