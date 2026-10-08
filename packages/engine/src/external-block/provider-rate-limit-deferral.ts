/*
FNXC:ProviderRateLimitDeferral 2026-10-08-16:05:
KB-077 operator requirements. On 2026-10-08 a 429 window parked KB-066 failed in review within a minute: its Code Review died with an
empty step error, the no-verdict recovery re-seeded it into the same 429, and the bounded repair gave up. KB-065's AI merge was parked
failed with the raw 429 text. Executors that hit the same 429 freeze and resume automatically with backoff.

- Review steps (Plan Review, Code Review, Browser Verification, Post-merge Verification) and the AI merge session use the executor's
  transient taxonomy: a failure is deferred iff `classifyExternalObstacle` says model-provider/RATE_LIMIT. Quota/billing (USAGE_LIMIT),
  credentials, network, and host codes keep their existing review/merge behaviour.
- The provider error is recorded on the step result (or the task log for the merge lane) instead of an empty diagnostic.
- The card is kept in place without a failed park: it enters the executor's external-block freeze (`parkTaskOnExternalObstacle`),
  which schedules automatic resumes at 5, 15, 30, 60, 120, 120 minutes. The budget is the SAME `externalBlockAutoResumeCount` /
  `EXTERNAL_BLOCK_AUTO_RESUME_BUDGET` (6) the executor uses, shared with executor freezes on the same card and cleared only by operator
  Retry. No second schedule, counter, or timer exists for these lanes.
- Once the budget is spent the freeze stays raised without `autoResume` and waits for operator Retry; that is the park, identical to
  the executor's spent-budget outcome.
- A genuine reviewer failure that is not a provider error keeps today's behaviour, and only automatic recovery defers: operator retry
  paths never call these helpers.
- Human control wins: a user pause, a soft delete, or any pause other than the engine's own `provider-rate-limit:*` pause refuses the
  freeze. A merge-confirmed card is refused for the merge lane and pre-merge review steps; Post-merge Verification runs on merge-confirmed
  cards by design and is deferred normally. A review card under auto-merge Off keeps today's behaviour (FN-5147); Plan Review is exempt
  from that gate because it runs before review.
*/
import {
  EXTERNAL_BLOCK_AUTO_RESUME_BUDGET,
  PLAN_REVIEW_GROUP_ID,
  allowsAutoMergeProcessing,
  buildTaskExternalBlockReport,
  isMergeRegionNode,
  isTaskExternallyBlocked,
  planExternalBlockAutoResume,
  resolveWorkflowIrForTask,
  type Task,
  type TaskExternalBlock,
  type TaskStore,
  type WorkflowIr,
  type WorkflowStepResult,
} from "@fusion/core";
import { classifyExternalObstacle } from "../execution-block-classifier.js";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import { generateSyntheticRunId } from "../util/run-audit.js";
import { parkTaskOnExternalObstacle } from "./external-block-lifecycle.js";

/** Fixed refusal codes; a refusal never writes and leaves the caller on its existing path. */
export type ProviderRateLimitDeferralRefusal =
  | "user-paused"
  | "operator-held"
  | "already-frozen"
  | "merge-confirmed"
  | "auto-merge-off"
  | "no-resume-node"
  | "not-rate-limit"
  | "deleted";

export type ProviderRateLimitDeferralResult =
  | { deferred: true; outcome: "deferred" | "budget-exhausted"; nodeId: string; attempt: number }
  | { deferred: false; reason: ProviderRateLimitDeferralRefusal };

type RunContext = Parameters<TaskStore["logEntry"]>[3];

export type ProviderRateLimitDeferralStore = Pick<TaskStore, "getTask" | "updateTask" | "logEntry" | "getSettings">
  & Partial<Pick<TaskStore, "withPlanningLifecycleLock" | "recordRunAuditEvent" | "getTaskWorkflowSelectionAsync" | "getTaskWorkflowSelection" | "getWorkflowDefinition">>;

/** The engine-authored provider pause (`UsageLimitPauser.onUsageLimitHit`) is the only pause a rate-limit freeze may supersede. */
const ENGINE_PROVIDER_RATE_LIMIT_PAUSE_PREFIX = "provider-rate-limit:";

/** A failed, verdict-less step result whose recorded session error was classified as a provider rate limit. */
export function isRateLimitedNoVerdictResult(result: Pick<WorkflowStepResult, "status" | "verdict" | "providerFailure"> | undefined | null): boolean {
  return result?.status === "failed" && result.verdict === undefined && result.providerFailure?.code === "RATE_LIMIT";
}

/**
 * The rate-limited, verdict-less review result a graph run just produced, matched against the run's visited node ids (a top-level node
 * id, or an optional-group id that prefixes its template instance ids with `::`). Results the run did not visit are never matched, so a
 * stale failed result cannot freeze a card for an unrelated failure.
 */
export function findRateLimitedReviewResultForRun(
  task: Pick<Task, "workflowStepResults">,
  visitedNodeIds: readonly string[],
): WorkflowStepResult | undefined {
  const visited = new Set<string>();
  for (const id of visitedNodeIds) {
    visited.add(id);
    const delimiter = id.indexOf("::");
    if (delimiter > 0) visited.add(id.slice(0, delimiter));
  }
  return (task.workflowStepResults ?? [])
    .filter((result) => visited.has(result.workflowStepId) && isRateLimitedNoVerdictResult(result))
    .sort((a, b) => Date.parse(b.completedAt ?? b.startedAt ?? "") - Date.parse(a.completedAt ?? a.startedAt ?? ""))[0];
}

/** True when a free-form session/merge error classifies as a provider rate limit under the executor's taxonomy. */
export function isProviderRateLimitError(message: string | undefined | null): boolean {
  if (typeof message !== "string") return false;
  const obstacle = classifyExternalObstacle(message);
  return obstacle?.origin === "model-provider" && obstacle.code === "RATE_LIMIT";
}

function formatMinutes(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes % 60 === 0 && minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`;
}

function humanControlRefusal(task: Task | undefined | null): ProviderRateLimitDeferralRefusal | undefined {
  if (!task || task.deletedAt) return "deleted";
  if (task.userPaused) return "user-paused";
  if (isTaskExternallyBlocked(task)) return "already-frozen";
  if (task.paused && !(typeof task.pausedReason === "string" && task.pausedReason.startsWith(ENGINE_PROVIDER_RATE_LIMIT_PAUSE_PREFIX))) {
    return "operator-held";
  }
  if (task.status === "failed" || task.status === "awaiting-approval" || task.status === "awaiting-user-input") return "operator-held";
  return undefined;
}

/** FN-5147: a task-level or project-level auto-merge Off card is terminal-until-human; it keeps today's review/merge handling. */
async function autoMergeProcessingAllowed(store: ProviderRateLimitDeferralStore, task: Task): Promise<boolean> {
  return task.autoMerge !== false && allowsAutoMergeProcessing(task, await store.getSettings());
}

async function underLock<T>(store: ProviderRateLimitDeferralStore, taskId: string, work: () => Promise<T>): Promise<T> {
  return typeof store.withPlanningLifecycleLock === "function" ? store.withPlanningLifecycleLock(taskId, work) : work();
}

async function freeze(input: {
  store: ProviderRateLimitDeferralStore;
  live: Task;
  lane: "review" | "merge";
  nodeId: string;
  laneLabel: string;
  errorMessage: string;
  workflowStepId?: string;
  phase?: "pre-merge" | "post-merge";
  agentId: string;
  nowMs: number;
  runContext?: RunContext;
}): Promise<ProviderRateLimitDeferralResult> {
  const { store, live, nodeId, nowMs } = input;
  const obstacle = { origin: "model-provider" as const, code: "RATE_LIMIT" };
  const externalBlock: TaskExternalBlock = {
    ...obstacle,
    message: input.errorMessage,
    report: buildTaskExternalBlockReport(obstacle),
    source: "session-failure",
    blockedAt: new Date(nowMs).toISOString(),
    resume: {
      column: live.column,
      nodeId,
      currentStep: live.currentStep,
      worktree: live.worktree,
      branch: live.branch,
    },
  };
  const plan = planExternalBlockAutoResume(externalBlock, live.externalBlockAutoResumeCount, nowMs);
  const spent = Math.max(0, Math.floor(live.externalBlockAutoResumeCount ?? 0));
  const attempt = plan?.attempt ?? spent;
  const outcome = plan ? "deferred" as const : "budget-exhausted" as const;
  const logMessage = plan
    ? `${input.laneLabel} hit a provider rate limit — automatic re-run ${plan.attempt}/${plan.budget} in ${formatMinutes(plan.delayMs)}; Retry re-runs now`
    : `${input.laneLabel} hit a provider rate limit — automatic re-run budget spent (${EXTERNAL_BLOCK_AUTO_RESUME_BUDGET}/${EXTERNAL_BLOCK_AUTO_RESUME_BUDGET}); waiting for operator Retry`;
  await parkTaskOnExternalObstacle({
    store,
    task: live,
    externalBlock,
    logMessage,
    nowMs,
    agentId: input.agentId,
    runContext: input.runContext,
    writeRunContext: input.runContext,
  });
  await emitBoundedRunAudit(store, {
    taskId: live.id,
    agentId: input.agentId,
    runId: generateSyntheticRunId("provider-rate-limit", live.id),
    domain: "database",
    mutationType: "task:provider-rate-limit-deferred",
    target: live.id,
    metadata: {
      taskId: live.id,
      lane: input.lane,
      nodeId,
      ...(input.workflowStepId ? { workflowStepId: input.workflowStepId } : {}),
      ...(input.phase ? { phase: input.phase } : {}),
      code: "RATE_LIMIT",
      attempt,
      budget: EXTERNAL_BLOCK_AUTO_RESUME_BUDGET,
      outcome,
    },
  });
  return { deferred: true, outcome, nodeId, attempt };
}

/**
 * Freezes a card whose review step failed before producing a verdict because of a provider rate limit, resuming at that review node on
 * the external-block schedule. `nodeId` is the failed step's top-level IR node (the step result's `workflowStepId`).
 */
export async function deferReviewStepOnProviderRateLimit(input: {
  store: ProviderRateLimitDeferralStore;
  taskId: string;
  result: WorkflowStepResult;
  nodeId?: string;
  agentId?: string;
  nowMs?: number;
  runContext?: RunContext;
}): Promise<ProviderRateLimitDeferralResult> {
  const { store, taskId, result } = input;
  if (!isRateLimitedNoVerdictResult(result)) return { deferred: false, reason: "not-rate-limit" };
  const nodeId = input.nodeId ?? result.workflowStepId;
  const phase = result.phase === "post-merge" ? "post-merge" as const : "pre-merge" as const;
  const isPlanReview = result.workflowStepId === PLAN_REVIEW_GROUP_ID || result.reviewKind === "plan";
  return underLock(store, taskId, async () => {
    const live = await store.getTask(taskId).catch(() => undefined);
    const refusal = humanControlRefusal(live);
    if (refusal || !live) return { deferred: false, reason: refusal ?? "deleted" } as const;
    // The failed result must still be the current one: a later attempt or a cleared result is not ours to freeze.
    const current = live.workflowStepResults?.find((entry) => entry.workflowStepId === result.workflowStepId);
    if (current && !isRateLimitedNoVerdictResult(current)) return { deferred: false, reason: "not-rate-limit" } as const;
    if (phase === "pre-merge" && live.mergeDetails?.mergeConfirmed) return { deferred: false, reason: "merge-confirmed" } as const;
    if (phase === "pre-merge" && !isPlanReview && !(await autoMergeProcessingAllowed(store, live))) {
      return { deferred: false, reason: "auto-merge-off" } as const;
    }
    const laneLabel = result.workflowStepName || result.workflowStepId;
    const errorMessage = (current?.output ?? result.output ?? "").trim() || `${laneLabel} failed with a provider rate limit`;
    return freeze({
      store,
      live,
      lane: "review",
      nodeId,
      laneLabel,
      errorMessage,
      workflowStepId: result.workflowStepId,
      phase,
      agentId: input.agentId ?? "reviewer",
      nowMs: input.nowMs ?? Date.now(),
      runContext: input.runContext,
    });
  });
}

/**
 * FNXC:ProviderRateLimitDeferral 2026-10-08-16:05:
 * The merge freeze resumes at the workflow's merge entry. Prefer the merge gate (it re-checks admission before attempting), then the
 * merge attempt, then a linear `seam: "merge"` node, then any merge-region node. When nothing resolves, refuse: resuming at the column's
 * first node would re-run Code Review instead of retrying the merge.
 */
export function resolveMergeResumeNodeId(ir: WorkflowIr, preferredNodeId?: string): string | undefined {
  if (!Array.isArray(ir?.nodes)) return undefined;
  if (preferredNodeId) {
    const preferred = ir.nodes.find((node) => node.id === preferredNodeId);
    if (preferred && isMergeRegionNode(preferred)) return preferred.id;
  }
  return ir.nodes.find((node) => node.kind === "merge-gate")?.id
    ?? ir.nodes.find((node) => node.kind === "merge-attempt")?.id
    ?? ir.nodes.find((node) => node.config?.seam === "merge")?.id
    ?? ir.nodes.find((node) => isMergeRegionNode(node))?.id;
}

/**
 * Freezes a card whose AI merge session failed with a provider rate limit, resuming at its workflow's merge node on the external-block
 * schedule. Never touches `mergeRetries` or `mergeTransientRetryCount`.
 */
export async function deferMergeOnProviderRateLimit(input: {
  store: ProviderRateLimitDeferralStore;
  taskId: string;
  errorMessage: string;
  /** The merge node the graph failed at, when known (graph-owned merges). */
  preferredNodeId?: string;
  agentId?: string;
  nowMs?: number;
  runContext?: RunContext;
}): Promise<ProviderRateLimitDeferralResult> {
  const { store, taskId } = input;
  if (!isProviderRateLimitError(input.errorMessage)) return { deferred: false, reason: "not-rate-limit" };
  return underLock(store, taskId, async () => {
    const live = await store.getTask(taskId).catch(() => undefined);
    const refusal = humanControlRefusal(live);
    if (refusal || !live) return { deferred: false, reason: refusal ?? "deleted" } as const;
    if (live.mergeDetails?.mergeConfirmed) return { deferred: false, reason: "merge-confirmed" } as const;
    if (!(await autoMergeProcessingAllowed(store, live))) return { deferred: false, reason: "auto-merge-off" } as const;
    const ir = await resolveWorkflowIrForTask(store as never, taskId).catch(() => undefined);
    const nodeId = ir ? resolveMergeResumeNodeId(ir, input.preferredNodeId) : undefined;
    if (!nodeId) {
      await store.logEntry(
        taskId,
        "AI merge hit a provider rate limit but its workflow has no merge node to resume at — keeping the existing merge failure handling",
        undefined,
        input.runContext,
      );
      return { deferred: false, reason: "no-resume-node" } as const;
    }
    return freeze({
      store,
      live,
      lane: "merge",
      nodeId,
      laneLabel: "AI merge",
      errorMessage: input.errorMessage,
      agentId: input.agentId ?? "merger",
      nowMs: input.nowMs ?? Date.now(),
      runContext: input.runContext,
    });
  });
}
