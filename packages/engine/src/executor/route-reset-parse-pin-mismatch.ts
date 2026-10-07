/**
 * FNXC:CodeOrganization 2026-08-03-12:00:
 * routeResetParsePinMismatchToRetry peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowReset 2026-06-29-10:04:
 * A user reset/retry can race an aborting graph-owned foreach instance that persists after the route cleared pins. If the next run reaches parse and sees only stale foreach pins while the task has no implementation progress, recover by deleting all graph instance rows and retrying parse in place. Do not hand the task to in-review, because parse has not executed work or produced mergeable output.
 */
import type { TaskDetail, TaskStore } from "@fusion/core";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";
import { resolveTerminalColumnsFor } from "./lifecycle-columns.js";

export type RouteResetParsePinMismatchDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  clearPausedAborted: (taskId: string) => void;
  activeWorktrees: Map<string, unknown>;
  persistTokenUsage: (taskId: string) => Promise<void>;
  scheduleInPlaceExecutionResume: (taskId: string) => void;
};

export async function routeResetParsePinMismatchToRetry(
  deps: RouteResetParsePinMismatchDeps,
  live: TaskDetail,
): Promise<boolean> {
  if (live.deletedAt) return false;
  if (live.paused || live.userPaused === true) return false;
  if ((await resolveTerminalColumnsFor(deps.store, live.id)).includes(live.column)) return false;
  const hasImplementationProgress =
    (live.currentStep ?? 0) > 0
    || (live.steps ?? []).some((step) => step.status === "done" || step.status === "in-progress" || step.status === "skipped");
  if (hasImplementationProgress) return false;

  const maybeStore = deps.store as unknown as {
    clearWorkflowRunStepInstancesAsync?: (taskId: string) => Promise<void>;
    clearWorkflowRunStepInstances?: (taskId: string) => void;
    clearWorkflowRunBranches?: (taskId: string, keepRunId: string) => void;
  };
  try {
    await (maybeStore.clearWorkflowRunStepInstancesAsync?.(live.id)
      ?? maybeStore.clearWorkflowRunStepInstances?.(live.id));
  } catch {
    // Legacy stores may not persist graph step instances.
  }
  deps.clearPausedAborted(live.id);
  deps.activeWorktrees.delete(live.id);
  await deps.store.updateTask(live.id, {
    status: null,
    error: null,
    graphResumeRetryCount: 0,
  }, deps.getRunContextFor(live.id));
  /*
  FNXC:LifecycleContainment 2026-10-07-18:04:
  Parse ran no work, so there is nothing to discard; the card re-enters parse in its current lane.
  The former move to the hold lane was an automatic WIP-to-hold rebound that FN-207 forbids.
  */
  deps.scheduleInPlaceExecutionResume(live.id);
  const message = "Auto-recovered: cleared stale workflow parse pins after reset/retry — task retried in place before execution";
  executorLog.warn(`${live.id}: ${message}`);
  await deps.store.logEntry(live.id, message, undefined, deps.getRunContextFor(live.id));
  await deps.persistTokenUsage(live.id);
  return true;
}
