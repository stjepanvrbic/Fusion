import type { WorkflowStepResult } from "../types.js";

/*
FNXC:PostMergeEvidenceWait 2026-10-08-19:12:
KB-080: post-landing CI evidence that does not exist yet (push run not started, queued or in progress, timing
artifacts not yet published) is not a task defect, so a required post-merge gate must never record it as
REVISE or failed. The gate reports a post-merge-only WAIT verdict; the engine persists it as the distinct
`awaiting-evidence` step status (terminal, blocking, not approved, not red) with an `evidenceWait` record.
The shared post-merge reseed seam re-dispatches the gate on its own backoff (5, 10, 20, then every 30 minutes)
until a real verdict arrives. A wait that has not concluded 8 hours after it was first observed becomes a
visible failed row that is not polled automatically; an operator Retry or reconcile starts a new window.
A wait never moves a card between columns and never writes task status or error.
These helpers are pure so the graph recorder, the reseed seam and tests share one implementation.
*/

/** Pending-evidence states a post-merge gate may report with a WAIT verdict. */
export const POST_MERGE_EVIDENCE_WAIT_STATES = [
  "run-not-started",
  "run-queued",
  "run-in-progress",
  "artifacts-pending",
  "unspecified",
] as const;

export type PostMergeEvidenceWaitState = typeof POST_MERGE_EVIDENCE_WAIT_STATES[number];

/** Durable wait record carried by an `awaiting-evidence` (or exhausted `failed`) post-merge gate row. */
export interface PostMergeEvidenceWait {
  state: PostMergeEvidenceWaitState;
  /** CI run identifier the reviewer observed, when known. Bounded to a safe token. */
  runId?: string;
  /** ISO-8601 time the current wait window was first observed. Carried across consecutive waits. */
  firstObservedAt: string;
  /** Number of consecutive WAIT verdicts in the current window (1 for the first). */
  checkCount: number;
  /** ISO-8601 time the 8-hour ceiling was reached; present only on the exhausted failed row. */
  exhaustedAt?: string;
}

/** Normalized pending-evidence payload parsed from a reviewer's WAIT verdict. */
export interface PostMergeEvidencePending {
  state: PostMergeEvidenceWaitState;
  runId?: string;
}

/** Ceiling after which an unconcluded wait stops automatic polling and surfaces to the operator. */
export const POST_MERGE_EVIDENCE_WAIT_CEILING_MS = 8 * 60 * 60_000;

/** Graph failure value carried by a WAIT outcome from the step session to the optional-group recorder. */
export const POST_MERGE_EVIDENCE_PENDING_VALUE = "post-merge-evidence-pending";

const BASE_BACKOFF_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const STATE_SET: ReadonlySet<string> = new Set(POST_MERGE_EVIDENCE_WAIT_STATES);
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Delay before re-dispatching a gate after its `checkCount`-th consecutive WAIT: 5, 10, 20, then 30 minutes. */
export function postMergeEvidenceWaitBackoffMs(checkCount: number): number {
  const count = Number.isFinite(checkCount) && checkCount >= 1 ? Math.floor(checkCount) : 1;
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(count - 1, 10));
}

/** Normalize reviewer-authored pending-evidence JSON; unknown states become `unspecified`, unsafe run ids are dropped. */
export function normalizePostMergeEvidencePending(raw: unknown): PostMergeEvidencePending {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as { state?: unknown; runId?: unknown } : {};
  const state = typeof record.state === "string" && STATE_SET.has(record.state.trim())
    ? record.state.trim() as PostMergeEvidenceWaitState
    : "unspecified";
  const runId = typeof record.runId === "string" && RUN_ID_PATTERN.test(record.runId) ? record.runId : undefined;
  return runId ? { state, runId } : { state };
}

/**
 * Compute the wait record for a new WAIT observation. Only an immediately prior `awaiting-evidence` row continues
 * the window (so `priorAttempts` truncation can never reset it); any other prior row, or none, starts a new window.
 */
export function nextPostMergeEvidenceWait(
  prior: Pick<WorkflowStepResult, "status" | "evidenceWait"> | undefined,
  observed: PostMergeEvidencePending,
  nowIso: string,
): { evidenceWait: PostMergeEvidenceWait; exhausted: boolean } {
  const continuing = prior?.status === "awaiting-evidence"
    && !!prior.evidenceWait
    && Number.isFinite(Date.parse(prior.evidenceWait.firstObservedAt));
  const firstObservedAt = continuing ? prior!.evidenceWait!.firstObservedAt : nowIso;
  const priorCount = continuing && Number.isFinite(prior!.evidenceWait!.checkCount) ? Math.max(0, prior!.evidenceWait!.checkCount) : 0;
  const evidenceWait: PostMergeEvidenceWait = {
    state: observed.state,
    ...(observed.runId ? { runId: observed.runId } : {}),
    firstObservedAt,
    checkCount: priorCount + 1,
  };
  const exhausted = Date.parse(nowIso) - Date.parse(firstObservedAt) >= POST_MERGE_EVIDENCE_WAIT_CEILING_MS;
  return { evidenceWait, exhausted };
}

/** True when an `awaiting-evidence` gate row has waited out its backoff and should be re-dispatched. */
export function isPostMergeEvidenceWaitRecheckDue(
  result: Pick<WorkflowStepResult, "status" | "completedAt" | "evidenceWait">,
  nowMs: number,
): boolean {
  if (result.status !== "awaiting-evidence") return false;
  const completedAt = Date.parse(result.completedAt ?? "");
  if (!Number.isFinite(completedAt)) return false;
  return nowMs - completedAt >= postMergeEvidenceWaitBackoffMs(result.evidenceWait?.checkCount ?? 1);
}
