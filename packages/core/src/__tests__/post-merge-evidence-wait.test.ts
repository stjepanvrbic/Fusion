import { describe, expect, it } from "vitest";
import {
  isPostMergeEvidenceWaitRecheckDue,
  nextPostMergeEvidenceWait,
  normalizePostMergeEvidencePending,
  postMergeEvidenceWaitBackoffMs,
  POST_MERGE_EVIDENCE_WAIT_CEILING_MS,
} from "../merge/post-merge-evidence-wait.js";
import { isTerminalStepResult, upsertWorkflowStepResult } from "../workflows/workflow-step-results.js";
import type { WorkflowStepResult } from "../types.js";

const MINUTE = 60_000;
const T0 = "2026-10-08T10:00:00.000Z";
const at = (offsetMs: number) => new Date(Date.parse(T0) + offsetMs).toISOString();

describe("post-merge evidence wait helpers", () => {
  it("backs off 5, 10, 20, then every 30 minutes", () => {
    expect([1, 2, 3, 4, 5, 12].map(postMergeEvidenceWaitBackoffMs)).toEqual([5, 10, 20, 30, 30, 30].map((m) => m * MINUTE));
  });

  it("starts a new window when there is no prior row", () => {
    expect(nextPostMergeEvidenceWait(undefined, { state: "run-queued", runId: "37759591738" }, T0)).toEqual({
      evidenceWait: { state: "run-queued", runId: "37759591738", firstObservedAt: T0, checkCount: 1 },
      exhausted: false,
    });
  });

  it("carries the window forward from an immediately prior awaiting-evidence row", () => {
    const prior = { status: "awaiting-evidence" as const, evidenceWait: { state: "run-not-started" as const, firstObservedAt: T0, checkCount: 2 } };
    expect(nextPostMergeEvidenceWait(prior, { state: "run-in-progress" }, at(30 * MINUTE))).toEqual({
      evidenceWait: { state: "run-in-progress", firstObservedAt: T0, checkCount: 3 },
      exhausted: false,
    });
  });

  it("starts a new window after a prior failed or REVISE row", () => {
    const prior = { status: "failed" as const, evidenceWait: { state: "run-queued" as const, firstObservedAt: T0, checkCount: 9, exhaustedAt: at(8 * 60 * MINUTE) } };
    const now = at(10 * 60 * MINUTE);
    expect(nextPostMergeEvidenceWait(prior, { state: "run-queued" }, now)).toEqual({
      evidenceWait: { state: "run-queued", firstObservedAt: now, checkCount: 1 },
      exhausted: false,
    });
  });

  it("is exhausted exactly at the 8-hour ceiling and not one millisecond before", () => {
    const prior = { status: "awaiting-evidence" as const, evidenceWait: { state: "run-queued" as const, firstObservedAt: T0, checkCount: 17 } };
    expect(nextPostMergeEvidenceWait(prior, { state: "run-queued" }, at(POST_MERGE_EVIDENCE_WAIT_CEILING_MS)).exhausted).toBe(true);
    expect(nextPostMergeEvidenceWait(prior, { state: "run-queued" }, at(POST_MERGE_EVIDENCE_WAIT_CEILING_MS - 1)).exhausted).toBe(false);
  });

  it("normalizes an invalid state and drops an unsafe or over-long run id", () => {
    expect(normalizePostMergeEvidencePending({ state: "maybe", runId: "x".repeat(200) })).toEqual({ state: "unspecified" });
    expect(normalizePostMergeEvidencePending({ state: "run-queued", runId: "../etc" })).toEqual({ state: "run-queued" });
    expect(normalizePostMergeEvidencePending(undefined)).toEqual({ state: "unspecified" });
    expect(normalizePostMergeEvidencePending({ state: "artifacts-pending", runId: "37763174330" })).toEqual({ state: "artifacts-pending", runId: "37763174330" });
  });

  it("is due only after the backoff for its check count elapses", () => {
    const row = { status: "awaiting-evidence" as const, completedAt: T0, evidenceWait: { state: "run-queued" as const, firstObservedAt: T0, checkCount: 1 } };
    expect(isPostMergeEvidenceWaitRecheckDue(row, Date.parse(at(5 * MINUTE - 1)))).toBe(false);
    expect(isPostMergeEvidenceWaitRecheckDue(row, Date.parse(at(5 * MINUTE)))).toBe(true);
    expect(isPostMergeEvidenceWaitRecheckDue({ ...row, evidenceWait: { ...row.evidenceWait, checkCount: 4 } }, Date.parse(at(29 * MINUTE)))).toBe(false);
    expect(isPostMergeEvidenceWaitRecheckDue({ ...row, completedAt: undefined }, Date.parse(at(60 * MINUTE)))).toBe(false);
    expect(isPostMergeEvidenceWaitRecheckDue({ ...row, status: "failed" }, Date.parse(at(60 * MINUTE)))).toBe(false);
  });

  it("is a terminal status and survives in history when the next attempt replaces it", () => {
    const awaiting: WorkflowStepResult = {
      workflowStepId: "post-merge-verification", workflowStepName: "Post-merge verification", status: "awaiting-evidence",
      startedAt: T0, completedAt: at(MINUTE), evidenceWait: { state: "run-queued", firstObservedAt: T0, checkCount: 1 },
    };
    expect(isTerminalStepResult(awaiting)).toBe(true);
    const next = upsertWorkflowStepResult([awaiting], { ...awaiting, status: "pending", startedAt: at(6 * MINUTE), completedAt: undefined, evidenceWait: undefined });
    expect(next[0].priorAttempts).toEqual([awaiting]);
  });
});
