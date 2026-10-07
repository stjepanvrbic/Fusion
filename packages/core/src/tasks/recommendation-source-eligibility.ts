import type { Task } from "../types/task/task-core.js";

/*
FNXC:TaskRecommendations 2026-10-07-12:56:
A recommendation is actionable once its parent's implementation is final, not only once the card reaches a complete lane.
The operator notice and its Create task button are delivered at accepted fn_task_done, while a landed card can wait in review for post-merge evidence indefinitely; gating on the complete lane alone made every such notice fail with a generic error.
A merge-confirmed card in a review lane never re-runs implementation, so its recommendation list cannot be rewritten and is as final as a completed card's.
A merge-confirmed card that was moved back out of review (reopened) is not eligible, because re-execution may replace the list.
*/
export function isRecommendationSourceActionable(
  task: Pick<Task, "column" | "mergeDetails">,
  completeColumns: ReadonlySet<string>,
  landedReviewColumns?: ReadonlySet<string>,
): boolean {
  if (completeColumns.has(task.column)) return true;
  return Boolean(landedReviewColumns?.has(task.column) && task.mergeDetails?.mergeConfirmed === true);
}

/** Operator-facing refusal shared by every surface that rejects an ineligible recommendation source. */
export function recommendationSourceNotActionableMessage(taskId: string): string {
  return `Recommendations from ${taskId} can be filed as tasks after ${taskId} lands or completes`;
}
