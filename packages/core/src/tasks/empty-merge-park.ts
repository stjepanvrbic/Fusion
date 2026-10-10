import type { Task } from "../types.js";

/*
FNXC:EmptyMergePark 2026-10-10-17:20:
A commit-expected branch whose AI merge produced no net changes, and whose landing no mechanical proof can show, parks failed in review with this reason.
The typical case is a branch superseded by another landed task (a dependent built on a rebased copy of its commits), which Retry cannot resolve because it reruns the same merge.
When the merge agent says the work is already on the target, the AI merge reviewer checks that claim with two passes and a confirmed claim finalizes the card without this park.
The park is left for unconfirmed or disputed claims, so it carries both agents' statements and names the operator-only close-as-landed fallback; this module is the single spelling shared by the engine writer, the close-as-landed eligibility check and the dashboard.
*/
export const EMPTY_MERGE_NO_LANDED_PROOF_REASON =
  "branch had no net changes vs main — work may have been reverted or lost; operator review required";

export function buildEmptyMergeNoLandedProofReason(
  taskId: string,
  options: { mergeAgentExplanations?: readonly string[]; reviewerDispute?: string; closeAsLandedAvailable: boolean },
): string {
  const explanations = options.mergeAgentExplanations ?? [];
  const explained = `${explanations.length ? `; merge agent: ${explanations.join(" | ")}` : ""}${options.reviewerDispute ? `; reviewer disputes that the work is on main: ${options.reviewerDispute}` : ""}`;
  const wayOut = options.closeAsLandedAvailable
    ? ` If main already has this work, close the card with \`fn task close-landed ${taskId} --reason "<why>"\` or "Close as landed" in the dashboard task menu; Retry reruns the same merge.`
    : "";
  return `${EMPTY_MERGE_NO_LANDED_PROOF_REASON}${explained}.${wayOut}`;
}

export function isEmptyMergeNoLandedProofPark(task: Pick<Task, "status" | "error">): boolean {
  return task.status === "failed" && typeof task.error === "string" && task.error.startsWith(EMPTY_MERGE_NO_LANDED_PROOF_REASON);
}
