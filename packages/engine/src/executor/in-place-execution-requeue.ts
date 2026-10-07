/**
 * FNXC:LifecycleContainment 2026-10-07-18:04:
 * Executor retries stay in their lifecycle role. FN-207 forbids an automatic WIP-to-hold move for
 * anything but a Plan Review REVISE, yet every executor rebound (transient error, non-continuable
 * session, missing fn_task_done, reclaim mid-retry, stale continuation, context overflow, branch
 * recovery, dependency abort) moved the card back to the hold lane with no move source, which the
 * store's fail-open legacy route silently allowed. This seam replaces those moves: the card keeps
 * its WIP column, its persisted `nextRecoveryAt` is the backoff, and a guarded timer re-dispatches
 * the same lane once the old run has released its claims. Engine restart recovery honors the same
 * deadline, so the retry is durable without a backward move.
 */
import type { Task, TaskStore } from "@fusion/core";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";

type TaskUpdatePatch = Parameters<TaskStore["updateTask"]>[1];

/** Poll interval while the previous run still holds an executor claim on the task. */
export const IN_PLACE_RESUME_CLAIM_POLL_MS = 1_000;
/** Claim polls before the timer stops; an execution that holds the task this long owns it. */
export const IN_PLACE_RESUME_MAX_CLAIM_POLLS = 120;

export type InPlaceExecutionRequeueDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  markGraphExecuteSelfRequeued: (taskId: string) => void;
  scheduleInPlaceExecutionResume: (taskId: string) => void;
};

export interface InPlaceExecutionRequeueInput {
  /** Fields the caller clears or records for the retry (session, worktree, counters). */
  updates?: TaskUpdatePatch;
  /** ISO deadline; omitted means re-dispatch as soon as the old run's claims are released. */
  notBefore?: string | null;
  /** Task-log line naming why the card is retried in place. */
  logMessage?: string;
}

/**
 * Retry an execution in its current lifecycle column. Never moves the card.
 */
export async function requeueExecutionInPlace(
  deps: InPlaceExecutionRequeueDeps,
  taskId: string,
  input: InPlaceExecutionRequeueInput = {},
): Promise<void> {
  const patch: TaskUpdatePatch = { ...(input.updates ?? {}) };
  if (input.notBefore !== undefined) patch.nextRecoveryAt = input.notBefore;
  if (Object.keys(patch).length > 0) {
    await deps.store.updateTask(taskId, patch, deps.getRunContextFor(taskId));
  }
  if (input.logMessage) {
    await deps.store.logEntry(taskId, input.logMessage, undefined, deps.getRunContextFor(taskId));
  }
  deps.markGraphExecuteSelfRequeued(taskId);
  deps.scheduleInPlaceExecutionResume(taskId);
}

export type InPlaceExecutionResumeDeps = {
  store: TaskStore;
  resolveResumeLanes: (taskId: string) => Promise<{ wip?: string }>;
  /** Single-flight claim-checked dispatcher shared with the unpause-resume path. */
  dispatchUnpauseResume: (task: Task) => Promise<boolean>;
  hasExecutionClaim: (taskId: string) => boolean;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  now?: () => number;
};

/** Statuses an in-place pending retry may carry; anything else is a newer owner's state. */
const IN_PLACE_PENDING_STATUSES = new Set<string | null>([null, "queued"]);

/**
 * True when the live row is still the in-place retry this seam scheduled: same WIP lane, not
 * paused, not deleted, and not parked or advanced by a newer owner.
 */
export function isInPlaceRetryCandidate(live: Task, wipLane: string | undefined): boolean {
  return !live.deletedAt
    && !live.paused
    && !live.userPaused
    && wipLane !== undefined
    && live.column === wipLane
    && IN_PLACE_PENDING_STATUSES.has(live.status ?? null)
    && !live.error;
}

/**
 * Arm (or re-arm) the single re-dispatch timer for a task. The fire-time read is authoritative:
 * a pause, deletion, column change, or newer status cancels the retry; a future `nextRecoveryAt`
 * re-arms for the remainder; a still-held claim polls until the old run unwinds.
 */
export function scheduleInPlaceExecutionResume(
  deps: InPlaceExecutionResumeDeps,
  taskId: string,
  delayMs = 0,
  claimPolls = 0,
): void {
  const existing = deps.timers.get(taskId);
  if (existing) clearTimeout(existing);
  const handle = setTimeout(() => {
    deps.timers.delete(taskId);
    void fireInPlaceExecutionResume(deps, taskId, claimPolls).catch((err: unknown) => {
      executorLog.error(`In-place execution retry for ${taskId} failed:`, err);
    });
  }, Math.max(0, delayMs));
  handle.unref?.();
  deps.timers.set(taskId, handle);
}

async function fireInPlaceExecutionResume(
  deps: InPlaceExecutionResumeDeps,
  taskId: string,
  claimPolls: number,
): Promise<void> {
  const live = await deps.store.getTask(taskId).catch(() => null);
  if (!live) return;
  const { wip } = await deps.resolveResumeLanes(taskId);
  if (!isInPlaceRetryCandidate(live, wip)) {
    executorLog.debug(`${taskId}: in-place execution retry cancelled — task is no longer a pending WIP retry`);
    return;
  }
  const now = deps.now?.() ?? Date.now();
  const notBeforeMs = live.nextRecoveryAt ? Date.parse(live.nextRecoveryAt) : Number.NaN;
  if (Number.isFinite(notBeforeMs) && notBeforeMs > now) {
    scheduleInPlaceExecutionResume(deps, taskId, notBeforeMs - now, claimPolls);
    return;
  }
  if (deps.hasExecutionClaim(taskId)) {
    if (claimPolls < IN_PLACE_RESUME_MAX_CLAIM_POLLS) {
      scheduleInPlaceExecutionResume(deps, taskId, IN_PLACE_RESUME_CLAIM_POLL_MS, claimPolls + 1);
    }
    return;
  }
  await deps.dispatchUnpauseResume(live);
}
