import {
  ENGINE_BACKWARD_MOVE_REASONS,
  TransitionRejectionError,
  resolveContainedBackwardTargetForTask,
  type MoveTaskOptions,
  type TaskStore,
} from "@fusion/core";

export type LifecycleMoveResult =
  | { moved: true }
  | { moved: false; deferred: "capacity"; detail: string };

export type ContainedLifecycleMoveResult = LifecycleMoveResult
  | { moved: false; reason: "no-contained-target" | "in-place-recovery"; column: string };

/*
FNXC:LifecycleContainment 2026-08-28-03:03:
FN-207 centralizes source-relative backward recovery: review may target only WIP, WIP may target only
hold, no target means no move, and capacity refusal remains in place. The seam preserves the caller's
raw source because assigning engine here would change guard-bypass behavior for optionless callers.
FNXC:LifecycleContainment 2026-10-07-18:04: superseded in part. Optionless callers are now attributed
as engine with an explicit `bypassGuards: false`, which keeps guard behavior and enables the direction check.
*/
export async function moveTaskToContainedBackwardTarget(
  store: TaskStore,
  taskId: string,
  reason: string,
  options?: MoveTaskOptions,
  _liveColumn?: string,
): Promise<ContainedLifecycleMoveResult> {
  /*
  FNXC:LifecycleContainment 2026-09-22-14:05:
  Recovery callers can hold a task snapshot across git and filesystem awaits. Re-read the durable
  column before choosing a backward target so an operator move during recovery wins over stale
  caller metadata; `liveColumn` remains a diagnostic hint for compatibility, not mutation authority.
  */
  const column = (await store.getTask(taskId)).column;
  const revisionReasons = new Set([
    "plan-review-revise-replan",
    "code-review-revise-remediation",
    "verification-failure-remediation",
    "merge-fix-remediation",
  ]);
  if (!revisionReasons.has(reason)) {
    await store.logEntry(
      taskId,
      `Lifecycle recovery retained in '${column}' — ${reason} has no backward-move authority`,
    ).catch(() => undefined);
    return { moved: false, reason: "in-place-recovery", column };
  }
  const target = await resolveContainedBackwardTargetForTask(store, taskId, column);
  if (!target) {
    await store.logEntry(
      taskId,
      `Lifecycle rebound contained in '${column}' — the workflow declares no adjacent backward destination`,
    ).catch(() => undefined);
    return { moved: false, reason: "no-contained-target", column };
  }
  return moveTaskWithLifecycleReason(store, taskId, target, reason, options);
}

export async function moveTaskWithLifecycleReason(
  store: TaskStore,
  taskId: string,
  toColumn: string,
  reason: string,
  options?: MoveTaskOptions,
): Promise<LifecycleMoveResult> {
  /*
  FNXC:LifecycleContainment 2026-10-07-18:04:
  Every move through this seam is an automatic engine move, so it is attributed as one: the FN-207
  direction postcondition only runs for an explicit engine/scheduler source, and an optionless call
  took the store's fail-open legacy route. Guard bypass stays as the caller had it (an optionless
  call ran guards), so attribution does not silently grant plugin-gate bypass.
  */
  const attributed: MoveTaskOptions = {
    ...options,
    moveSource: options?.moveSource ?? "engine",
    // An explicit caller source keeps the store's derived bypass; an optionless call keeps its guards.
    bypassGuards: options?.bypassGuards ?? (options?.moveSource ? undefined : false),
  };
  try {
    await store.moveTask(taskId, toColumn, { ...attributed, lifecycleReason: reason });
    return { moved: true };
  } catch (error) {
    if (!(error instanceof TransitionRejectionError) || error.rejection.code !== "capacity-exhausted") {
      throw error;
    }
    const task = await store.getTask(taskId);
    const summary = ENGINE_BACKWARD_MOVE_REASONS[reason]?.summary ?? reason;
    await store.logEntry(
      taskId,
      `Lifecycle move deferred: ${task.column} → ${toColumn} (backward) — ${summary} (destination at capacity; retrying later)`,
    ).catch(() => undefined);
    return { moved: false, deferred: "capacity", detail: error.rejection.detail ?? "destination at capacity" };
  }
}
