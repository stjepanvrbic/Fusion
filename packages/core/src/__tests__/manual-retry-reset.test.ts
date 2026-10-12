import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
  MANUAL_RETRY_RESET_COUNTER_KEYS,
  buildAutoPauseClearPatch,
  buildManualRetryResetPatch,
  buildManualRetryResetPatchIfCurrent,
  buildNoVerdictBudgetRearmPatch,
} from "../tasks/manual-retry-reset.js";
import type { Task, WorkflowStepResult } from "../types.js";

const RETRY_SUMMARY_COUNTER_REGEX = /toCount\(task\.(\w+)\)/g;

describe("buildAutoPauseClearPatch", () => {
  it("clears the deadlock auto-pause for auto-paused tasks", () => {
    expect(buildAutoPauseClearPatch({
      paused: true,
      userPaused: undefined,
      pausedReason: IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
    })).toEqual({
      paused: false,
      pausedReason: null,
    });
  });

  it("does not clear an explicit user pause", () => {
    expect(buildAutoPauseClearPatch({
      paused: true,
      userPaused: true,
      pausedReason: IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
    })).toEqual({});
  });

  it("clears the branch-conflict auto-pause for a fresh retry", () => {
    expect(buildAutoPauseClearPatch({
      paused: true,
      userPaused: undefined,
      pausedReason: "branch-conflict-unrecoverable",
    })).toEqual({
      paused: false,
      pausedReason: null,
    });
  });

  it("does not clear an unrelated automatic pause reason", () => {
    expect(buildAutoPauseClearPatch({
      paused: true,
      userPaused: undefined,
      pausedReason: "token_budget_exceeded",
    })).toEqual({});
  });

  it("is a no-op when the task is not paused", () => {
    expect(buildAutoPauseClearPatch({
      paused: undefined,
      userPaused: undefined,
      pausedReason: IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
    })).toEqual({});
  });
});

describe("buildManualRetryResetPatchIfCurrent", () => {
  const expected = {
    branch: "fusion/fn-9434",
    worktree: "/tmp/fn-9434",
    status: "failed",
    error: "branch conflict",
    paused: true,
    pausedReason: "branch-conflict-unrecoverable",
  } as never;

  it("refuses a stale retry after a scheduler replaces the checkout", () => {
    expect(buildManualRetryResetPatchIfCurrent({
      ...expected,
      worktree: "/tmp/fn-9434-replacement",
    }, expected, { status: null })).toBeNull();
  });

  it("clears only the current branch-conflict automatic pause", () => {
    expect(buildManualRetryResetPatchIfCurrent(expected, expected, { status: null })).toMatchObject({
      status: null,
      paused: false,
      pausedReason: null,
    });
  });

  describe("no-verdict review budget re-arm", () => {
    const priorAttempts: WorkflowStepResult[] = [3, 2, 1].map((attempt) => ({
      workflowStepId: "plan-review",
      workflowStepName: "Plan Review",
      status: "failed",
      startedAt: `T${attempt}`,
      reviewInputFingerprint: "plan",
    }));
    const lostReview: WorkflowStepResult = {
      workflowStepId: "plan-review",
      workflowStepName: "Plan Review",
      status: "failed",
      startedAt: "T4",
      reviewInputFingerprint: "plan",
      priorAttempts,
    };
    const approved: WorkflowStepResult = {
      workflowStepId: "code-review",
      workflowStepName: "Code Review",
      status: "passed",
      verdict: "APPROVE",
    };
    const parked = { ...(expected as Task), paused: undefined, pausedReason: undefined } as Task;

    it("marks a failed verdict-less review row on the live task and keeps every row and prior attempt", () => {
      const live = { ...parked, workflowStepResults: [lostReview, approved] } as Task;

      const patch = buildManualRetryResetPatchIfCurrent(live, parked, { status: null, error: null });

      expect(patch).toMatchObject({ status: null, error: null });
      const [rearmed, untouched] = patch!.workflowStepResults!;
      expect(typeof rearmed.noVerdictBudgetRearmedAt).toBe("string");
      expect(Number.isNaN(Date.parse(rearmed.noVerdictBudgetRearmedAt!))).toBe(false);
      expect(rearmed).toEqual({ ...lostReview, noVerdictBudgetRearmedAt: rearmed.noVerdictBudgetRearmedAt });
      expect(rearmed.priorAttempts).toBe(priorAttempts);
      expect(untouched).toBe(approved);
      expect(patch!.workflowStepResults).toHaveLength(2);
    });

    it.each([
      ["no step results", undefined],
      ["an empty result list", []],
      ["only an approved review", [approved]],
    ])("writes no step results for a live task with %s", (_label, workflowStepResults) => {
      const live = { ...parked, workflowStepResults } as Task;
      expect(buildManualRetryResetPatchIfCurrent(live, parked, { status: null })).not.toHaveProperty("workflowStepResults");
      expect(buildNoVerdictBudgetRearmPatch(live)).toEqual({});
    });

    it("still refuses a newer lifecycle before re-arming", () => {
      const live = { ...parked, workflowStepResults: [lostReview] } as Task;
      expect(buildManualRetryResetPatchIfCurrent({ ...live, branch: "fusion/replacement" }, parked, { status: null })).toBeNull();
      expect(buildManualRetryResetPatchIfCurrent({ ...live, userPaused: true }, parked, { status: null })).toBeNull();
    });

    it("lets an explicit caller step-result patch win over the re-arm", () => {
      const live = { ...parked, workflowStepResults: [lostReview] } as Task;
      const explicit: WorkflowStepResult[] = [];
      expect(buildManualRetryResetPatchIfCurrent(live, parked, { workflowStepResults: explicit })!.workflowStepResults).toBe(explicit);
    });

    it("uses the supplied re-arm time", () => {
      const patch = buildNoVerdictBudgetRearmPatch({ workflowStepResults: [lostReview] }, "2026-10-12T04:00:00.000Z");
      expect(patch.workflowStepResults?.[0].noVerdictBudgetRearmedAt).toBe("2026-10-12T04:00:00.000Z");
    });
  });
});

describe("buildManualRetryResetPatch", () => {
  it("resets all manual retry counters to zero", () => {
    const patch = buildManualRetryResetPatch();

    for (const key of MANUAL_RETRY_RESET_COUNTER_KEYS) {
      expect(patch[key]).toBe(0);
    }
    expect(patch.graphResumeRetryCount).toBe(0);
    expect(patch.consecutiveToolFailureRetryCount).toBe(0);
    expect(patch.toolFailureDetectorLogCursor).toBeNull();
    expect(patch.toolFailureRetryExhaustedAuditEmitted).toBe(false);
  });

  it("includes all retry-summary counters in the reset key list", () => {
    const retrySummarySource = readFileSync(new URL("../tasks/retry-summary.ts", import.meta.url), "utf-8");
    const retrySummaryKeys = new Set<string>();
    let match: RegExpExecArray | null = RETRY_SUMMARY_COUNTER_REGEX.exec(retrySummarySource);
    while (match) {
      retrySummaryKeys.add(match[1]);
      match = RETRY_SUMMARY_COUNTER_REGEX.exec(retrySummarySource);
    }

    for (const key of retrySummaryKeys) {
      expect(MANUAL_RETRY_RESET_COUNTER_KEYS).toContain(key);
    }
  });

  it("sets mergeRetries only when requested", () => {
    expect(buildManualRetryResetPatch()).not.toHaveProperty("mergeRetries");
    expect(buildManualRetryResetPatch({ resetMergeRetries: true })).toMatchObject({ mergeRetries: 0 });
  });

  it("clears nextRecoveryAt", () => {
    expect(buildManualRetryResetPatch()).toMatchObject({ nextRecoveryAt: null });
  });

  // FNXC:Lifecycle 2026-07-16-21:40: FN-8141 — an operator manual retry is an honest exit
  // that clears the skip-bypass taint marker so the retried task can promote on its skips.
  it("clears the FN-8141 skip-bypass taint marker (bulkCompletionRefusalAt)", () => {
    expect(buildManualRetryResetPatch()).toMatchObject({ bulkCompletionRefusalAt: null });
  });
});
