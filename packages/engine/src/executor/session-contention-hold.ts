/**
 * FNXC:CodeOrganization 2026-08-03-19:40:
 * holdForSessionContention peeled from TaskExecutor (U4).
 * Bounded in-place retry while another task holds a shared session path.
 *
 * FNXC:WorkspaceContention 2026-08-23-06:40 (FN-179):
 * Acquisition contention can survive an engine restart because its authority is a durable lease.
 * Persist the owner-local retry budget and an operator-visible wait reason, but never park a
 * contention wait as failed; a shared budget across unrelated failed-park owners remains out of scope.
 *
 * FNXC:RecoveryOwnership 2026-10-07-18:04:
 * Superseded for exhaustion only. Clearing the wait on exhaustion left a WIP card with no session,
 * no scheduled resume and no visible state, because nothing re-dispatches an idle WIP card. An
 * exhausted contention episode now parks visibly (failed, with the holder reason) on its own
 * counter; the recovery counter shared by other owners is untouched.
 *
 * FNXC:WorkspaceContention 2026-10-07-18:04:
 * The delayed retry owns exactly one hold episode. It claims the row atomically only while the row
 * still carries that episode (status contention-hold, same attempt, column and column-move stamp).
 * A newer failure, approval hold, completion, review transition, deletion or newer episode wins and
 * the timer neither writes nor executes. A paused same-episode row is released without executing.
 */
import type { Task, TaskDetail, TaskStore } from "@fusion/core";
import { isSessionContentionError } from "../errors/transient-error-detector.js";
import { parkExhaustedRecovery } from "../healing/recovery-exhaustion.js";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";
import { graphFailureErrorTexts } from "./graph-failure-pure.js";

export const MAX_SESSION_CONTENTION_HOLD_RETRIES = 10;
export const SESSION_CONTENTION_HOLD_BACKOFF_MS = process.env.VITEST || process.env.NODE_ENV === "test" ? 0 : 5_000;
export const SESSION_CONTENTION_HOLD_MAX_BACKOFF_MS = 60_000;

export type SessionContentionHoldDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  reexecute: (task: Task) => Promise<void>;
};

export type WorkflowGraphTaskRunResultLike = {
  // minimal shape for graphFailureErrorTexts
  [key: string]: unknown;
};

export async function holdForSessionContention(
  deps: SessionContentionHoldDeps,
  task: Task,
  live: TaskDetail,
  result: Parameters<typeof graphFailureErrorTexts>[0],
): Promise<void> {
  const detail = graphFailureErrorTexts(result).find((text) => isSessionContentionError(text));
  const priorAttempts = live.sessionContentionHoldCount ?? 0;
  const attempt = priorAttempts + 1;
  const reason = (detail ?? "another task to release a shared session path").slice(0, 200);

  if (attempt > MAX_SESSION_CONTENTION_HOLD_RETRIES) {
    executorLog.warn(`${task.id}: still waiting on a shared session path after ${MAX_SESSION_CONTENTION_HOLD_RETRIES} attempts — parking for an operator`);
    // FNXC:WorkspaceContention 2026-08-23-07:30: exhaustion must not erase the durable budget. Only
    // explicit lifecycle reset owners (manual retry, clean completion, and done cleanup) may start a
    // new contention episode; otherwise rediscovery recreates the incident loop.
    await parkExhaustedRecovery(deps.store, live, {
      owner: "graph-session-contention",
      attempts: priorAttempts,
      detail: `still waiting on ${reason}`,
      agentId: "executor",
      reseeded: false,
      preserveRecoveryCounter: true,
      runContext: deps.getRunContextFor(task.id),
    });
    return;
  }

  const message = `Waiting on another task to release a shared session path — retrying in place (${attempt}/${MAX_SESSION_CONTENTION_HOLD_RETRIES})${detail ? `: ${detail}` : ""}`;
  executorLog.warn(`${task.id}: ${message}`);
  await deps.store.logEntry(task.id, message, undefined, deps.getRunContextFor(task.id));
  // A contention hold is a scheduling wait, not a failure. Its token makes the owner visible.
  await deps.store.updateTask(task.id, {
    status: "contention-hold", error: null, sessionContentionHoldCount: attempt,
    sessionContentionWaitReason: reason,
  }, deps.getRunContextFor(task.id));

  const delayMs = SESSION_CONTENTION_HOLD_BACKOFF_MS === 0
    ? 0
    : Math.min(SESSION_CONTENTION_HOLD_MAX_BACKOFF_MS, SESSION_CONTENTION_HOLD_BACKOFF_MS * 2 ** (attempt - 1));
  const episode = { attempt, column: live.column, columnMovedAt: live.columnMovedAt ?? null };
  const scheduleRetry = () => {
    void (async () => {
      try {
        /*
        FNXC:WorkspaceContention 2026-08-23-06:51 (FN-179):
        Yielding a scheduling hold clears only its visible owner token. Retain the
        durable count so a repeated live-holder refusal consumes the bounded budget
        instead of restarting at attempt one after every scheduled re-execution.
        */
        let claimed: "execute" | "released" | null = null;
        const resume = await deps.store.updateTaskAtomic(task.id, (current) => {
          if (!isSameContentionEpisode(current, episode)) return null;
          claimed = current.paused || current.userPaused ? "released" : "execute";
          return { status: null, sessionContentionWaitReason: null };
        }, deps.getRunContextFor(task.id));
        if (claimed !== "execute") return;
        await deps.reexecute(resume);
      } catch (err) {
        executorLog.error(`Failed session-contention retry for ${task.id}:`, err);
      }
    })();
  };
  setTimeout(scheduleRetry, delayMs).unref?.();
}

/** True only while the row still carries the contention episode the timer was armed for. */
export function isSameContentionEpisode(
  current: Task | null | undefined,
  episode: { attempt: number; column: string; columnMovedAt: string | null },
): boolean {
  return Boolean(current)
    && !current!.deletedAt
    && current!.status === "contention-hold"
    && (current!.sessionContentionHoldCount ?? 0) === episode.attempt
    && current!.column === episode.column
    && (current!.columnMovedAt ?? null) === episode.columnMovedAt;
}
