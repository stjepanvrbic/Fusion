/**
 * FNXC:MergeRunTimeout 2026-10-10-22:47:
 * One shape for a merge request through the single-flight merge pump, shared by the pump and every requester.
 * `onMergeRunStarted` fires each time the requested merge starts an attempt: when the pump claims it after the queue and capacity wait, and again when the merge rebuilds on a new integration tip.
 * A requester that bounds a hung merge starts its clock there, so waiting behind other merges never counts as a hang.
 *
 * FNXC:MergeLandingCommitPoint 2026-10-12-09:55:
 * `onMergeLandingStarted` fires when the requested merge is about to advance its integration ref, the commit point of a merge.
 * A requester stops its hung-merge bound there: KB-146's bound expired three seconds after main fast-forwarded, aborted the landed merge before finalization, and cost a second merge session plus a Code Review on the landed card.
 * A requester that joins while the merge is already in its landing tail is told at once; a rebuild after a concurrent advance fires `onMergeRunStarted` again and re-arms the bound.
 */
export type MergeRequestOptions = {
  signal?: AbortSignal;
  graphOwnedPostMergeTraversal?: boolean;
  onMergeRunStarted?: () => void;
  onMergeLandingStarted?: () => void;
};
