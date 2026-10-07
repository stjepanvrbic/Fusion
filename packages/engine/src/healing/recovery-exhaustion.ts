import type { Task, TaskStore } from "@fusion/core";
import { createLogger } from "../logger.js";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import { generateSyntheticRunId, type EngineRunContext } from "../util/run-audit.js";

const log = createLogger("recovery-exhaustion");

/**
 * FNXC:RecoveryOwnership 2026-10-07-18:04:
 * Every bounded recovery owner that FN-9512 taught to reseed. The id is the audit `owner` enum,
 * so it must stay a fixed vocabulary and never carry task prose.
 */
export type RecoveryOwner =
  | "executor-transient"
  | "executor-planning-lock"
  | "executor-context-overflow"
  | "executor-stale-continuation"
  | "executor-non-continuable"
  | "executor-branch-conflict"
  | "executor-required-artifact"
  | "triage-planning"
  | "triage-missing-prompt"
  | "scheduler-filesystem-validation"
  | "self-healing-pr-conflict"
  | "self-healing-planning-handoff"
  | "graph-worktree-base-refresh"
  | "graph-artifact-read"
  | "graph-plan-review-provider"
  | "graph-dependency-bootstrap"
  | "graph-session-contention"
  | "graph-invalid-plan-dependency";

export type RecoveryEscalationOutcome = "reseeded" | "parked";

/**
 * FNXC:RecoveryOwnership 2026-10-07-18:04:
 * Records a consumed recovery budget under the FN-9512 `auto-recovery:retry-budget-escalated` event.
 * Metadata is ids/counts/fixed outcomes only. Best-effort through the bounded seam, so a hostile sink
 * can never change the reseed or park it describes.
 */
export async function recordRecoveryEscalation(
  store: TaskStore,
  taskId: string,
  input: { owner: RecoveryOwner; outcome: RecoveryEscalationOutcome; attempts: number; column: string; agentId: string },
): Promise<void> {
  await emitBoundedRunAudit(store, {
    taskId,
    agentId: input.agentId,
    runId: generateSyntheticRunId("recovery-escalation", taskId),
    domain: "database",
    mutationType: "auto-recovery:retry-budget-escalated",
    target: taskId,
    metadata: {
      taskId,
      owner: input.owner,
      outcome: input.outcome,
      attempts: input.attempts,
      column: input.column,
    },
  }, { log });
}

/** Operator-facing error for a terminal recovery park. */
export function formatRecoveryExhaustedError(attempts: number, detail: string, reseeded = true): string {
  const spent = reseeded ? `${attempts} attempts, including one fresh-session reseed` : `${attempts} attempts`;
  return `Automatic recovery exhausted after ${spent}: ${detail}. Fix the cause, then retry the task.`;
}

export interface ParkExhaustedRecoveryInput {
  owner: RecoveryOwner;
  /** Recovery actions spent in this episode; the counter is kept so the park cannot re-arm. */
  attempts: number;
  /** Short failure description; it becomes part of the task error, never audit metadata. */
  detail: string;
  agentId: string;
  runContext?: EngineRunContext;
  /** Extra fence over the live row; return false to leave a newer state untouched. */
  isSameEpisode?: (live: Task) => boolean;
  /** False for owners with no reseed slot, so the error does not claim one was spent. */
  reseeded?: boolean;
  /** Keep the counter untouched for owners whose budget lives in another field. */
  preserveRecoveryCounter?: boolean;
  /** Exact operator-facing error, for owners whose stop is a configuration hold, not a retry budget. */
  errorOverride?: string;
}

/**
 * FNXC:RecoveryOwnership 2026-10-07-18:04:
 * The terminal half of a bounded recovery episode. The card stays in its current lifecycle column
 * (no backward move) and becomes visibly `failed` with the cause, keeping its episode counter so no
 * automatic re-entry can restart the ladder. Fenced on the live row: an operator pause, a deletion,
 * a column change, or a newer failure state wins. Returns whether the park landed.
 */
export async function parkExhaustedRecovery(
  store: TaskStore,
  task: Task,
  input: ParkExhaustedRecoveryInput,
): Promise<boolean> {
  const error = input.errorOverride ?? formatRecoveryExhaustedError(input.attempts, input.detail, input.reseeded ?? true);
  let parkedColumn: string | null = null;
  await store.updateTaskAtomic(task.id, (live) => {
    if (live.deletedAt || live.column !== task.column || live.userPaused || live.paused) return null;
    if (live.status === "failed") return null;
    if (input.isSameEpisode && !input.isSameEpisode(live)) return null;
    parkedColumn = live.column;
    return {
      status: "failed",
      error,
      ...(input.preserveRecoveryCounter ? {} : { recoveryRetryCount: input.attempts }),
      recoveryDisposition: null,
      nextRecoveryAt: null,
    };
  });
  if (parkedColumn === null) return false;
  await store.logEntry(task.id, error, undefined, input.runContext).catch(() => undefined);
  await recordRecoveryEscalation(store, task.id, {
    owner: input.owner,
    outcome: "parked",
    attempts: input.attempts,
    column: parkedColumn,
    agentId: input.agentId,
  });
  return true;
}
