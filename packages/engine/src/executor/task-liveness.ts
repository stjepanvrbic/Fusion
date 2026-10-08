/**
 * FNXC:CodeOrganization 2026-08-03-18:30:
 * getExecutingTaskIds, isTaskActive, hasActivePlanningWorkflowSession peeled from TaskExecutor (U4).
 *
 * FNXC:TaskTiming 2026-07-30-21:40:
 * A planning segment has one owner: a graph Plan Review session is live only while both its
 * session registration and planning ownership marker remain. isTaskActive is broader (implementation
 * + non-planning workflow sessions). Graph-routed tasks count as executing for the whole interpreter run.
 */

export type TaskLivenessDeps = {
  executing: Set<string>;
  recoveringCompleted: Set<string>;
  resumingUnpaused: Set<string>;
  activeSessions: Map<string, unknown>;
  activePlanningWorkflowSessions: Set<string>;
  activeWorkflowStepSessions: Map<string, unknown>;
  processWideGraphRouting: Set<string>;
  /**
   * FNXC:RecoveryOwnership 2026-10-07-18:04:
   * Scheduled-but-not-started executions are live: a deferred startup orphan resume and an armed
   * in-place retry. Without them a sweep saw no executing/session/active signal during the delay
   * and rewrote the row the deferred execute() would then run from.
   */
  pendingOrphanResumes: Set<string>;
  inPlaceExecutionResumeTimers: Map<string, unknown>;
};

export function getExecutingTaskIds(deps: TaskLivenessDeps): Set<string> {
  // Graph-routed tasks count as executing for their WHOLE interpreter run —
  // between seams the inner execute() has released this.executing, but the
  // graph still owns the lifecycle; self-healing/recovery must not touch it.
  return new Set([
    ...deps.executing,
    ...deps.recoveringCompleted,
    ...deps.resumingUnpaused,
    ...deps.processWideGraphRouting,
    ...deps.pendingOrphanResumes,
    ...deps.inPlaceExecutionResumeTimers.keys(),
  ]);
}

export function hasActivePlanningWorkflowSession(
  deps: TaskLivenessDeps,
  taskId: string,
): boolean {
  return deps.activePlanningWorkflowSessions.has(taskId) && deps.activeWorkflowStepSessions.has(taskId);
}

export function isTaskActive(
  deps: TaskLivenessDeps,
  taskId: string,
): boolean {
  return (
    deps.executing.has(taskId)
    || deps.activeSessions.has(taskId)
    || deps.recoveringCompleted.has(taskId)
    || deps.processWideGraphRouting.has(taskId)
    || deps.pendingOrphanResumes.has(taskId)
    || deps.inPlaceExecutionResumeTimers.has(taskId)
  );
}
