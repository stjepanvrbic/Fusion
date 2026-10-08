import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { parkCompletedBlockedTask } from "../executor/completion-finalization.js";
import { blockOuterDispatchWhenEphemeralDisabled } from "../executor/block-outer-dispatch-when-ephemeral-disabled.js";
import { routeResetParsePinMismatchToRetry } from "../executor/route-reset-parse-pin-mismatch.js";
import { handleImplicitTaskDoneRefusal, MAX_TASK_DONE_REQUEUE_RETRIES } from "../executor/task-done-refusal-handler.js";
import { handleDepAbortCleanup } from "../executor/dep-abort-cleanup.js";
import { COMPLETED_BLOCKED_PAUSE_REASON } from "../self-healing.js";
import { createRecoveryFakeStore } from "./_recovery-fake-store.js";

/*
 * FNXC:LifecycleContainment 2026-10-07-18:04:
 * Each executor recovery surface that used to move a WIP card back to the hold lane (rejected by
 * FN-207's F5 rule for every reason but Plan Review REVISE, or silently allowed through the
 * optionless fail-open route) now completes its recovery in place. The fake store throws on any
 * moveTask, so a regression to a backward move fails here, exactly as the real policy would reject it.
 */
describe("executor recovery stays in the WIP lane", () => {
  it("completed-blocked work parks in place instead of throwing on a rejected hold move", async () => {
    const fake = createRecoveryFakeStore({
      id: "FN-CB",
      column: "in-progress",
      steps: [{ name: "s1", status: "done" }] as Task["steps"],
    });
    const parked = await parkCompletedBlockedTask(
      { store: fake.store, getRunContextFor: () => undefined, getTaskCompletionBlocker: async () => "dependency FN-1 unmet" },
      fake.task,
      "dependency FN-1 unmet",
      "finalization",
      true,
    );
    expect(parked).toBe(true);
    expect(fake.moves).toEqual([]);
    expect(fake.task).toMatchObject({ column: "in-progress", paused: true, pausedReason: COMPLETED_BLOCKED_PAUSE_REASON, status: "queued" });
  });

  it("the ephemeral-disabled dispatch block holds in place with a visible queued status", async () => {
    const fake = createRecoveryFakeStore({ id: "FN-EPH", column: "in-progress" });
    fake.raw.getSettings.mockResolvedValue({ ephemeralAgentsEnabled: false } as never);
    const blocked = await blockOuterDispatchWhenEphemeralDisabled({ store: fake.store, getRunContextFor: () => undefined }, fake.task);
    expect(blocked).toBe(true);
    expect(fake.moves).toEqual([]);
    expect(fake.task).toMatchObject({ column: "in-progress", status: "queued" });
  });

  it("a stale parse-pin mismatch retries parse in place and schedules the resume", async () => {
    const fake = createRecoveryFakeStore({ id: "FN-PIN", column: "in-progress", status: "failed", error: "pin mismatch" });
    const scheduleInPlaceExecutionResume = vi.fn();
    const handled = await routeResetParsePinMismatchToRetry({
      store: fake.store,
      getRunContextFor: () => undefined,
      clearPausedAborted: () => undefined,
      activeWorktrees: new Map(),
      persistTokenUsage: async () => undefined,
      scheduleInPlaceExecutionResume,
    }, fake.task as never);
    expect(handled).toBe(true);
    expect(fake.moves).toEqual([]);
    expect(fake.task.status).toBeUndefined();
    expect(scheduleInPlaceExecutionResume).toHaveBeenCalledWith("FN-PIN");
  });

  it("an implicit completion refusal retries in place and still exhausts into a failed park", async () => {
    const fake = createRecoveryFakeStore({ id: "FN-REF", column: "in-progress", taskDoneRetryCount: 0 });
    const deps = {
      store: fake.store,
      getRunContextFor: () => undefined,
      markGraphExecuteSelfRequeued: vi.fn(),
      persistTokenUsage: async () => undefined,
      deleteActiveSession: () => undefined,
      clearTokenUsageBaseline: () => undefined,
      scheduleInPlaceExecutionResume: vi.fn(),
    };
    const refusal = { ok: false, message: "steps incomplete", reason: "incomplete", refusalClass: "incomplete-steps" } as never;
    for (let i = 0; i < MAX_TASK_DONE_REQUEUE_RETRIES; i++) {
      await handleImplicitTaskDoneRefusal(deps, fake.task, refusal);
    }
    expect(fake.moves).toEqual([]);
    expect(deps.scheduleInPlaceExecutionResume).toHaveBeenCalledTimes(MAX_TASK_DONE_REQUEUE_RETRIES);
    await handleImplicitTaskDoneRefusal(deps, fake.task, refusal);
    expect(fake.task).toMatchObject({ status: "failed", column: "in-progress" });
  });

  it("a dependency abort discards progress in place and holds on the new dependency", async () => {
    const fake = createRecoveryFakeStore({
      id: "FN-DEP",
      column: "in-progress",
      dependencies: ["FN-BLOCKER"],
      steps: [{ name: "s1", status: "done" }, { name: "s2", status: "in-progress" }] as Task["steps"],
      currentStep: 1,
      sessionFile: "/session.jsonl",
    });
    const blocker = { id: "FN-BLOCKER", column: "todo", dependencies: [], steps: [] } as unknown as Task;
    const store = fake.store as unknown as Record<string, unknown>;
    store.listTasks = vi.fn(async () => [fake.task, blocker]);
    store.taskDir = (id: string) => `/tasks/${id}`;
    store.resetPromptCheckboxes = vi.fn(async () => undefined);
    store.clearStaleExecutionStartBranchReferences = vi.fn(async () => undefined);
    const scheduleInPlaceExecutionResume = vi.fn();
    await handleDepAbortCleanup({
      rootDir: "/repo",
      store: fake.store,
      activeWorktrees: new Map(),
      removeOwnWorktreeWithReconcile: async () => undefined,
      getRunContextFor: () => undefined,
      markGraphExecuteSelfRequeued: vi.fn(),
      scheduleInPlaceExecutionResume,
    }, "FN-DEP", "/wt/fn-dep");

    expect(fake.moves).toEqual([]);
    expect(fake.task.column).toBe("in-progress");
    expect(fake.task.steps.map((step) => step.status)).toEqual(["pending", "pending"]);
    expect(fake.task.currentStep).toBe(0);
    expect(fake.task.sessionFile).toBeUndefined();
    expect(fake.task).toMatchObject({ status: "queued", blockedBy: "FN-BLOCKER" });
    expect(scheduleInPlaceExecutionResume).not.toHaveBeenCalled();
  });
});
