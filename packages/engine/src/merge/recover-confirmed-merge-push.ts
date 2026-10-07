import { allowsAutoMergeProcessing, getPostMergeFinalizeBlocker, type Settings, type Task, type TaskStore } from "@fusion/core";
import { activeSessionRegistry, executingTaskLock } from "../agents/active-session-registry.js";
import { isTaskExecutionLive } from "./merge-execution-exclusion.js";
import { isPushAfterMergeEnabled } from "./push-after-merge-policy.js";
import { createMergeWriteFence, isMergeAbortedError, type MergeWriteFence } from "./merge-write-fence.js";
import { isCommitOnRemoteBranch, reconcileRewrittenLandedCommit, resolveConfirmedMergePushTarget, runGit, type GitRun } from "./landed-commit-publication.js";

const COOLDOWN_MS = 5 * 60_000;
const branchAttempts = new Map<string, number>();
type Run = GitRun;

/**
 * FNXC:PostMergePublication 2026-10-07-13:00:
 * `delivered` means THIS call verified or pushed the landed commit onto the remote. `failed` covers a
 * transport/proof error or a durable failure backoff; `skipped` covers ineligibility, an attempt owned
 * elsewhere, or an earlier recorded delivery. Only `delivered` lets the publication precondition reseed.
 *
 * FNXC:PostMergePublication 2026-10-07-17:58:
 * `deferred` is split out of `skipped`: an attempt in flight or cooling down for this commit, another task holding
 * the per-target slot, or a lost claim race. Nothing failed, so callers must not report a push failure for it.
 * `skipped` now means only that this landing is ineligible or its delivery is already recorded.
 */
export type ConfirmedMergePushOutcome = "delivered" | "failed" | "deferred" | "skipped";

export type ConfirmedMergePushOptions = {
  /**
   * FNXC:PostMergePublication 2026-10-07-17:58:
   * The caller just read the remote and proved the landed commit absent. A recorded `pushedAt` is then stale
   * (the remote was rewound or the push never stuck), so it no longer suppresses a new attempt after the cooldown.
   * Callers without that proof keep trusting `pushedAt`, so the merge pump does not probe the remote every tick.
   */
  remoteProvenAbsent?: boolean;
};

function eligible(task: Task, settings: Settings): boolean {
  const leaseAge = Date.now() - Date.parse(task.checkoutLeaseRenewedAt ?? "");
  const leased = !!task.checkoutRunId && Number.isFinite(leaseAge) && leaseAge >= 0
    && leaseAge < (settings.taskStuckTimeoutMs ?? 10 * 60_000) * 3;
  return task.mergeDetails?.mergeConfirmed === true && !task.workspaceWorktrees
    && task.branchContext?.assignmentMode !== "shared"
    && !task.paused && !task.userPaused && !task.deletedAt && task.autoMerge !== false
    && !settings.globalPause && !settings.enginePaused
    && isPushAfterMergeEnabled(settings) && allowsAutoMergeProcessing(task, settings)
    && !getPostMergeFinalizeBlocker(task)
    && !leased && !isTaskExecutionLive(task.id, { activeSessionRegistry, executingTaskLock });
}

/** Retry remote delivery of proven landing only; never merge, rebase, or force-push. */
export async function recoverConfirmedMergePush(
  store: TaskStore,
  task: Task,
  settings: Settings,
  run: Run = runGit,
  suppliedFence?: MergeWriteFence,
  options: ConfirmedMergePushOptions = {},
): Promise<ConfirmedMergePushOutcome> {
  if (!store.rootDir || !eligible(task, settings)) return "skipped";
  const details = task.mergeDetails!;
  const sha = details.commitSha;
  const resolved = resolveConfirmedMergePushTarget(details, settings);
  if (!resolved || !sha || !/^[a-f0-9]{40,64}$/i.test(sha)) return "skipped";
  const { branch, remote, targetBranch, target } = resolved;
  const recorded = details.pushRecovery;
  const now = Date.now();
  if (recorded?.target === target && recorded.commitSha === sha) {
    const coolingDown = Date.parse(recorded.nextAttemptAt) > now;
    if (!recorded.pushedAt && recorded.error && coolingDown) return "failed";
    if (coolingDown) return "deferred";
    if (recorded.pushedAt && !options.remoteProvenAbsent) return "skipped";
  }
  for (const [key, until] of branchAttempts) if (until <= now) branchAttempts.delete(key);
  const key = `${store.rootDir}\0${target}`;
  if (branchAttempts.has(key)) return "deferred";
  branchAttempts.set(key, now + COOLDOWN_MS);
  const nextAttemptAt = new Date(now + COOLDOWN_MS).toISOString();
  const deadline = now + 10_000;
  const fence = suppliedFence ?? createMergeWriteFence({ taskId: task.id });
  const git = (args: string[]) => {
    fence.assertOwned();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Remote delivery recovery timed out.");
    return fence.signal ? run(args, store.rootDir, remaining, fence.signal) : run(args, store.rootDir, remaining);
  };
  let claimed = false;
  let failed = false;
  const ownsAttempt = (live: Task) => live.mergeDetails?.commitSha === sha
    && live.mergeDetails.mergeTargetBranch === branch
    && live.mergeDetails.pushRecovery?.target === target
    && live.mergeDetails.pushRecovery.commitSha === sha
    && live.mergeDetails.pushRecovery.nextAttemptAt === nextAttemptAt;
  try {
    await git(["check-ref-format", `refs/heads/${branch}`]);
    await git(["check-ref-format", `refs/heads/${targetBranch}`]);
    /*
    FNXC:PostMergePublication 2026-10-07-21:05:
    A landing rewritten off its branch by a push-divergence rebase is delivered as its verified rewrite instead of
    failing this ancestry proof forever. Without a verified rewrite the proof still fails closed.
    */
    const ancestryError = await git(["merge-base", "--is-ancestor", sha, `refs/heads/${branch}`]).then(() => undefined, (error: unknown) => {
      if (isMergeAbortedError(error)) throw error;
      return error ?? new Error(`Landed commit ${sha} is not on ${branch}.`);
    });
    if (ancestryError) {
      const rewritten = await reconcileRewrittenLandedCommit(store, task, { run, fence });
      if (!rewritten) throw ancestryError;
      branchAttempts.delete(key);
      return await recoverConfirmedMergePush(store, rewritten, settings, run, suppliedFence ?? fence, options);
    }
    await fence.write("finalization", () => store.updateTaskAtomic(task.id, (live) => {
      if (live.updatedAt !== task.updatedAt || !eligible(live, settings)
        || live.mergeDetails?.commitSha !== sha || live.mergeDetails.mergeTargetBranch !== branch) return null;
      claimed = true;
      return { mergeDetails: { ...live.mergeDetails, pushRecovery: { target, commitSha: sha, nextAttemptAt } } };
    }));
    if (!claimed) return "deferred";
    const current = await store.getTask(task.id);
    const currentSettings = await store.getSettings();
    if (!eligible(current, currentSettings) || currentSettings.pushRemote !== settings.pushRemote || !ownsAttempt(current)) return "deferred";
    // A newer remote tip may already contain this task; an unproven ancestry falls through to safe push.
    if (!await isCommitOnRemoteBranch(git, remote, targetBranch, sha)) {
      const beforePush = await store.getTask(task.id);
      const beforePushSettings = await store.getSettings();
      if (!eligible(beforePush, beforePushSettings) || beforePushSettings.pushRemote !== settings.pushRemote || !ownsAttempt(beforePush)) return "deferred";
      await git(["push", remote, `${sha}:refs/heads/${targetBranch}`]);
    }
    await fence.write("finalization", () => store.updateTaskAtomic(task.id, (live) => ownsAttempt(live)
      ? { mergeDetails: { ...live.mergeDetails, pushRecovery: { target, commitSha: sha, nextAttemptAt, pushedAt: new Date().toISOString() } } }
      : null));
    await fence.write("log", () => store.logEntry(task.id, `[post-merge] Confirmed landed commit ${sha.slice(0, 12)} is available on ${target}; verification may collect hosted CI evidence.`));
    return "delivered";
  } catch (error) {
    failed = true;
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    await fence.write("finalization", () => store.updateTaskAtomic(task.id, (live) => (claimed ? ownsAttempt(live) : live.updatedAt === task.updatedAt && eligible(live, settings))
      ? { mergeDetails: { ...live.mergeDetails, pushRecovery: { target, commitSha: sha, nextAttemptAt, error: message } } }
      : null)).catch(() => undefined);
    await fence.write("log", () => store.logEntry(task.id, `[post-merge] Remote delivery recovery failed for ${target}; retry after ${nextAttemptAt}. ${message}`)).catch(() => undefined);
    return "failed";
  } finally {
    if (!failed) branchAttempts.delete(key);
  }
}
