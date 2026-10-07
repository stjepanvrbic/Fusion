import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { createTaskDoneTool } from "../executor/create-task-done-tool.js";
import { handleImplicitTaskDoneRefusal } from "../executor/task-done-refusal-handler.js";
import { evaluateTaskDoneRefusal } from "../executor/task-done-refusal.js";

/*
 * FNXC:LifecycleContainment 2026-10-07-18:04:
 * F-CLI-1: completion refusals resolved a rebound column (hold, then intake) and moved the card back
 * without a move source. The old fixture mocked that resolver to return WIP, which hid the backward
 * production destination. The real modules are used here, and the store throws on ANY move, so a
 * regression to a rebound fails on every board shape (built-in or renamed WIP lane, with or without a
 * hold lane): the explicit refusal repairs in its live session, the implicit refusal retries in place,
 * and both keep the checkout evidence through retry exhaustion into a visible failed park.
 */
describe("completion refusal preserves recoverable checkout", () => {
  it.each([
    ["explicit", "in-progress"],
    ["implicit", "in-progress"],
    ["explicit", "building"],
    ["implicit", "building"],
  ] as const)("keeps the %s refusal in its lane (%s) with checkout and pending work through retry exhaustion", async (surface, column) => {
    const task = {
      id: "FN-9349", column, taskDoneRetryCount: 0,
      worktree: "/repo/.worktrees/repair", branch: "fusion/fn-9349",
      steps: [{ name: "Required evidence", status: "in-progress" }, { name: "Verification", status: "pending" }],
    } as Task;
    const originalSteps = structuredClone(task.steps);
    const store = {
      getTask: vi.fn(async () => task),
      updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(task, patch)),
      logEntry: vi.fn(),
      moveTask: vi.fn(async (_id: string, to: string) => {
        throw new Error(`completion refusal must not move the card (attempted ${column} -> ${to})`);
      }),
    } as unknown as TaskStore;
    const onDone = vi.fn();
    const scheduleInPlaceExecutionResume = vi.fn();
    const deps = {
      store, getRunContextFor: () => undefined, persistTokenUsage: vi.fn(),
      markGraphExecuteSelfRequeued: vi.fn(), deleteActiveSession: vi.fn(), clearTokenUsageBaseline: vi.fn(),
      scheduleInPlaceExecutionResume,
      workflowLifecycleMovesInFlight: new Set<string>(), getTaskCompletionBlocker: async () => undefined,
      evaluateTaskVerdictProviders: async () => ({ ok: true as const }),
      verifyWorktreeInvariants: async () => ({ ok: true as const }),
      evaluateTaskDoneScopeLeak: async () => ({ blocked: false as const }),
      scheduleCompletedTaskWatchdog: vi.fn(), finalizeAcceptedNoOpCompletion: vi.fn(),
    };
    const tool = createTaskDoneTool(deps, task.id, task.worktree!, "", new Map(), onDone);
    for (let attempt = 0; attempt < 4; attempt++) {
      if (surface === "explicit") {
        await tool.execute("done", { summary: "Pending evidence" });
      } else {
        const refusal = evaluateTaskDoneRefusal(task, {}, new Map());
        if (refusal.ok) throw new Error("Expected pending-step refusal");
        await handleImplicitTaskDoneRefusal(deps, task, refusal);
      }
      expect(task.column).toBe(column);
      expect(task.worktree).toBe("/repo/.worktrees/repair");
      expect(task.branch).toBe("fusion/fn-9349");
      expect(task.steps).toEqual(originalSteps);
      expect(task.taskDoneRetryCount).toBe(Math.min(attempt + 1, 3));
      if (attempt < 3) {
        // Explicit refusals stay in the live session; implicit ones (the session already exited) are re-dispatched in place.
        expect(task.status).toBe(surface === "explicit" ? undefined : "queued");
      } else {
        expect(task.status).toBe("failed");
      }
    }
    expect(onDone).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(scheduleInPlaceExecutionResume).toHaveBeenCalledTimes(surface === "implicit" ? 3 : 0);
    expect(task.error).toContain("bulk-step-completion-without-review");
  });
});
