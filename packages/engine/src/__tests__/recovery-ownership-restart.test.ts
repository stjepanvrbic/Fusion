import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { resumeOrphaned } from "../executor/resume-orphaned.js";
import { getExecutingTaskIds, isTaskActive } from "../executor/task-liveness.js";
import { RestartRecoveryCoordinator } from "../healing/restart-recovery-coordinator.js";
import { MAX_RECOVERY_RETRIES } from "../healing/recovery-policy.js";
import { createRecoveryFakeStore } from "./_recovery-fake-store.js";

/*
 * FNXC:RecoveryOwnership 2026-10-07-18:04:
 * Restart recovery honors the same recovery contract as live execution: an exhausted episode stays
 * parked, a retry backoff keeps its deadline, a deferred resume is live until it starts, and the
 * startup sweeps run before orphan resumption instead of racing it.
 */
function orphanDeps(tasks: Task[], fake: ReturnType<typeof createRecoveryFakeStore>) {
  return {
    store: fake.store,
    executing: new Set<string>(),
    recoveringCompleted: new Set<string>(),
    processWideGraphRouting: new Set<string>(),
    pendingOrphanResumes: new Set<string>(),
    listWipLaneTasks: async () => tasks,
    clearResumeFailureState: vi.fn(async () => undefined),
    recoverApprovedStepsOnResume: async () => undefined,
    recoverCompletedTask: async () => false,
    execute: vi.fn(async () => undefined),
    scheduleInPlaceExecutionResume: vi.fn(),
  };
}

describe("restart recovery and the recovery contract", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.FUSION_RESUME_ORPHAN_DELAY_MS;
  });

  it("leaves an exhausted-recovery park parked instead of spending an attempt per restart", async () => {
    const parked = { id: "FN-PARKED", column: "in-progress", status: "failed", recoveryRetryCount: 2 * MAX_RECOVERY_RETRIES + 1, steps: [] } as unknown as Task;
    const fake = createRecoveryFakeStore(parked);
    const deps = orphanDeps([parked], fake);
    await resumeOrphaned(deps);
    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.clearResumeFailureState).not.toHaveBeenCalled();
  });

  it("re-arms an in-place retry whose backoff has not elapsed instead of executing now", async () => {
    const waiting = { id: "FN-WAIT", column: "in-progress", recoveryRetryCount: 1, nextRecoveryAt: new Date(Date.now() + 60_000).toISOString(), steps: [] } as unknown as Task;
    const fake = createRecoveryFakeStore(waiting);
    const deps = orphanDeps([waiting], fake);
    await resumeOrphaned(deps);
    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.scheduleInPlaceExecutionResume).toHaveBeenCalledWith("FN-WAIT");
  });

  it("reports a deferred orphan resume as live until it starts", async () => {
    vi.useFakeTimers();
    process.env.FUSION_RESUME_ORPHAN_DELAY_MS = "30000";
    const orphan = { id: "FN-ORPH", title: "orphan", description: "orphan", column: "in-progress", steps: [] } as unknown as Task;
    const fake = createRecoveryFakeStore(orphan);
    const deps = orphanDeps([orphan], fake);
    await resumeOrphaned(deps);

    const liveness = {
      executing: new Set<string>(),
      recoveringCompleted: new Set<string>(),
      resumingUnpaused: new Set<string>(),
      activeSessions: new Map<string, unknown>(),
      activePlanningWorkflowSessions: new Set<string>(),
      activeWorkflowStepSessions: new Map<string, unknown>(),
      processWideGraphRouting: new Set<string>(),
      pendingOrphanResumes: deps.pendingOrphanResumes,
      inPlaceExecutionResumeTimers: new Map<string, unknown>(),
    };
    expect(isTaskActive(liveness, "FN-ORPH")).toBe(true);
    expect(getExecutingTaskIds(liveness).has("FN-ORPH")).toBe(true);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(deps.execute).toHaveBeenCalledOnce();
    expect(isTaskActive(liveness, "FN-ORPH")).toBe(false);
  });

  it("resumes only cards that were orphaned at boot and have not moved since", async () => {
    const atBoot = { id: "FN-BOOT", title: "boot", description: "boot", column: "in-progress", columnMovedAt: "2026-10-01T00:00:00.000Z", steps: [] } as unknown as Task;
    const movedLater = { id: "FN-LATER", title: "later", description: "later", column: "in-progress", columnMovedAt: "2026-10-07T12:00:00.000Z", steps: [] } as unknown as Task;
    const rebounced = { id: "FN-REMOVED", title: "re", description: "re", column: "in-progress", columnMovedAt: "2026-10-07T12:05:00.000Z", steps: [] } as unknown as Task;
    const fake = createRecoveryFakeStore(atBoot);
    const deps = orphanDeps([atBoot, movedLater, rebounced], fake);
    const bootSnapshot = new Map<string, string | null>([
      ["FN-BOOT", "2026-10-01T00:00:00.000Z"],
      ["FN-REMOVED", "2026-10-01T00:00:00.000Z"],
    ]);
    await resumeOrphaned(deps, { bootSnapshot });
    expect(deps.execute).toHaveBeenCalledTimes(1);
    expect(deps.execute).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-BOOT" }));
  });

  it("can stop before orphan resumption so startup sweeps run first, and retries in place", async () => {
    const interrupted = {
      id: "FN-INT",
      column: "in-progress",
      status: "failed",
      error: "Agent finished without calling fn_task_done",
      worktree: "/wt",
      branch: "fusion/fn-int",
      steps: [{ name: "s", status: "pending" }],
    } as unknown as Task;
    const fake = createRecoveryFakeStore(interrupted);
    (fake.store as unknown as { listTasks: unknown }).listTasks = vi.fn(async () => [fake.task]);
    const executor = { resumeOrphaned: vi.fn(async () => undefined) };
    const coordinator = new RestartRecoveryCoordinator(fake.store, executor as never);

    await coordinator.recoverInterruptedRuns({ resumeOrphans: false });
    expect(executor.resumeOrphaned).not.toHaveBeenCalled();
    expect(fake.moves).toEqual([]);
    expect(fake.task.column).toBe("in-progress");
    expect(fake.task.status).toBeUndefined();
    expect(fake.task.worktree).toBeUndefined();

    await coordinator.resumeOrphaned();
    expect(executor.resumeOrphaned).toHaveBeenCalledOnce();
  });
});
