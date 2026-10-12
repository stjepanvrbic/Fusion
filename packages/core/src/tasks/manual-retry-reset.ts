import type { Task } from "../types.js";
import type { TaskStore } from "../store.js";
import { rearmNoVerdictRecoveryBudget } from "../workflows/workflow-step-results.js";

export const IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON = "in-review-stall-deadlock";
export const BRANCH_CONFLICT_UNRECOVERABLE_PAUSE_REASON = "branch-conflict-unrecoverable";

export const MANUAL_RETRY_RESET_COUNTER_KEYS = [
  "stuckKillCount",
  "resumeLimboCount",
  "executeRequeueLoopCount",
  "graphResumeRetryCount",
  "consecutiveToolFailureRetryCount",
  "recoveryRetryCount",
  "sessionContentionHoldCount",
  "externalBlockAutoResumeCount",
  "taskDoneRetryCount",
  "worktreeSessionRetryCount",
  "workflowStepRetries",
  "verificationFailureCount",
  "postReviewFixCount",
  "planReviewReplanCount",
  "mergeConflictBounceCount",
  "branchConflictRecoveryCount",
  "reviewerContextRetryCount",
  "reviewerFallbackRetryCount",
  "reviewConvergenceStage",
  "reviewConvergenceEscalationCount",
  "completionHandoffLimboRecoveryCount",
  "mergeAuditBounceCount",
] as const satisfies ReadonlyArray<keyof Task>;

export function buildAutoPauseClearPatch(
  task: Pick<Task, "paused" | "userPaused" | "pausedReason">,
): Partial<Task> {
  if (
    task.paused === true
    && task.userPaused !== true
    && (
      task.pausedReason === IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON
      || task.pausedReason === BRANCH_CONFLICT_UNRECOVERABLE_PAUSE_REASON
    )
  ) {
    return {
      paused: false,
      pausedReason: null as unknown as Task["pausedReason"],
    };
  }

  return {};
}

/**
 * FNXC:ReviewRecovery 2026-10-12-03:50:
 * Patch that gives a retried card a fresh no-verdict review retry budget and keeps its review history.
 * Empty when the card has no failed, verdict-less pre-merge review result, so a retry of any other card writes no step results.
 * For operator retry writes only, computed from the live row inside the task lock.
 */
export function buildNoVerdictBudgetRearmPatch(
  task: Pick<Task, "workflowStepResults">,
  rearmedAt: string = new Date().toISOString(),
): Pick<Partial<Task>, "workflowStepResults"> {
  const workflowStepResults = rearmNoVerdictRecoveryBudget(task.workflowStepResults, rearmedAt);
  return workflowStepResults === task.workflowStepResults ? {} : { workflowStepResults };
}

/*
FNXC:BranchConflictRecoveryFence 2026-10-01-08:15:
A manual retry may race a scheduler that inspected the prior branch-conflict failure. The retry
writer must revalidate that generation while holding the task lock, so neither an explicit pause
nor a replacement checkout is cleared by a stale operator snapshot.

FNXC:ReviewRecovery 2026-10-12-03:50:
Every operator retry surface writes through this helper, so it is where a retry re-arms the no-verdict review budget.
The re-arm is computed from the locked live row, and an explicit `workflowStepResults` in the caller's patch wins over it.
*/
export function buildManualRetryResetPatchIfCurrent(
  live: Task,
  expected: Pick<Task, "branch" | "worktree" | "status" | "error" | "paused" | "pausedReason" | "userPaused">,
  patch: Parameters<TaskStore["updateTask"]>[1],
): Parameters<TaskStore["updateTask"]>[1] | null {
  const hasNewerLifecycle = live.branch !== expected.branch
    || live.worktree !== expected.worktree
    || (live.userPaused === true && expected.userPaused !== true);
  if (hasNewerLifecycle) return null;

  return {
    ...buildNoVerdictBudgetRearmPatch(live),
    ...patch,
    ...buildAutoPauseClearPatch(live),
  };
}

export function buildManualRetryResetPatch(options?: { resetMergeRetries?: boolean }): Partial<Task> {
  const patch: Partial<Task> = {
    nextRecoveryAt: null as unknown as Task["nextRecoveryAt"],
    sessionContentionWaitReason: null as unknown as Task["sessionContentionWaitReason"],
    executorEscalationAttempted: false,
    toolFailureDetectorLogCursor: null,
    toolFailureRetryExhaustedAuditEmitted: false,
    // FNXC:Lifecycle 2026-07-16-21:40:
    // FN-8141 — an operator manual retry/edit is an honest exit signal that clears the
    // skip-bypass taint, so a legitimately retried task can promote on its skipped steps.
    bulkCompletionRefusalAt: null as unknown as Task["bulkCompletionRefusalAt"],
  };

  for (const key of MANUAL_RETRY_RESET_COUNTER_KEYS) {
    patch[key] = 0;
  }

  if (options?.resetMergeRetries) {
    patch.mergeRetries = 0;
  }

  return patch;
}
