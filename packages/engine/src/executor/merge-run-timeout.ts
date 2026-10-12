/**
 * FNXC:MergeRunTimeout 2026-10-10-22:47:
 * The graph merge node bounds a hung merge so the walk does not hold its routing claim forever.
 * The bound measures one merge attempt: it is armed when the merge pump reports the attempt started and re-armed when the merge restarts on a new integration tip.
 * Time spent queued behind other merges or waiting for a capacity slot is healthy and unbounded here; the pump's own watchdog and the graph abort signal cover a wedged queue and cancellation.
 * KB-097 and KB-057 were aborted 30 minutes after their request, 21 of them spent queued, when the bound was armed at request time.
 *
 * FNXC:MergeLandingCommitPoint 2026-10-12-09:55:
 * The bound covers an attempt from its start until its landing starts, and is cleared when the merge reports it is about to advance the integration ref.
 * Past that point the merge has committed: aborting it cannot undo the advance, only strand the landing unrecorded and unpublished (KB-146 timed out three seconds after main fast-forwarded).
 * If the advance loses a race and the merge rebuilds, the next attempt start re-arms the bound; a hung landing tail is owned by the merge pump watchdog and the self-healing wedged-merge reclaim.
 */
export const GRAPH_MERGE_RUN_TIMEOUT_MS = 30 * 60 * 1000;

export interface MergeRunTimeout {
  /** Settles when a started merge attempt outlives the bound. Never settles while the merge is only queued. */
  readonly expired: Promise<"timeout">;
  /** Starts the bound for a merge attempt, replacing the bound of any earlier attempt. */
  restart(): void;
  clear(): void;
}

export function createMergeRunTimeout(onExpired?: () => void): MergeRunTimeout {
  let handle: ReturnType<typeof setTimeout> | undefined;
  let expire: (value: "timeout") => void = () => undefined;
  const expired = new Promise<"timeout">((resolve) => { expire = resolve; });
  const clear = (): void => {
    if (handle) clearTimeout(handle);
    handle = undefined;
  };
  return {
    expired,
    restart: () => {
      clear();
      handle = setTimeout(() => {
        onExpired?.();
        expire("timeout");
      }, GRAPH_MERGE_RUN_TIMEOUT_MS);
      handle.unref?.();
    },
    clear,
  };
}
