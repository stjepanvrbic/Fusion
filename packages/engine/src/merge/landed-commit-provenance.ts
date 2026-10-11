/*
FNXC:LandedCommitProvenance 2026-10-11-07:40:
A commit counts as a task's landing only with proof that it belongs to that task, never because its subject merely names the task ID.
Task IDs are recycled: this fork restarted the `KB-` sequence that upstream history already uses for hundreds of commits, so an unbounded `git log --grep=<id>` finds commits that predate the task by months.
Accepting one finalized KB-012 against a six-month-old upstream `feat(KB-012): …` commit, after which post-landing cleanup deleted the unmerged branch and worktree.
Every landed-commit finder (self-healing `findLandedTaskCommit`, merger `findOwnedLandedCommitForTask`) routes each candidate through this verdict; the workspace land predicate applies the same creation-time guard and is the precedent for the constants.

Rules, in order:
- Ownership comes from the shared `getCommitTaskOwnership` classifier; foreign trailers and prose mentions are rejected.
- A matching lineage trailer is accepted: lineage IDs are generated per task, so one cannot belong to an older task with the same ID.
- A candidate strictly descending from the task's `baseCommitSha` (bounded scope) is accepted: it was committed after the task forked.
- Otherwise (unbounded) the committer time must not predate the task: creation time minus a 24 h clock skew, or a 30-day window when creation time is unknown.
  Committer time, not author time, because rebase, squash and cherry-pick rewrite the committer date to the landing time while author dates can legitimately predate the task.
- An unbounded `Fusion-Task-Id` trailer that passes the age check is accepted.
- An unbounded subject-only hit additionally needs the commit to sit in the task's own branch history; a subject alone outside the task's range is not ownership proof.
*/
import type { CommitTaskOwnership } from "./already-merged-detector.js";
import { TRAILER_SCAN_CLOCK_SKEW_MS, UNBOUNDED_TRAILER_SCAN_WINDOW_MS } from "./workspace-land-predicate.js";

/**
 * `bounded`: the candidate strictly descends from the task's `baseCommitSha`.
 * `unbounded`: anything else (no base, full-HEAD re-scan, base advanced past the landing).
 */
export type LandedCommitScope = "bounded" | "unbounded";

export interface LandedCommitProvenanceInput {
  ownership: CommitTaskOwnership;
  scope: LandedCommitScope;
  /** Committer time in milliseconds; undefined or non-finite when unreadable. */
  commitTimeMs?: number;
  taskCreatedAt?: string;
  /** The task's own lineage ID, so a matching lineage trailer counts even when a task-id trailer is also present. */
  taskLineageId?: string;
  /** Whether the commit is in the task branch's history. Undefined means not probed, which counts as not proven. */
  onTaskBranch?: boolean;
  nowMs: number;
}

export type LandedCommitRejectionReason =
  | "foreign-owner"
  | "not-owned"
  | "commit-time-unknown"
  | "predates-task"
  | "subject-only-outside-task-range";

export type LandedCommitProvenanceVerdict =
  | { accepted: true; proof: NonNullable<CommitTaskOwnership["proof"]> }
  | { accepted: false; reason: LandedCommitRejectionReason };

/** Earliest committer time an unbounded candidate may carry. Mirrors the workspace land predicate. */
export function minLandedCommitTimeMs(taskCreatedAt: string | undefined, nowMs: number): number {
  const parsedCreatedAt = taskCreatedAt === undefined ? Number.NaN : Date.parse(taskCreatedAt);
  return Number.isFinite(parsedCreatedAt)
    ? parsedCreatedAt - TRAILER_SCAN_CLOCK_SKEW_MS
    : nowMs - UNBOUNDED_TRAILER_SCAN_WINDOW_MS;
}

export function assessLandedCommitProvenance(input: LandedCommitProvenanceInput): LandedCommitProvenanceVerdict {
  const { ownership } = input;
  if (ownership.rejectionReason === "foreign-task" || ownership.rejectionReason === "foreign-lineage") {
    return { accepted: false, reason: "foreign-owner" };
  }
  if (!ownership.owned || !ownership.proof) {
    return { accepted: false, reason: "not-owned" };
  }
  const lineageMatched = Boolean(input.taskLineageId) && ownership.ownerLineageId === input.taskLineageId;
  if (ownership.proof === "lineage-trailer" || lineageMatched) {
    return { accepted: true, proof: "lineage-trailer" };
  }
  if (input.scope === "bounded") {
    return { accepted: true, proof: ownership.proof };
  }
  const commitTimeMs = input.commitTimeMs;
  if (commitTimeMs === undefined || !Number.isFinite(commitTimeMs)) {
    return { accepted: false, reason: "commit-time-unknown" };
  }
  if (commitTimeMs < minLandedCommitTimeMs(input.taskCreatedAt, input.nowMs)) {
    return { accepted: false, reason: "predates-task" };
  }
  if (ownership.proof === "task-trailer") {
    return { accepted: true, proof: "task-trailer" };
  }
  if (input.onTaskBranch === true) {
    return { accepted: true, proof: ownership.proof };
  }
  return { accepted: false, reason: "subject-only-outside-task-range" };
}

/**
 * Run the verdict, probing task-branch membership only when the verdict hinges on it.
 * The probe is a git call, so callers supply it; this module stays free of I/O.
 */
export async function resolveLandedCommitProvenance(
  input: Omit<LandedCommitProvenanceInput, "onTaskBranch">,
  probeOnTaskBranch: () => Promise<boolean>,
): Promise<LandedCommitProvenanceVerdict> {
  const verdict = assessLandedCommitProvenance(input);
  if (verdict.accepted || verdict.reason !== "subject-only-outside-task-range") return verdict;
  return assessLandedCommitProvenance({ ...input, onTaskBranch: await probeOnTaskBranch() });
}

/** Parse a `%ct` (seconds) field into milliseconds; undefined when unreadable. */
export function parseCommitTimeSeconds(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
  return Number(value.trim()) * 1_000;
}
