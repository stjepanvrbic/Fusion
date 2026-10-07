/**
 * FNXC:CodeOrganization 2026-08-03-17:40:
 * handleNonContinuableSessionError + handleNonContinuableSessionRetry peeled from TaskExecutor (U4).
 * Post-done non-continuable session suppression and fresh-session recovery retry budget.
 */
import type { Task, TaskStore } from "@fusion/core";
import { isNonContinuableSessionError } from "../errors/transient-error-detector.js";
import { computeRecoveryDecision, formatDelay, MAX_RECOVERY_RETRIES } from "../healing/recovery-policy.js";
import { parkExhaustedRecovery, recordRecoveryEscalation } from "../healing/recovery-exhaustion.js";
import { requeueExecutionInPlace } from "./in-place-execution-requeue.js";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";
import { isTaskAlreadyCompleteForNonContinuableSession } from "./completion-predicates.js";

export type NonContinuableSessionDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  resolveResumeLanes: (taskId: string) => Promise<{ hold: string; wip: string; review: string; wipDeclared: boolean }>;
  persistTokenUsage: (taskId: string) => Promise<void>;
  clearCompletedTaskWatchdog: (taskId: string) => void;
  signalTaskComplete: (task: Task) => void;
  handoffTaskToReview: (task: Task, reason: string) => Promise<unknown>;
  markGraphExecuteSelfRequeued: (taskId: string) => void;
  scheduleInPlaceExecutionResume: (taskId: string) => void;
};

export async function handleNonContinuableSessionError(
  deps: NonContinuableSessionDeps,
  task: Task,
  taskDone: boolean,
  errorMessage: string,
): Promise<boolean> {
  if (!isNonContinuableSessionError(errorMessage)) {
    return false;
  }

  const liveTask = await deps.store.getTask(task.id);
  const nonContinuableLanes = await deps.resolveResumeLanes(task.id);
  if (!liveTask || !isTaskAlreadyCompleteForNonContinuableSession(liveTask, taskDone, nonContinuableLanes.review)) {
    return false;
  }

  const diagnosticMessage = "Post-done session continuation suppressed — session not continuable (last role assistant); task work already complete, leaving clean in-review";
  executorLog.warn(`${task.id} ${diagnosticMessage}`);
  await deps.store.logEntry(task.id, diagnosticMessage, errorMessage, deps.getRunContextFor(task.id));

  if (liveTask.status === "failed" || liveTask.error) {
    await deps.store.updateTask(task.id, { status: null, error: null });
  }

  await deps.persistTokenUsage(task.id);

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (PR #2703 review — greptile P1, and it is the same split
  I have been fixing all day, in code I wrote an hour earlier):
  ONE SNAPSHOT. The eligibility check above already resolved this task's lanes
  (`nonContinuableLanes`), and this branch resolved them AGAIN. A workflow selection or review-column
  edit between the two makes eligibility accept the card on the old board while this branch reads the new
  one — the card is then handed to `handoffTaskToReview`, reprocessing a row already in review.

  Writing the second resolution was not carelessness about the rule; it is that the rule is invisible at
  the call site. That is the argument for the structural ratchet in
  `executor-graph-failure-lanes-resolved.test.ts` rather than for trying harder.
  */
  if (liveTask.column === nonContinuableLanes.review) {
    deps.clearCompletedTaskWatchdog(task.id);
    deps.signalTaskComplete(liveTask);
    return true;
  }

  const refreshedTask = await deps.store.getTask(task.id);
  await deps.handoffTaskToReview(refreshedTask ?? liveTask, "post-done-noncontinuable");
  deps.clearCompletedTaskWatchdog(task.id);
  deps.signalTaskComplete(refreshedTask ?? liveTask);
  return true;
}

export async function handleNonContinuableSessionRetry(
  deps: NonContinuableSessionDeps,
  task: Task,
  errorMessage: string,
): Promise<boolean> {
  if (!isNonContinuableSessionError(errorMessage)) {
    return false;
  }

  const liveTask = await deps.store.getTask(task.id);
  if (!liveTask) {
    return false;
  }

  const decision = computeRecoveryDecision({
    recoveryRetryCount: liveTask.recoveryRetryCount,
    nextRecoveryAt: liveTask.nextRecoveryAt,
  });

  if (decision.disposition === "retry") {
    const attempt = decision.attempt;
    const delay = formatDelay(decision.delayMs);
    executorLog.warn(`⚡ ${task.id} non-continuable session — fresh-session retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}`);
    await requeueExecutionInPlace(deps, task.id, {
      updates: {
        recoveryRetryCount: decision.nextState.recoveryRetryCount,
        sessionFile: null,
      },
      notBefore: decision.nextState.nextRecoveryAt,
      logMessage: `Non-continuable session — fresh-session retry (${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}): ${errorMessage}`,
    });
    return true;
  }

  /*
  FNXC:RecoveryOwnership 2026-10-06-15:28:
  A non-continuable transcript has no safe terminal interpretation. After bounded fresh-session
  verification, clear only the stale session/cadence and create a new session in the task's
  current lifecycle role.

  FNXC:RecoveryOwnership 2026-10-07-18:04:
  That reseed is spent once per episode. The counter is no longer reset, so a second exhaustion
  parks the card `failed` in its lane with the cause instead of restarting the ladder forever.
  */
  if (decision.escalation === "park") {
    executorLog.warn(`⚡ ${task.id} non-continuable session recovery exhausted after a reseed; parking for an operator`);
    return parkExhaustedRecovery(deps.store, liveTask, {
      owner: "executor-non-continuable",
      attempts: decision.attempts,
      detail: `non-continuable session: ${errorMessage}`,
      agentId: "executor",
      runContext: deps.getRunContextFor(task.id),
    });
  }
  executorLog.warn(`⚡ ${task.id} non-continuable session retry cadence exhausted; reseeding fresh session`);
  await deps.store.updateTask(task.id, {
    status: null,
    error: null,
    recoveryRetryCount: decision.nextState.recoveryRetryCount,
    recoveryDisposition: "escalated-reseed",
    nextRecoveryAt: null,
    sessionFile: null,
  });
  await recordRecoveryEscalation(deps.store, task.id, {
    owner: "executor-non-continuable",
    outcome: "reseeded",
    attempts: decision.nextState.recoveryRetryCount ?? decision.attempts,
    column: liveTask.column,
    agentId: "executor",
  });
  await requeueExecutionInPlace(deps, task.id, {
    logMessage: "Non-continuable session recovery exhausted its retry cadence; reseeding a fresh session in place.",
  });
  return true;
}
