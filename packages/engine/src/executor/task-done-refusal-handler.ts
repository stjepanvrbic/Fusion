/**
 * FNXC:CodeOrganization 2026-08-03-18:15:
 * handleImplicitTaskDoneRefusal peeled from TaskExecutor (U4).
 * Requeues or fails after an implicit fn_task_done bulk-completion refusal.
 */
import type { Task, TaskStore } from "@fusion/core";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";
import { evaluateTaskDoneRefusal } from "./task-done-refusal.js";
import { skipBypassTaintUpdateForRefusal } from "./completion-predicates.js";
import { requeueExecutionInPlace } from "./in-place-execution-requeue.js";

/** Maximum in-place requeues after exhausting in-session fn_task_done retries. */
export const MAX_TASK_DONE_REQUEUE_RETRIES = 3;

export type TaskDoneRefusalHandlerDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  markGraphExecuteSelfRequeued: (taskId: string) => void;
  persistTokenUsage: (taskId: string) => Promise<void>;
  deleteActiveSession: (taskId: string) => void;
  clearTokenUsageBaseline: (taskId: string) => void;
  scheduleInPlaceExecutionResume: (taskId: string) => void;
};

export async function handleImplicitTaskDoneRefusal(
  deps: TaskDoneRefusalHandlerDeps,
  task: Task,
  refusal: Extract<ReturnType<typeof evaluateTaskDoneRefusal>, { ok: false }>,
): Promise<void> {
  await deps.store.logEntry(task.id, refusal.message, undefined, deps.getRunContextFor(task.id));
  executorLog.error(`${task.id}: fn_task_done refused (${refusal.refusalClass}) — ${refusal.reason} (implicit completion)`);

  const taintUpdate = skipBypassTaintUpdateForRefusal(refusal);
  const priorRequeues = task.taskDoneRetryCount ?? 0;
  const nextRequeueCount = priorRequeues + 1;
  if (priorRequeues < MAX_TASK_DONE_REQUEUE_RETRIES) {
    /* FNXC:LifecycleContainment 2026-10-07-18:04: a refused completion is retried in its WIP lane; FN-207 forbids the former automatic WIP-to-hold rebound. */
    await requeueExecutionInPlace(deps, task.id, {
      updates: {
        status: "queued",
        error: null,
        taskDoneRetryCount: nextRequeueCount,
        ...taintUpdate,
        paused: false,
        pausedByAgentId: null,
        sessionFile: null,
      },
      logMessage: `${refusal.message} — retrying in place with progress preserved (${nextRequeueCount}/${MAX_TASK_DONE_REQUEUE_RETRIES})`,
    });
  } else {
    await deps.store.updateTask(task.id, {
      status: "failed",
      error: refusal.message,
      ...taintUpdate,
      paused: false,
      pausedByAgentId: null,
      sessionFile: null,
    });
    await deps.store.logEntry(task.id, `${refusal.message} — execution failed because implicit fn_task_done was refused`, undefined, deps.getRunContextFor(task.id));
    await deps.persistTokenUsage(task.id);
  }

  deps.deleteActiveSession(task.id);
  deps.clearTokenUsageBaseline(task.id);
}
