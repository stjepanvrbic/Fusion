import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  PLAN_LOCK_UNAVAILABLE_DIAGNOSTIC: "Plan approved but spec lock unavailable:",
  computeWorkflowIrPin: vi.fn(() => ({ irHash: "ir-hash" })),
  evaluatePreMergeApprovals: vi.fn(),
  resolveWorkflowIrForTask: vi.fn(),
}));
vi.mock("@fusion/core", () => core);

// The core module is mocked above, so the operator retry write and the result recorder are taken from their source files.
import { buildManualRetryResetPatch, buildManualRetryResetPatchIfCurrent } from "../../../core/src/tasks/manual-retry-reset.js";
import { upsertWorkflowStepResult } from "../../../core/src/workflows/workflow-step-results.js";
import {
  hasExhaustedNoVerdictRecovery,
  hasExhaustedPlanReviewNoVerdictRecovery,
  isFailedNoVerdictPreMergeReviewResult,
  NO_VERDICT_RECOVERY_RETRY_LIMIT,
  rerouteFailedNoVerdictPreMergeGateToReview,
  rerouteUnrunPreMergeGateToReview,
} from "../merge/pre-merge-gate-reseed.js";

const singular = { kind: "singular", diff: { state: "fingerprint", fingerprint: "current" } } as any;
const subject = (overrides: Record<string, unknown> = {}) => ({
  id: "FN-9243",
  column: "in-review",
  autoMerge: true,
  workflowStepResults: [{ workflowStepId: "plan-review", status: "passed", reviewKind: "plan" }],
  ...overrides,
}) as any;

function store(seeded = true) {
  return {
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
    seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(async () => ({ seeded })),
    moveTask: vi.fn(),
  } as any;
}

const required = new Set(["security-review", "code-review"]);

beforeEach(() => {
  core.evaluatePreMergeApprovals.mockReturnValue([
    { workflowStepId: "security-review", state: "missing" },
    { workflowStepId: "code-review", state: "missing" },
  ]);
  core.resolveWorkflowIrForTask.mockResolvedValue({
    name: "Review",
    nodes: [
      { id: "security-review", kind: "optional-group", column: "in-progress", config: {} },
      { id: "code-review", kind: "step-review", column: "in-review", config: {} },
    ],
  });
});

describe("unrun pre-merge gate reseed", () => {
  it.each(["output", "notes"])("does not redispatch deterministic plan-lock failures carried in %s", async (field) => {
    const fake = store();
    const task = subject({ workflowStepResults: [{
      workflowStepId: "security-review", reviewKind: "plan", status: "failed",
      [field]: "Plan approved but spec lock unavailable: mission-missing (mission).",
    }] });
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await rerouteFailedNoVerdictPreMergeGateToReview(fake, task, {
        requiredPreMergeStepIds: required, mergeContent: singular,
      })).rerouted).toBe(false);
    }
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  it.each([rerouteUnrunPreMergeGateToReview, rerouteFailedNoVerdictPreMergeGateToReview])("never seeds pre-merge work after landing", async (reroute) => {
    const fake = store();
    const task = subject({ mergeDetails: { mergeConfirmed: true }, workflowStepResults: [{ workflowStepId: "code-review", status: "failed" }] });
    expect((await reroute(fake, task, { requiredPreMergeStepIds: required, mergeContent: singular })).rerouted).toBe(false);
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  it("bounds consecutive failed no-verdict attempts without discarding evidence", async () => {
    const fake = store();
    const failure = { workflowStepId: "code-review", phase: "pre-merge", status: "failed" };
    const task = subject({ workflowStepResults: [{ ...failure, priorAttempts: [failure, failure, failure] }] });
    const before = structuredClone(task);
    expect((await rerouteFailedNoVerdictPreMergeGateToReview(fake, task, { requiredPreMergeStepIds: required, mergeContent: singular })).rerouted).toBe(false);
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
    expect(task).toEqual(before);
  });

  it("allows recovery for new review input despite old failure history", async () => {
    const fake = store();
    const failure = { workflowStepId: "code-review", status: "failed", reviewInputFingerprint: "old" };
    const task = subject({ workflowStepResults: [{ ...failure, reviewInputFingerprint: "new", priorAttempts: [failure, failure, failure] }] });
    expect((await rerouteFailedNoVerdictPreMergeGateToReview(fake, task, { requiredPreMergeStepIds: required, mergeContent: singular })).rerouted).toBe(true);
  });

  it("seeds the earliest missing gate without mutating review evidence or moving the card", async () => {
    const task = subject();
    const before = structuredClone(task);
    const fake = store();

    await expect(rerouteUnrunPreMergeGateToReview(fake, task, { requiredPreMergeStepIds: required, mergeContent: singular }))
      .resolves.toMatchObject({ rerouted: true, reason: "seeded", nodeId: "security-review", workflowStepId: "security-review" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "FN-9243", nodeId: "security-review", state: "runnable", sourceColumn: "in-review", targetColumn: "in-progress",
    }));
    expect(fake.moveTask).not.toHaveBeenCalled();
    expect(task).toEqual(before);
  });

  it.each([
    ["undefined results", subject({ workflowStepResults: undefined }), required, singular, "seeded"],
    ["empty results", subject({ workflowStepResults: [] }), required, singular, "seeded"],
    ["all reported", subject(), required, singular, "no-unrun-gate"],
    ["no enabled gates", subject(), new Set<string>(), singular, "no-unrun-gate"],
    ["workspace content", subject(), required, { kind: "workspace" }, "not-singular"],
    ["workspace task", subject({ workspaceWorktrees: {} }), required, singular, "not-singular"],
    ["operator hold", subject({ paused: true }), required, singular, "operator-held"],
  ] as const)("declines %s without writes", async (_label, task, requiredIds, content, reason) => {
    if (reason === "no-unrun-gate" && requiredIds.size > 0) core.evaluatePreMergeApprovals.mockReturnValueOnce([
      { workflowStepId: "security-review", state: "approved" },
      { workflowStepId: "code-review", state: "approved" },
    ]);
    const before = structuredClone(task);
    const fake = store();
    const result = await rerouteUnrunPreMergeGateToReview(fake, task, { requiredPreMergeStepIds: requiredIds, mergeContent: content as any });
    expect(result.reason).toBe(reason);
    expect(fake.moveTask).not.toHaveBeenCalled();
    expect(task).toEqual(before);
  });

  it("preserves last-result semantics and marks a raced seed as an active continuation", async () => {
    core.evaluatePreMergeApprovals.mockReturnValueOnce([
      { workflowStepId: "security-review", state: "approved" },
      { workflowStepId: "code-review", state: "missing" },
    ]);
    const task = subject({ workflowStepResults: [{ workflowStepId: "security-review", status: "failed" }, { workflowStepId: "security-review", status: "passed", verdict: "APPROVE" }] });
    const before = structuredClone(task);
    const fake = store(false);
    await expect(rerouteUnrunPreMergeGateToReview(fake, task, { requiredPreMergeStepIds: required, mergeContent: singular }))
      .resolves.toMatchObject({ rerouted: false, reason: "active-continuation", nodeId: "code-review" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledTimes(1);
    expect(fake.moveTask).not.toHaveBeenCalled();
    expect(task).toEqual(before);
  });

  it("declines a missing gate absent from the workflow route", async () => {
    core.resolveWorkflowIrForTask.mockResolvedValueOnce({ name: "Review", nodes: [] });
    const fake = store();
    await expect(rerouteUnrunPreMergeGateToReview(fake, subject(), { requiredPreMergeStepIds: required, mergeContent: singular }))
      .resolves.toMatchObject({ rerouted: false, reason: "no-review-route" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  it("re-seeds exactly a failed no-verdict code review while retaining its finding evidence", async () => {
    const task = subject({
      steps: [{ name: "Documentation & Delivery", status: "done" }],
      workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "pre-merge",
        status: "failed",
        findings: [{ id: "fn-9372-unfixed-pipeline-smoke", severity: "critical" }],
      }],
    });
    const before = structuredClone(task);
    const fake = store();

    await expect(rerouteFailedNoVerdictPreMergeGateToReview(fake, task, {
      requiredPreMergeStepIds: required,
      mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: true, reason: "seeded", nodeId: "code-review" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledWith(expect.objectContaining({
      taskId: task.id,
      nodeId: "code-review",
      runId: expect.stringContaining("failed-no-verdict-pre-merge-gate-reseed"),
    }));
    expect(task).toEqual(before);
    expect(task.steps).toHaveLength(1);
    expect(task.steps[0]).toMatchObject({ status: "done" });
  });

  it.each([
    ["a real REVISE", { status: "failed", verdict: "REVISE" }],
    ["a pending result", { status: "pending" }],
    ["a bypassed result", { status: "skipped", bypassedBy: "operator" }],
    ["a post-merge result", { status: "failed", phase: "post-merge" }],
  ])("does not re-run %s", async (_label, result) => {
    const fake = store();
    const task = subject({ workflowStepResults: [{ workflowStepId: "code-review", phase: "pre-merge", ...result }] });
    await expect(rerouteFailedNoVerdictPreMergeGateToReview(fake, task, {
      requiredPreMergeStepIds: required,
      mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: false, reason: "no-failed-no-verdict-gate" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  it("refuses duplicate dispatch, manual hold, selection change, and non-singular content", async () => {
    const retryTask = subject({ workflowStepResults: [{ workflowStepId: "code-review", phase: "pre-merge", status: "failed" }] });
    const duplicate = store(false);
    await expect(rerouteFailedNoVerdictPreMergeGateToReview(duplicate, retryTask, {
      requiredPreMergeStepIds: required,
      mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: false, reason: "active-continuation", nodeId: "code-review" });

    for (const [task, content, expected] of [
      [subject({ paused: true, workflowStepResults: retryTask.workflowStepResults }), singular, "operator-held"],
      [retryTask, { kind: "workspace" }, "not-singular"],
    ] as const) {
      const fake = store();
      await expect(rerouteFailedNoVerdictPreMergeGateToReview(fake, task, {
        requiredPreMergeStepIds: required,
        mergeContent: content as any,
      })).resolves.toMatchObject({ rerouted: false, reason: expected });
      expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
    }

    const changed = store(false);
    changed.seedWorkspaceCodeReviewContinuationIfIdle.mockResolvedValueOnce({ seeded: false, reason: "workflow-selection-changed" });
    await expect(rerouteFailedNoVerdictPreMergeGateToReview(changed, retryTask, {
      requiredPreMergeStepIds: required,
      mergeContent: singular,
      expectedWorkflowSelection: { workflowId: "builtin:coding", stepIds: ["code-review"] },
    })).resolves.toMatchObject({ rerouted: false, reason: "workflow-selection-changed" });
  });
});

describe("hold-lane Plan Review no-verdict budget", () => {
  const lockText = "Plan approved but spec lock unavailable: mission-missing (mission).";
  const rateLimit = { origin: "model-provider", code: "RATE_LIMIT" };
  const failure = (overrides: Record<string, unknown> = {}) => ({
    workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "failed", reviewInputFingerprint: "A", ...overrides,
  }) as any;
  const latest = (priors: unknown[], overrides: Record<string, unknown> = {}) => failure({ priorAttempts: priors, ...overrides });
  const priors = (count: number, overrides: Record<string, unknown> = {}) =>
    Array.from({ length: count }, (_unused, index) => failure({ startedAt: `2026-10-10T10:0${index}:00.000Z`, ...overrides }));

  it("allows three retries per unchanged plan", () => {
    expect(NO_VERDICT_RECOVERY_RETRY_LIMIT).toBe(3);
  });

  it.each([
    ["three matching priors", latest(priors(3)), "A", true],
    ["two matching priors", latest(priors(2)), "A", false],
    ["four matching priors", latest(priors(4)), "A", true],
    ["no prior attempts", failure(), "A", false],
    ["a plan changed after the last failure", latest(priors(3)), "B", false],
    ["priors recorded for another plan", latest(priors(3, { reviewInputFingerprint: "B" })), "A", false],
    ["priors without a recorded plan", latest(priors(3, { reviewInputFingerprint: undefined })), "A", false],
    ["a latest row without a recorded plan", latest(priors(3), { reviewInputFingerprint: undefined }), "A", false],
    ["an undefined current plan", latest(priors(3)), undefined, false],
    ["an empty current plan", latest(priors(3)), "", false],
    ["an undefined result", undefined, "A", false],
    ["one rate-limited prior among three", latest([...priors(2), failure({ providerFailure: rateLimit })]), "A", false],
    ["a rate-limited latest row with three genuine priors", latest(priors(3), { providerFailure: rateLimit }), "A", false],
    ["one lock-unavailable prior among three (output)", latest([...priors(2), failure({ output: lockText })]), "A", false],
    ["one lock-unavailable prior among three (notes)", latest([...priors(2), failure({ notes: lockText })]), "A", false],
    ["a lock-unavailable latest row", latest(priors(3), { output: lockText, notes: lockText }), "A", false],
    ["one superseded prior among three", latest([...priors(2), failure({ supersededAt: "2026-10-10T11:00:00.000Z" })]), "A", false],
    ["one remediation-archived prior among three", latest([...priors(2), failure({ remediationArchivedAt: "2026-10-10T11:00:00.000Z" })]), "A", false],
    ["one REVISE prior among three", latest([...priors(2), failure({ verdict: "REVISE" })]), "A", false],
    ["three genuine priors mixed with excluded ones", latest([
      failure({ providerFailure: rateLimit }), ...priors(2), failure({ output: lockText }), failure({ verdict: "REVISE" }), ...priors(1),
    ]), "A", true],
    ["a superseded latest row", latest(priors(3), { supersededAt: "2026-10-10T11:00:00.000Z" }), "A", false],
    ["a latest REVISE", latest(priors(3), { verdict: "REVISE" }), "A", false],
    ["a latest pending lease", latest(priors(3), { status: "pending" }), "A", false],
    ["a latest passed row", latest(priors(3), { status: "passed", verdict: "APPROVE" }), "A", false],
  ])("%s", (_label, result, currentPlanFingerprint, expected) => {
    expect(hasExhaustedPlanReviewNoVerdictRecovery(result, currentPlanFingerprint)).toBe(expected);
  });

  it("ignores the reviewed commit, which can move while the plan is unchanged", () => {
    const moved = priors(3).map((entry, index) => ({ ...entry, reviewedCommitSha: `sha-${index}` }));
    expect(hasExhaustedPlanReviewNoVerdictRecovery(latest(moved, { reviewedCommitSha: "sha-latest" }), "A")).toBe(true);
  });

  it("leaves the review-lane budget keyed on the recorded input and the reviewed commit", () => {
    const reviewFailure = { workflowStepId: "code-review", status: "failed" } as any;
    expect(hasExhaustedNoVerdictRecovery({ ...reviewFailure, priorAttempts: [reviewFailure, reviewFailure, reviewFailure] })).toBe(true);
    expect(hasExhaustedNoVerdictRecovery({ ...reviewFailure, priorAttempts: [reviewFailure, reviewFailure] })).toBe(false);
    expect(hasExhaustedNoVerdictRecovery({
      ...reviewFailure, reviewInputFingerprint: "new",
      priorAttempts: [1, 2, 3].map(() => ({ ...reviewFailure, reviewInputFingerprint: "old" })),
    })).toBe(false);
    expect(hasExhaustedNoVerdictRecovery({
      ...reviewFailure, reviewedCommitSha: "new",
      priorAttempts: [1, 2, 3].map(() => ({ ...reviewFailure, reviewedCommitSha: "old" })),
    })).toBe(false);
    // The review lane counts a lock-unavailable prior and a verdict-less row with no recorded input.
    expect(hasExhaustedNoVerdictRecovery({
      ...reviewFailure, priorAttempts: [reviewFailure, reviewFailure, { ...reviewFailure, output: lockText }],
    })).toBe(true);
    expect(hasExhaustedNoVerdictRecovery({
      ...reviewFailure, priorAttempts: [reviewFailure, reviewFailure, { ...reviewFailure, providerFailure: rateLimit }],
    })).toBe(false);
    expect(hasExhaustedNoVerdictRecovery({ ...reviewFailure, verdict: "REVISE", priorAttempts: [reviewFailure, reviewFailure, reviewFailure] })).toBe(false);
  });
});

describe("operator re-arm of the no-verdict budget", () => {
  const REARMED_AT = "2026-10-12T04:00:00.000Z";
  const lockText = "Plan approved but spec lock unavailable: mission-missing (mission).";
  const rateLimit = { origin: "model-provider", code: "RATE_LIMIT" };
  const lanes = [
    ["review lane", { workflowStepId: "code-review", status: "failed", reviewInputFingerprint: "diff", reviewedCommitSha: "sha" },
      (result: any) => hasExhaustedNoVerdictRecovery(result)],
    ["hold lane", { workflowStepId: "plan-review", status: "failed", reviewInputFingerprint: "plan" },
      (result: any) => hasExhaustedPlanReviewNoVerdictRecovery(result, "plan")],
  ] as const;

  describe.each(lanes)("%s", (_lane, failure, exhausted) => {
    const failures = (count: number) => Array.from({ length: count }, () => ({ ...failure }));
    const marked = { ...failure, noVerdictBudgetRearmedAt: REARMED_AT };

    it("reports exhaustion for unmarked history exactly as before", () => {
      expect(exhausted({ ...failure, priorAttempts: failures(3) })).toBe(true);
      expect(exhausted({ ...failure, priorAttempts: failures(2) })).toBe(false);
    });

    it("does not report exhaustion when the latest row is marked", () => {
      expect(exhausted({ ...marked, priorAttempts: failures(3) })).toBe(false);
      expect(exhausted({ ...marked, priorAttempts: failures(5) })).toBe(false);
    });

    it.each([
      [0, false],
      [2, false],
      [3, true],
      [4, true],
    ])("counts %i failures recorded after the marked attempt (exhausted: %s)", (newer, expected) => {
      expect(exhausted({ ...failure, priorAttempts: [...failures(newer), marked] })).toBe(expected);
    });

    it("ignores unmarked failures older than the marked attempt", () => {
      expect(exhausted({ ...failure, priorAttempts: [...failures(1), marked, ...failures(3)] })).toBe(false);
      expect(exhausted({ ...failure, priorAttempts: [marked, ...failures(4)] })).toBe(false);
    });

    it("stops at the newest of several marked attempts", () => {
      const older = { ...failure, noVerdictBudgetRearmedAt: "2026-10-11T00:00:00.000Z" };
      expect(exhausted({ ...failure, priorAttempts: [...failures(2), marked, ...failures(1), older] })).toBe(false);
      expect(exhausted({ ...failure, priorAttempts: [...failures(3), marked, older] })).toBe(true);
    });

    it("counts the retained attempts when the marked attempt has left the history window", () => {
      expect(exhausted({ ...failure, priorAttempts: failures(5) })).toBe(true);
    });
  });

  it("keeps a marked rate-limited Plan Review out of the budget", () => {
    const failure = { workflowStepId: "plan-review", status: "failed", reviewInputFingerprint: "plan" } as any;
    const latest = { ...failure, providerFailure: rateLimit, noVerdictBudgetRearmedAt: REARMED_AT, priorAttempts: [failure, failure, failure] };
    expect(hasExhaustedPlanReviewNoVerdictRecovery(latest, "plan")).toBe(false);
    // A rate-limited attempt recorded after the marked one still spends nothing.
    expect(hasExhaustedPlanReviewNoVerdictRecovery({
      ...failure,
      priorAttempts: [failure, failure, { ...failure, providerFailure: rateLimit }, { ...failure, noVerdictBudgetRearmedAt: REARMED_AT }],
    }, "plan")).toBe(false);
  });

  it.each(["output", "notes"])("keeps a marked spec-lock failure (%s) out of the no-verdict reroute", async (field) => {
    const lockFailure = {
      workflowStepId: "security-review", reviewKind: "plan", status: "failed", noVerdictBudgetRearmedAt: REARMED_AT,
      [field]: lockText,
    } as any;
    expect(isFailedNoVerdictPreMergeReviewResult(lockFailure, required)).toBe(false);
    expect(hasExhaustedPlanReviewNoVerdictRecovery({ ...lockFailure, reviewInputFingerprint: "plan" }, "plan")).toBe(false);

    const fake = store();
    await expect(rerouteFailedNoVerdictPreMergeGateToReview(fake, subject({ workflowStepResults: [lockFailure] }), {
      requiredPreMergeStepIds: required, mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: false, reason: "no-failed-no-verdict-gate" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  it("lets an operator retry re-seed a review-lane card stopped by the limit, then stops it again after three more failures", async () => {
    const attempt = (sequence: number) => ({
      workflowStepId: "code-review", workflowStepName: "Code Review", phase: "pre-merge", status: "failed",
      startedAt: `2026-10-12T0${sequence}:00:00.000Z`, output: `reviewer session ended (attempt ${sequence})`,
      reviewInputFingerprint: "diff", reviewedCommitSha: "sha",
      findings: [{ id: "finding-1", title: "Missing guard", body: "Validate the input." }],
    }) as any;
    const parked = subject({
      status: "failed",
      error: "Review recovery stopped at 'code-review': reviewer session ended (attempt 4) Correct the review input or provider failure before retrying.",
      steps: [{ name: "Implement", status: "done" }],
      workflowStepResults: [{ ...attempt(4), priorAttempts: [attempt(3), attempt(2), attempt(1)] }],
    });
    const options = { requiredPreMergeStepIds: required, mergeContent: singular };
    const beforeRetry = store();
    await expect(rerouteFailedNoVerdictPreMergeGateToReview(beforeRetry, parked, options))
      .resolves.toMatchObject({ rerouted: false, reason: "no-failed-no-verdict-gate" });
    expect(beforeRetry.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();

    // The write every operator retry surface applies to the live row.
    const exhaustedRow = parked.workflowStepResults[0];
    Object.assign(parked, buildManualRetryResetPatchIfCurrent(parked, { ...parked }, {
      status: null, error: null, ...buildManualRetryResetPatch({ resetMergeRetries: true }),
    }));

    expect(parked.workflowStepResults).toEqual([{ ...exhaustedRow, noVerdictBudgetRearmedAt: expect.any(String) }]);
    const afterRetry = store();
    await expect(rerouteFailedNoVerdictPreMergeGateToReview(afterRetry, parked, options))
      .resolves.toMatchObject({ rerouted: true, reason: "seeded", nodeId: "code-review", workflowStepId: "code-review" });
    expect(afterRetry.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledWith(expect.objectContaining({
      taskId: parked.id, nodeId: "code-review", runId: expect.stringContaining("failed-no-verdict-pre-merge-gate-reseed"),
    }));
    expect(afterRetry.moveTask).not.toHaveBeenCalled();
    expect(parked.workflowStepResults[0].findings).toEqual(exhaustedRow.findings);
    expect(parked.workflowStepResults[0].priorAttempts).toEqual(exhaustedRow.priorAttempts);

    // The re-seeded review and each automatic retry die without a verdict on the same input.
    const candidateAfterFailure: boolean[] = [];
    for (const sequence of [5, 6, 7, 8]) {
      parked.workflowStepResults = upsertWorkflowStepResult(parked.workflowStepResults, attempt(sequence));
      candidateAfterFailure.push(isFailedNoVerdictPreMergeReviewResult(parked.workflowStepResults[0], required));
    }
    expect(candidateAfterFailure).toEqual([true, true, true, false]);
    expect(hasExhaustedNoVerdictRecovery(parked.workflowStepResults[0])).toBe(true);
    const afterSecondExhaustion = store();
    await expect(rerouteFailedNoVerdictPreMergeGateToReview(afterSecondExhaustion, parked, options))
      .resolves.toMatchObject({ rerouted: false, reason: "no-failed-no-verdict-gate" });
    // The re-armed attempt and the attempts before it are still on the card (history holds five).
    expect(parked.workflowStepResults[0].priorAttempts.map((entry: any) => entry.output)).toEqual([
      "reviewer session ended (attempt 7)", "reviewer session ended (attempt 6)", "reviewer session ended (attempt 5)",
      "reviewer session ended (attempt 4)", "reviewer session ended (attempt 3)",
    ]);
    expect(parked.workflowStepResults[0].priorAttempts[3].noVerdictBudgetRearmedAt).toEqual(expect.any(String));
  });

  it("makes a marked exhausted review failure a reroute candidate again", () => {
    const failure = { workflowStepId: "code-review", status: "failed" } as any;
    expect(isFailedNoVerdictPreMergeReviewResult({ ...failure, priorAttempts: [failure, failure, failure] }, required)).toBe(false);
    expect(isFailedNoVerdictPreMergeReviewResult({
      ...failure, noVerdictBudgetRearmedAt: REARMED_AT, priorAttempts: [failure, failure, failure],
    }, required)).toBe(true);
  });
});
