import {
  allowsAutoMergeProcessing,
  ACTIVE_WORKFLOW_WORK_ITEM_STATES,
  computeWorkflowIrPin,
  getPostMergeFinalizeBlocker,
  getRequiredPostMergeEvidenceDecision,
  POST_MERGE_VERIFICATION_GROUP_ID,
  resolveWorkflowIrForTaskWithProvenance,
  type MergeDetails,
  type Settings,
  type TaskStore,
  type WorkflowStepResult,
  type RequiredPostMergeEvidenceDecision,
  type Task,
} from "@fusion/core";
import { activeSessionRegistry, executingTaskLock } from "../agents/active-session-registry.js";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import { generateSyntheticRunId } from "../util/run-audit.js";
import { createMergeWriteFence, type MergeWriteFence } from "./merge-write-fence.js";
import { isTaskExecutionLive } from "./merge-execution-exclusion.js";
import { probeLandedCommitPublication, reconcileRewrittenLandedCommit, type GitRun, type LandedCommitPublication } from "./landed-commit-publication.js";
import { isPushAfterMergeEnabled } from "./push-after-merge-policy.js";
import { recoverConfirmedMergePush } from "./recover-confirmed-merge-push.js";

/**
 * FNXC:PostMergeRecovery 2026-10-01-06:55:
 * A landed card with an absent post-merge gate must resume at that gate, not repeatedly try to
 * finalize or rerun implementation/merge. Existing results (including REVISE) remain authoritative
 * until a real recheck reports; scheduling work never grants approval or erases a rejection.
 * A fresh durable checkout lease is live ownership even when this process has no active session, so
 * finalization and self-healing must refuse it before the snapshot-fenced idle insert.
 */
const DEFAULT_CHECKOUT_LEASE_GRACE_MS = 10 * 60_000;
const CHECKOUT_LEASE_STALENESS_MULTIPLIER = 3;

function hasFreshCheckoutLease(
  task: { checkoutRunId?: string | null; checkoutLeaseRenewedAt?: string | null },
  settings: { taskStuckTimeoutMs?: number },
): boolean {
  const leaseAge = task.checkoutLeaseRenewedAt
    ? Date.now() - Date.parse(task.checkoutLeaseRenewedAt)
    : Number.POSITIVE_INFINITY;
  const graceMs = (settings.taskStuckTimeoutMs ?? DEFAULT_CHECKOUT_LEASE_GRACE_MS)
    * CHECKOUT_LEASE_STALENESS_MULTIPLIER;
  return !!task.checkoutRunId && Number.isFinite(leaseAge) && leaseAge >= 0 && leaseAge < graceMs;
}

type PersistedPublicationWaitReason = NonNullable<MergeDetails["publicationWait"]>["reason"];
/**
 * FNXC:PostMergePublication 2026-10-07-17:58:
 * `push-pending` means a confirmed-merge push for this target is in flight, cooling down, or owned by another task.
 * It is transient and process-observed, so it is reported to the caller but never persisted as `publicationWait`
 * and never audited: a durable "push failed" record for a push that is succeeding misleads the operator.
 */
export type PostMergePublicationWaitReason = PersistedPublicationWaitReason | "push-pending";

export type PostMergeGateResumeResult =
  | { outcome: "resumed"; gateId: string }
  | { outcome: "awaiting-publication"; gateId: string; reason: PostMergePublicationWaitReason; message: string }
  | { outcome: "not-resumable" };

/*
FNXC:PostMergePublication 2026-10-07-13:00:
The built-in post-merge verification gate's evidence is the hosted Full Suite run on the push remote at or
after the landed SHA, so it cannot pass while that commit is unpublished. Rechecking it anyway ran a reviewer
every hour that could only REVISE "no Full Suite run exists". Every reseed of that gate (finalization,
merge pump, self-healing, manual Retry) first proves publication: published proceeds; unpublished with
push-after-merge on retries the confirmed-merge push and proceeds only if it delivered; unpublished with push
off, a failed push, or an undeterminable remote does not reseed. Unknown is never conflated with unpublished
and fails closed only for that tick. Each distinct waiting state is logged and audited once per commit.
User-defined post-merge gates own their own evidence contract and are not gated on publication.
*/
/*
FNXC:PostMergePublication 2026-10-07-17:58:
Workspace and shared-branch landings stay exempt. A workspace landing has one SHA per repository and publishes through the per-repository land-intent path, so the single `mergeDetails.commitSha` probe cannot represent it.
A shared-branch member lands on the group branch, whose publication is the group promotion, not this commit's push.
Their gates keep the rejected-evidence recheck ladder (capped at one reviewer run per hour) until a publication owner exists for them.
*/
function requiresPublishedLanding(task: Task, gateId: string): boolean {
  // Workspace and shared-branch landings publish through other owners; a missing SHA cannot be probed.
  return gateId === POST_MERGE_VERIFICATION_GROUP_ID && !!task.mergeDetails?.commitSha
    && !task.workspaceWorktrees && task.branchContext?.assignmentMode !== "shared";
}

/*
FNXC:PostMergePublication 2026-10-07-14:05:
Every caller (merge pump, finalization, self-healing sweeps) re-enters this seam on its own cadence, and a waiting gate's rejection timestamp never advances, so without a throttle each tick would hit the network with ls-remote and, with push on, retry a failing push.
A waiting landing re-probes at most once per interval per commit; a manual Retry always probes. Process-local by design: a restart probes immediately, which is the desired recheck.
*/
export const POST_MERGE_PUBLICATION_REPROBE_INTERVAL_MS = 2 * 60_000;
const publicationWaits = new Map<string, { probedAt: number; result: Extract<PostMergeGateResumeResult, { outcome: "awaiting-publication" }> }>();

type PublicationPrecondition =
  | { outcome: "published" }
  | { outcome: "delivered" }
  | { outcome: "waiting"; reason: PostMergePublicationWaitReason; publication: LandedCommitPublication };

async function establishLandedCommitPublication(
  store: TaskStore,
  task: Task,
  settings: Settings,
  fence: MergeWriteFence,
  git: GitRun | undefined,
): Promise<PublicationPrecondition> {
  const publication = await probeLandedCommitPublication(store, task, settings, { run: git, fence });
  if (publication.state === "published") return { outcome: "published" };
  if (publication.state === "unknown") return { outcome: "waiting", reason: "publication-unknown", publication };
  if (!isPushAfterMergeEnabled(settings)) return { outcome: "waiting", reason: "push-disabled", publication };
  const pushed = await recoverConfirmedMergePush(store, task, settings, git, fence, { remoteProvenAbsent: true });
  if (pushed === "delivered") return { outcome: "delivered" };
  // Every eligibility input of push recovery is pre-checked by the caller, so `skipped` here is a race, like `deferred`.
  return { outcome: "waiting", reason: pushed === "failed" ? "push-failed" : "push-pending", publication };
}

function publicationWaitMessage(reason: PostMergePublicationWaitReason, shortSha: string, target: string, targetBranch: string, remote: string): string {
  const prefix = "Post-merge verification is waiting for publication:";
  const rerun = "the gate re-runs once the commit is on the remote.";
  if (reason === "push-disabled") return `${prefix} ${shortSha} is not on ${target} and Push after merge is off. Enable Push after merge or push ${targetBranch} to ${remote}; ${rerun}`;
  if (reason === "push-failed") return `${prefix} ${shortSha} is not on ${target} and push-after-merge recovery did not publish it. Resolve the push failure or push ${targetBranch} to ${remote}; ${rerun}`;
  if (reason === "push-pending") return `${prefix} ${shortSha} is not on ${target} yet and a push to ${target} is in progress or scheduled; ${rerun}`;
  return `${prefix} could not determine whether ${shortSha} is on ${target} (remote unreachable or git error). The gate re-runs once the remote can confirm the commit.`;
}

async function reportAwaitingPublication(
  store: TaskStore,
  task: Task,
  gateId: string,
  wait: Extract<PublicationPrecondition, { outcome: "waiting" }>,
  fence: MergeWriteFence,
): Promise<PostMergeGateResumeResult> {
  const { reason, publication } = wait;
  const sha = publication.sha;
  const shortSha = sha.slice(0, 12);
  const remote = publication.target?.remote ?? "origin";
  const targetBranch = publication.target?.targetBranch ?? task.mergeDetails?.mergeTargetBranch ?? "the target branch";
  const target = publication.target?.target ?? `${remote}/${targetBranch}`;
  const message = publicationWaitMessage(reason, shortSha, target, targetBranch, remote);
  if (reason === "push-pending") return { outcome: "awaiting-publication", gateId, reason, message };
  const isReported = (details: MergeDetails | undefined) => details?.publicationWait?.commitSha === sha
    && details.publicationWait.target === target && details.publicationWait.reason === reason;
  if (!isReported(task.mergeDetails)) {
    let claimed = false;
    await fence.write("finalization", () => store.updateTaskAtomic(task.id, (live) => {
      if (!live.mergeDetails || live.mergeDetails.commitSha !== sha || isReported(live.mergeDetails)) return null;
      claimed = true;
      return { mergeDetails: { ...live.mergeDetails, publicationWait: { commitSha: sha, target, reason, recordedAt: new Date().toISOString() } } };
    }));
    if (claimed) {
      await fence.write("log", () => store.logEntry(task.id, `[post-merge] ${message}`));
      await fence.write("audit", () => emitBoundedRunAudit(store, {
        taskId: task.id, agentId: "post-merge-recovery", runId: generateSyntheticRunId("post-merge-publication", task.id),
        domain: "database", mutationType: "task:post-merge-gate-awaiting-publication", target: task.id,
        metadata: { taskId: task.id, nodeId: gateId, reason, remote, shortSha },
      }));
    }
  }
  return { outcome: "awaiting-publication", gateId, reason, message };
}

const EXHAUSTED_PREFIX = "Post-merge verification needs remediation";

function hasLegacyRecoveryFailure(task: Pick<Task, "status" | "error">): boolean {
  return task.status === "failed" && task.error?.startsWith(`${EXHAUSTED_PREFIX}:`) === true;
}

/*
FNXC:ReviewRecovery 2026-10-04-02:24:
Post-merge reviewers can run before hosted CI finishes. Revisit rejected evidence after 15 minutes,
then 30 and 60 minutes, with further checks capped at one per hour. CI and follow-up fixes can
arrive after the early retries; a total attempt cap would strand their evidence permanently.
Durable result history survives restart and task-log updates cannot shorten the wait. Missing
timestamps, duplicate evidence and live owners fail closed.

FNXC:PostMergeRecovery 2026-10-08-07:08:
KB-042: a workspace landing's per-repository `post-merge-checkout-missing-landed-commit` failure (a dirty,
branch-mismatched or unrecoverable repository checkout) uses this same 15/30/60-then-hourly ladder. Workspace
landings skip the publication probe (`requiresPublishedLanding`), so this check alone governs their recheck, and
each recheck reruns the per-repository in-place recovery in `runGraphCustomNode`.
*/
function isRejectedGateRecheckDue(result: WorkflowStepResult): boolean {
  const failures = (result.priorAttempts ?? []).filter((entry) => entry.status === "failed").length;
  const completedAt = Date.parse(result.completedAt ?? "");
  return result.status === "failed" && Number.isFinite(completedAt)
    && Date.now() - completedAt >= 15 * 60_000 * 2 ** Math.min(failures, 2);
}

export function isPostMergeGateRecoveryDue(
  task: Pick<Task, "workflowStepResults" | "status" | "error">,
  decision: RequiredPostMergeEvidenceDecision,
): boolean {
  if (hasLegacyRecoveryFailure(task)) return true;
  if (decision.outcome === "resumable") return true;
  if (decision.outcome !== "blocked" || decision.reason !== "failed") return false;
  const result = task.workflowStepResults?.find((entry) => entry.workflowStepId === decision.gateId);
  return !!result && isRejectedGateRecheckDue(result);
}

export async function resumeMissingPostMergeGate(
  store: TaskStore,
  taskId: string,
  options: { manualRetry?: boolean; fence?: MergeWriteFence; git?: GitRun } = {},
): Promise<PostMergeGateResumeResult> {
  const fence = options.fence ?? createMergeWriteFence({ taskId });
  if (typeof store.seedWorkspaceCodeReviewContinuationIfIdle !== "function") return { outcome: "not-resumable" };
  let task: Task = await store.getTask(taskId);
  const settings = await store.getSettings();
  if (!task.mergeDetails?.mergeConfirmed || !task.updatedAt
    || task.paused || task.userPaused || task.deletedAt || task.autoMerge === false
    || settings.globalPause || settings.enginePaused
    || !allowsAutoMergeProcessing(task, settings)
    || getPostMergeFinalizeBlocker(task)
    || hasFreshCheckoutLease(task, settings)
    || isTaskExecutionLive(task.id, { activeSessionRegistry, executingTaskLock })) return { outcome: "not-resumable" };

  if (hasLegacyRecoveryFailure(task)) {
    // Old recovery marked waiting reviews failed. Clear only its owned diagnostic;
    // the gate result and completion timestamp still govern approval and retry timing.
    const snapshot = task;
    let cleared = false;
    const updated = await fence.write("finalization", () => store.updateTaskAtomic(task.id, async (live) => {
      if (live.updatedAt !== snapshot.updatedAt || live.column !== snapshot.column
        || live.status !== snapshot.status || live.error !== snapshot.error
        || live.paused || live.userPaused || live.deletedAt
        || !live.mergeDetails?.mergeConfirmed || live.autoMerge === false
        || hasFreshCheckoutLease(live, settings)
        || isTaskExecutionLive(live.id, { activeSessionRegistry, executingTaskLock })) return null;
      const items = await store.listWorkflowWorkItemsForTask(task.id);
      if (items.some((item) => ACTIVE_WORKFLOW_WORK_ITEM_STATES.includes(item.state))) return null;
      fence.assertOwned("finalization");
      cleared = true;
      return { status: null as unknown as Task["status"], error: null as unknown as Task["error"] };
    }, undefined, () => !fence.isOrphaned(), {
      expectedUpdatedAt: snapshot.updatedAt,
      expectedCheckedOutBy: snapshot.checkedOutBy ?? null,
      expectedCheckoutNodeId: snapshot.checkoutNodeId ?? null,
      expectedCheckoutLeaseEpoch: snapshot.checkoutLeaseEpoch ?? 0,
    }));
    if (!cleared || !updated || updated.status != null || updated.error != null) return { outcome: "not-resumable" };
    task = updated;
  }

  const decision = await getRequiredPostMergeEvidenceDecision(store, task);
  const manualRetry = options.manualRetry === true && decision.outcome === "blocked" && decision.reason === "failed";
  if (decision.outcome === "finalizable" || (!manualRetry && !isPostMergeGateRecoveryDue(task, decision))) return { outcome: "not-resumable" };
  const selection = await store.getTaskWorkflowSelectionAsync(task.id);
  const resolved = await resolveWorkflowIrForTaskWithProvenance(store, task.id);
  if (resolved.source === "default" && !resolved.selectionAbsent) return { outcome: "not-resumable" };
  const { ir } = resolved;
  const node = ir.version === "v2" ? ir.nodes.find((candidate) => candidate.id === decision.gateId) : undefined;
  if (!node) return { outcome: "not-resumable" };

  const items = await store.listWorkflowWorkItemsForTask(task.id);
  if (requiresPublishedLanding(task, node.id)) {
    // A queued or running gate owns this tick; probing or pushing for it would only race the seed refusal.
    if (items.some((item) => ACTIVE_WORKFLOW_WORK_ITEM_STATES.includes(item.state))) return { outcome: "not-resumable" };
    // A push-divergence rebase may have rewritten this landing; probe the published rewrite, not the orphaned SHA.
    if (await reconcileRewrittenLandedCommit(store, task, { run: options.git, fence })) {
      return resumeMissingPostMergeGate(store, taskId, { ...options, fence });
    }
    const waitKey = `${task.id}:${task.mergeDetails?.commitSha}`;
    const cachedWait = publicationWaits.get(waitKey);
    if (cachedWait && !manualRetry && Date.now() - cachedWait.probedAt < POST_MERGE_PUBLICATION_REPROBE_INTERVAL_MS) return cachedWait.result;
    const publication = await establishLandedCommitPublication(store, task, settings, fence, options.git);
    if (publication.outcome === "waiting") {
      const result = await reportAwaitingPublication(store, task, node.id, publication, fence);
      if (result.outcome === "awaiting-publication") publicationWaits.set(waitKey, { probedAt: Date.now(), result });
      return result;
    }
    publicationWaits.delete(waitKey);
    // Push recovery rewrote the task row; re-enter on a fresh snapshot so every fence re-reads live state.
    if (publication.outcome === "delivered") return resumeMissingPostMergeGate(store, taskId, { ...options, fence });
  }
  const seeded = await fence.write("finalization", () => store.seedWorkspaceCodeReviewContinuationIfIdle({
    taskId: task.id,
    nodeId: node.id,
    kind: "task",
    state: "runnable",
    runId: `${task.id}:post-merge-gate-reseed:${node.id}:${items.length}`,
    stableWorkflowRunId: `${task.id}:${ir.name}`,
    continuationSequence: items.length,
    sourceColumn: task.column,
    targetColumn: task.column,
    irHash: computeWorkflowIrPin(ir, node.id).irHash,
    expectedWorkflowSelection: selection ?? null,
    expectedTaskUpdatedAt: task.updatedAt,
  }));
  if (!seeded?.seeded) return { outcome: "not-resumable" };
  await fence.write("log", () => store.logEntry(task.id, `[post-merge] ${decision.outcome === "resumable" ? "Resuming missing verification" : "Rechecking rejected evidence"} at '${node.id}'; already-landed implementation and merge will not run again.`));
  return { outcome: "resumed", gateId: node.id };
}
