/**
 * FNXC:MergeRunTimeout 2026-10-10-22:47:
 * One shape for a merge request through the single-flight merge pump, shared by the pump and every requester.
 * `onMergeRunStarted` fires each time the requested merge starts an attempt: when the pump claims it after the queue and capacity wait, and again when the merge rebuilds on a new integration tip.
 * A requester that bounds a hung merge starts its clock there, so waiting behind other merges never counts as a hang.
 */
export type MergeRequestOptions = {
  signal?: AbortSignal;
  graphOwnedPostMergeTraversal?: boolean;
  onMergeRunStarted?: () => void;
};
