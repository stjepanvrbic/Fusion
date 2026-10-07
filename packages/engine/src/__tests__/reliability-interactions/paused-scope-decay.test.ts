import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";

type AuditEvent = { mutationType: string; taskId?: string; metadata?: Record<string, unknown> };

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    log: [],
    ...overrides,
  } as Task;
}

function makeStore(tasks: Task[], settings: Partial<Settings> = {}) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const audits: AuditEvent[] = [];
  const emitter = new EventEmitter();
  const store = Object.assign(emitter, {
    getSettings: vi.fn(async () => ({
      globalPause: false,
      enginePaused: false,
      pausedScopeDecayMs: 30 * 60_000,
      ...settings,
    })),
    listTasks: vi.fn(async ({ column, includeArchived }: any = {}) =>
      [...byId.values()].filter((task) => {
        if (column && task.column !== column) return false;
        if (includeArchived === false && task.column === "archived") return false;
        return true;
      }),
    ),
    moveTask: vi.fn(async (id: string, column: Task["column"], _opts?: any) => {
      byId.set(id, { ...byId.get(id)!, column, paused: false, pausedReason: undefined, blockedBy: undefined, overlapBlockedBy: undefined } as Task);
      return byId.get(id)!;
    }),
    updateTask: vi.fn(async (id: string, updates: Partial<Task>) => {
      byId.set(id, { ...byId.get(id)!, ...updates } as Task);
      return byId.get(id)!;
    }),
    getTask: vi.fn(async (id: string) => byId.get(id)),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async (event: any) => {
      audits.push({ mutationType: event.mutationType, taskId: event.taskId, metadata: event.metadata });
    }),
  });

  return { store: store as unknown as TaskStore & EventEmitter, byId, audits };
}

describe("reliability interactions: paused scope decay", () => {
  it("reports a stale paused holder once as no-action and never claims a recovery it did not make", async () => {
    const now = Date.now();
    const holder = makeTask("FN-1", {
      column: "in-progress",
      paused: true,
      pausedReason: "waiting",
      executionStartedAt: new Date(now - 31 * 60_000).toISOString(),
      columnMovedAt: new Date(now - 31 * 60_000).toISOString(),
      currentStep: 2,
      steps: [{ id: "s1", title: "x", status: "done" } as any],
      worktree: "/tmp/wt",
    });
    const follower = makeTask("FN-2", { column: "todo", blockedBy: "FN-1", status: "queued" });
    const { store, byId, audits } = makeStore([holder, follower]);
    const manager = new SelfHealingManager(store, { rootDir: process.cwd(), getExecutingTaskIds: () => new Set() });

    /*
    FNXC:LifecycleContainment 2026-10-07-18:04:
    The sweep has no in-place repair for a paused WIP holder (FN-217 removed the rebound), so it
    must not count a recovery, log "Auto-rebounded", or emit the success audit while the follower
    stays blocked. It reports one no-action and stays silent on an unchanged second pass.
    */
    expect(await manager.autoReboundPausedScopeDecay()).toBe(0);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalledWith("FN-1", expect.stringContaining("Auto-rebounded"));
    expect(audits.some((event) => event.mutationType === "task:auto-rebound-paused-scope-decay")).toBe(false);
    const noAction = audits.filter((event) => event.mutationType === "task:auto-rebound-scope-decay-no-action");
    expect(noAction).toHaveLength(1);

    expect(await manager.autoReboundPausedScopeDecay()).toBe(0);
    expect(audits.filter((event) => event.mutationType === "task:auto-rebound-scope-decay-no-action")).toHaveLength(1);

    expect(byId.get("FN-1")).toMatchObject({ column: "in-progress", paused: true, currentStep: 2, worktree: "/tmp/wt" });
    expect(byId.get("FN-2")?.blockedBy).toBe("FN-1");
  });

  it("supports ignoreAgeGate override", async () => {
    const now = Date.now();
    const holder = makeTask("FN-3", {
      column: "in-progress",
      paused: true,
      executionStartedAt: new Date(now - 61_000).toISOString(),
      columnMovedAt: new Date(now - 1_000).toISOString(),
    });
    const follower = makeTask("FN-4", { column: "todo", blockedBy: "FN-3" });
    const { store } = makeStore([holder, follower], { pausedScopeDecayMs: 60_000 });
    const manager = new SelfHealingManager(store, { rootDir: process.cwd(), getExecutingTaskIds: () => new Set() });

    expect(await manager.autoReboundPausedScopeDecay()).toBe(0);
    // The age-gate override reaches the candidate; it still reports no-action instead of a false recovery.
    expect(await manager.autoReboundPausedScopeDecay({ ignoreAgeGate: true })).toBe(0);
    expect(store.logEntry).toHaveBeenCalledWith("FN-3", expect.stringContaining("cannot move it backward"));
  });

  it("no-op when there are no followers", async () => {
    const now = Date.now();
    const holder = makeTask("FN-5", { column: "in-progress", paused: true, columnMovedAt: new Date(now - 31 * 60_000).toISOString() });
    const unrelated = makeTask("FN-6", { column: "todo", blockedBy: "FN-X" });
    const { store } = makeStore([holder, unrelated]);
    const manager = new SelfHealingManager(store, { rootDir: process.cwd(), getExecutingTaskIds: () => new Set() });
    expect(await manager.autoReboundPausedScopeDecay()).toBe(0);
  });

  it.each([
    { name: "threshold disabled", holder: { paused: true }, settings: { pausedScopeDecayMs: 0 } },
    { name: "excluded paused reason", holder: { paused: true, pausedReason: "branch-conflict-unrecoverable" as const } },
    { name: "not paused", holder: { paused: false } },
    { name: "age below threshold", holder: { paused: true }, settings: { pausedScopeDecayMs: 60_000 }, ageMs: 500 },
    // FN-7736: the canonical approval-hold reason must be excluded too.
    { name: "approval-held (canonical reason)", holder: { paused: true, pausedReason: "awaiting-approval" as const } },
  ])("no-op: $name", async ({ holder, settings, ageMs }) => {
    const now = Date.now();
    const effectiveAgeMs = ageMs ?? 31 * 60_000;
    const pausedHolder = makeTask("FN-8", {
      column: "in-progress",
      columnMovedAt: new Date(now - effectiveAgeMs).toISOString(),
      ...holder,
    });
    const follower = makeTask("FN-9", { column: "todo", blockedBy: "FN-8" });
    const { store } = makeStore([pausedHolder, follower], settings);
    const manager = new SelfHealingManager(store, { rootDir: process.cwd(), getExecutingTaskIds: () => new Set() });
    expect(await manager.autoReboundPausedScopeDecay()).toBe(0);
  });

  /*
   * FNXC:ApprovalHold 2026-07-09-00:20:
   * FN-7736 symptom-verification regression. Reproduces the exact original
   * failure shape (approval-held in-progress task, no pausedReason, follower
   * present, decay threshold elapsed) alongside a same-shaped control task
   * that IS paused but for an unrelated (non-approval) reason, proving the
   * assertion actually exercises the exclusion mechanism rather than a
   * vacuously-true "nothing ever reboundeds" check.
   */
  it("symptom verification: leaves approval-held and automatic recovery control tasks in place", async () => {
    const now = Date.now();
    const approvalHeld = makeTask("FN-APPROVAL", {
      column: "in-progress",
      paused: true,
      pausedReason: "awaiting-approval",
      executionStartedAt: new Date(now - 31 * 60_000).toISOString(),
      columnMovedAt: new Date(now - 31 * 60_000).toISOString(),
    });
    const approvalFollower = makeTask("FN-APPROVAL-FOLLOWER", { column: "todo", blockedBy: "FN-APPROVAL" });
    const controlPaused = makeTask("FN-CONTROL", {
      column: "in-progress",
      paused: true,
      pausedReason: "some-other-reason",
      executionStartedAt: new Date(now - 31 * 60_000).toISOString(),
      columnMovedAt: new Date(now - 31 * 60_000).toISOString(),
    });
    const controlFollower = makeTask("FN-CONTROL-FOLLOWER", { column: "todo", blockedBy: "FN-CONTROL" });
    const { store, byId } = makeStore([approvalHeld, approvalFollower, controlPaused, controlFollower]);
    const manager = new SelfHealingManager(store, { rootDir: process.cwd(), getExecutingTaskIds: () => new Set() });

    const count = await manager.autoReboundPausedScopeDecay();

    // Approval holds are excluded; the control reaches the candidate and is reported, never counted as recovered.
    expect(count).toBe(0);
    expect(store.logEntry).not.toHaveBeenCalledWith("FN-APPROVAL", expect.anything());
    expect(store.logEntry).toHaveBeenCalledWith("FN-CONTROL", expect.stringContaining("cannot move it backward"));
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(byId.get("FN-APPROVAL")?.column).toBe("in-progress");
    expect(byId.get("FN-APPROVAL")?.paused).toBe(true);
    expect(byId.get("FN-APPROVAL")?.pausedReason).toBe("awaiting-approval");
    expect(byId.get("FN-CONTROL")?.column).toBe("in-progress");
  });
});
