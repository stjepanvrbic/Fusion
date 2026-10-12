import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { computePlanApprovalFingerprint, getTaskMergeBlocker, UnavailablePlanLockError, type Task, type WorkflowStepResult } from "@fusion/core";
import {
  attemptStillPresent,
  discardWorkflowStepLease,
  persistWorkflowStepResult,
  persistWorkflowStepResultWithOutcome,
} from "../executor/execute-workflow-graph.js";
import { __setResetPublicationFailureForTesting } from "../../../core/src/task-store/reset-lifecycle.js";
import { hasExhaustedPlanReviewNoVerdictRecovery, rerouteFailedNoVerdictPreMergeGateToReview } from "../merge/pre-merge-gate-reseed.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";

const pending = (workflowStepId: string, startedAt: string): WorkflowStepResult => ({
  workflowStepId,
  workflowStepName: workflowStepId,
  phase: "pre-merge",
  source: "optional-group",
  status: "pending",
  startedAt,
});

const terminal = (workflowStepId: string, startedAt: string): WorkflowStepResult => ({
  ...pending(workflowStepId, startedAt),
  status: "failed",
  completedAt: "2026-08-29T02:18:00.000Z",
});

function createStore(task: Task, tier: "core" | "atomic" | "direct" = "atomic") {
  const updateTask = vi.fn(async (_id: string, patch: Partial<Task>) => {
    Object.assign(task, patch);
    return task;
  });
  const updateTaskAtomic = vi.fn(async (_id: string, compute: (current: Task) => Partial<Task> | null) => {
    const patch = compute(task);
    if (patch) Object.assign(task, patch);
    return task;
  });
  const updateWorkflowStepResultsFenced = vi.fn(async (_id: string, compute: (current: Task) => Partial<Task> | null) => {
    const patch = compute(task);
    if (!patch) return { applied: false, reason: "refused" } as const;
    Object.assign(task, patch);
    return { applied: true, task } as const;
  });
  const store = {
    getTask: vi.fn(async () => task),
    updateTask,
    ...(tier === "direct" ? {} : { updateTaskAtomic }),
    ...(tier === "core" ? { updateWorkflowStepResultsFenced } : {}),
    isBackendMode: vi.fn(() => false),
    recordAgentActivity: vi.fn(async () => undefined),
  };
  return { store, updateTask, updateTaskAtomic, updateWorkflowStepResultsFenced };
}

function result(startedAt = "attempt-a"): WorkflowStepResult {
  return {
    ...terminal("code-review", startedAt),
    status: "passed",
  };
}

describe("persistWorkflowStepResult abort and reset fence", () => {
  it("uses startedAt as an exact attempt identity", () => {
    const results = [pending("code-review", "attempt-b")];
    expect(attemptStillPresent(results, "code-review", "attempt-a")).toBe(false);
    expect(attemptStillPresent(results, "code-review", "attempt-b")).toBe(true);
  });

  it("refuses an abort that fires after the caller entered the sink without activity emission", async () => {
    const controller = new AbortController();
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const task = { id: "FN-249", workflowStepResults: [pending("code-review", "attempt-a")] } as Task;
    const { store, updateTask } = createStore(task, "direct");
    store.getTask.mockImplementationOnce(async () => {
      await readGate;
      return task;
    });

    const persisted = persistWorkflowStepResult(
      { store, getRunContextFor: () => undefined, readTaskArtifact: async () => undefined } as never,
      task.id,
      result(),
      { signal: controller.signal, requireAttemptStartedAt: "attempt-a" },
    );
    controller.abort();
    releaseRead();

    await expect(persisted).resolves.toBe(true);
    expect(updateTask).not.toHaveBeenCalled();
    expect(store.recordAgentActivity).not.toHaveBeenCalled();
    expect(task.workflowStepResults).toEqual([pending("code-review", "attempt-a")]);
  });

  it("recomputes the default-branch patch from the latest matching attempt", async () => {
    const task = { id: "FN-249", workflowStepResults: [pending("code-review", "attempt-a")] } as Task;
    const { store, updateTask } = createStore(task, "direct");

    await expect(persistWorkflowStepResult(
      { store, getRunContextFor: () => undefined, readTaskArtifact: async () => undefined } as never,
      task.id,
      result(),
      { requireAttemptStartedAt: "attempt-a" },
    )).resolves.toBe(true);

    expect(updateTask).toHaveBeenCalledOnce();
    expect(task.workflowStepResults).toEqual([
      expect.objectContaining({ workflowStepId: "code-review", status: "passed", startedAt: "attempt-a" }),
    ]);
  });

  it("does not overwrite a later attempt and emits no terminal activity for the refusal", async () => {
    const task = { id: "FN-249", workflowStepResults: [pending("code-review", "attempt-b")] } as Task;
    const { store, updateTaskAtomic } = createStore(task, "atomic");

    await expect(persistWorkflowStepResult(
      { store, getRunContextFor: () => undefined, readTaskArtifact: async () => undefined } as never,
      task.id,
      result("attempt-a"),
      { requireAttemptStartedAt: "attempt-a" },
    )).resolves.toBe(true);

    expect(updateTaskAtomic).toHaveBeenCalledOnce();
    expect(task.workflowStepResults).toEqual([pending("code-review", "attempt-b")]);
    expect(store.recordAgentActivity).not.toHaveBeenCalled();
  });

  it("refuses unconfirmed-lease recovery when a later attempt owns the same workflow step", async () => {
    const task = { id: "FN-249", workflowStepResults: [pending("code-review", "attempt-b")] } as Task;
    const { store, updateTask } = createStore(task, "direct");

    await expect(persistWorkflowStepResultWithOutcome(
      { store, getRunContextFor: () => undefined, readTaskArtifact: async () => undefined } as never,
      task.id,
      result("attempt-a"),
      { requireAttemptStartedAtOrAbsent: "attempt-a" },
    )).resolves.toEqual({ scopeCurrent: true, persisted: false, disposition: "fence-refused" });

    expect(updateTask).not.toHaveBeenCalled();
    expect(task.workflowStepResults).toEqual([pending("code-review", "attempt-b")]);
    expect(store.recordAgentActivity).not.toHaveBeenCalled();
  });

  it("uses the core fenced tier before degraded writer tiers", async () => {
    const task = { id: "FN-249", workflowStepResults: [pending("code-review", "attempt-a")] } as Task;
    const { store, updateTask, updateTaskAtomic, updateWorkflowStepResultsFenced } = createStore(task, "core");

    await persistWorkflowStepResult(
      { store, getRunContextFor: () => undefined, readTaskArtifact: async () => undefined } as never,
      task.id,
      result(),
      { requireAttemptStartedAt: "attempt-a" },
    );

    expect(updateWorkflowStepResultsFenced).toHaveBeenCalledOnce();
    expect(updateTaskAtomic).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("refuses an accepted Plan Review when cancellation fires after its fresh read and plan lock", async () => {
    const controller = new AbortController();
    const task = { id: "FN-249", workflowStepResults: [pending("plan-review", "attempt-a")] } as Task;
    const updateTask = vi.fn(async (_id: string, patch: Partial<Task>) => {
      Object.assign(task, patch);
      return task;
    });
    const lockCurrentPlanWhilePlanningLocked = vi.fn(async () => {
      controller.abort();
    });
    const reconcileSpecDriftWhilePlanningLocked = vi.fn(async () => undefined);
    const store = {
      getTask: vi.fn(async () => task),
      updateTask,
      isBackendMode: vi.fn(() => true),
      withPlanningLifecycleLock: vi.fn(async (_id: string, callback: () => Promise<void>) => {
        await callback();
      }),
      lockCurrentPlanWhilePlanningLocked,
      reconcileSpecDriftWhilePlanningLocked,
      recordAgentActivity: vi.fn(async () => undefined),
    };

    await expect(persistWorkflowStepResult(
      { store, getRunContextFor: () => undefined, readTaskArtifact: async () => "# Plan\n" } as never,
      task.id,
      { ...result(), workflowStepId: "plan-review", workflowStepName: "Plan Review", verdict: "APPROVE" },
      { signal: controller.signal, requireAttemptStartedAt: "attempt-a" },
    )).resolves.toBe(true);

    expect(updateTask).not.toHaveBeenCalled();
    expect(lockCurrentPlanWhilePlanningLocked).toHaveBeenCalledOnce();
    expect(reconcileSpecDriftWhilePlanningLocked).not.toHaveBeenCalled();
    expect(store.recordAgentActivity).not.toHaveBeenCalled();
    expect(task.workflowStepResults).toEqual([pending("plan-review", "attempt-a")]);
  });

  it("persists a failed Plan Review when the spec lock is deterministically unavailable", async () => {
    const task = { id: "FN-249", workflowStepResults: [pending("plan-review", "attempt-a")] } as Task;
    const { store, updateTask } = createStore(task, "direct");
    const logEntry = vi.fn(async () => undefined);
    Object.assign(store, {
      isBackendMode: vi.fn(() => true),
      logEntry,
      withPlanningLifecycleLock: vi.fn(async (_id: string, callback: () => Promise<void>) => callback()),
      lockCurrentPlanWhilePlanningLocked: vi.fn(async () => {
        throw new UnavailablePlanLockError("section-duplicate", ["non-goals"], "source-hash");
      }),
      reconcileSpecDriftWhilePlanningLocked: vi.fn(async () => undefined),
    });

    await expect(persistWorkflowStepResultWithOutcome(
      { store, getRunContextFor: () => undefined, readTaskArtifact: async () => "# Plan\n" } as never,
      task.id,
      { ...result(), workflowStepId: "plan-review", workflowStepName: "Plan Review", verdict: "APPROVE" },
      { requireAttemptStartedAt: "attempt-a" },
    )).resolves.toMatchObject({
      scopeCurrent: true,
      persisted: true,
      disposition: "applied",
      persistedResult: expect.objectContaining({ status: "failed" }),
    });

    expect(updateTask).toHaveBeenCalledOnce();
    expect(task.approvedPlanFingerprint).toBeUndefined();
    expect(task.workflowStepResults).toEqual([expect.objectContaining({
      workflowStepId: "plan-review", status: "failed", verdict: undefined,
      output: expect.stringContaining("section-duplicate (non-goals)"),
    })]);
    // A spec-lock rejection is deterministic, not a lost dispatch, so it records no plan identity for the retry budget.
    expect(task.workflowStepResults?.[0]).not.toHaveProperty("reviewInputFingerprint");
    expect(logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("section-duplicate (non-goals)"), undefined, undefined);
    const seed = vi.fn();
    Object.assign(store, { seedWorkspaceCodeReviewContinuationIfIdle: seed });
    for (let poll = 0; poll < 5; poll++) {
      expect((await rerouteFailedNoVerdictPreMergeGateToReview(store as never, task, {
        requiredPreMergeStepIds: new Set(["plan-review"]),
        mergeContent: { kind: "singular", diff: { state: "fingerprint", fingerprint: "same" } } as never,
      })).rerouted).toBe(false);
    }
    expect(seed).not.toHaveBeenCalled();
    expect(getTaskMergeBlocker({
      ...task,
      column: "in-review",
      paused: false,
      status: null,
      steps: [],
    }, { requiredPreMergeStepIds: new Set(["plan-review"]) })).toBe(
      "task has enabled pre-merge workflow steps without a current approval (gate 'plan-review')",
    );
  });

  it("refuses an accepted Plan Review when Reset publishes between its fresh read and fenced write", async () => {
    const task = {
      id: "FN-249",
      workflowStepResults: [pending("plan-review", "attempt-a")],
      approvedPlanFingerprint: "old-plan-fingerprint",
      status: "failed",
    } as Task;
    const updateTask = vi.fn(async (_id: string, patch: Partial<Task>) => {
      Object.assign(task, patch);
      return task;
    });
    const lockCurrentPlanWhilePlanningLocked = vi.fn(async () => {
      Object.assign(task, {
        workflowStepResults: [],
        approvedPlanFingerprint: undefined,
        status: undefined,
      });
    });
    const updateWorkflowStepResultsFenced = vi.fn(async (_id: string, compute: (current: Task) => Partial<Task> | null) => {
      expect(compute(task)).toBeNull();
      return { applied: false, reason: "refused" } as const;
    });
    const reconcileSpecDriftWhilePlanningLocked = vi.fn(async () => undefined);
    const store = {
      getTask: vi.fn(async () => task),
      updateTask,
      updateWorkflowStepResultsFenced,
      isBackendMode: vi.fn(() => true),
      withPlanningLifecycleLock: vi.fn(async (_id: string, callback: () => Promise<void>) => {
        await callback();
      }),
      lockCurrentPlanWhilePlanningLocked,
      reconcileSpecDriftWhilePlanningLocked,
      recordAgentActivity: vi.fn(async () => undefined),
    };

    await expect(persistWorkflowStepResult(
      { store, getRunContextFor: () => undefined, readTaskArtifact: async () => "# Plan\n" } as never,
      task.id,
      { ...result(), workflowStepId: "plan-review", workflowStepName: "Plan Review", verdict: "APPROVE" },
      { requireAttemptStartedAt: "attempt-a" },
    )).resolves.toBe(true);

    expect(lockCurrentPlanWhilePlanningLocked).toHaveBeenCalledOnce();
    expect(updateWorkflowStepResultsFenced).toHaveBeenCalledOnce();
    expect(updateTask).not.toHaveBeenCalled();
    expect(reconcileSpecDriftWhilePlanningLocked).not.toHaveBeenCalled();
    expect(store.recordAgentActivity).not.toHaveBeenCalled();
    expect(task.workflowStepResults).toEqual([]);
    expect(task.approvedPlanFingerprint).toBeUndefined();
    expect(task.status).toBeUndefined();
  });

  it("discards only the aborted pending lease and leaves a terminal and newer lease intact", async () => {
    const task = {
      id: "FN-249",
      workflowStepResults: [
        pending("code-review", "attempt-a"),
        terminal("code-review", "terminal-a"),
        pending("code-review", "attempt-b"),
      ],
    } as Task;
    const { store } = createStore(task, "core");

    await expect(discardWorkflowStepLease(
      { store, getRunContextFor: () => undefined } as never,
      task.id,
      "code-review",
      "attempt-a",
    )).resolves.toBe(true);

    expect(task.workflowStepResults).toEqual([
      expect.objectContaining({ status: "failed", startedAt: "terminal-a" }),
      expect.objectContaining({ status: "pending", startedAt: "attempt-b" }),
    ]);
  });
});

/*
FNXC:ReviewRecovery 2026-10-12-01:58:
The hold-lane retry budget counts verdict-less Plan Review failures per unchanged plan, so each such failure must be stored with the identity of the plan it failed on, on every writer tier.
Verdicts, pending leases, other review steps and the spec-lock rejection carry no such identity.
*/
describe.each(["core", "atomic", "direct"] as const)("Plan Review failure identity on the %s writer tier", (tier) => {
  const planText = "# Plan\n\n## Mission\n\nDo the work.\n\n## Steps\n\n### Step 0: Real work\n";
  const planFingerprint = computePlanApprovalFingerprint(planText);
  const planFailure = (startedAt: string, overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult => ({
    ...terminal("plan-review", startedAt),
    workflowStepName: "Plan Review",
    ...overrides,
  });
  const depsWith = (store: unknown, readTaskArtifact?: (...args: unknown[]) => unknown) => ({
    store,
    getRunContextFor: () => undefined,
    ...(readTaskArtifact ? { readTaskArtifact } : {}),
  }) as never;
  const storedRow = (task: Task, workflowStepId = "plan-review") =>
    task.workflowStepResults?.find((entry) => entry.workflowStepId === workflowStepId);
  const emptyTask = () => ({ id: "FN-249", workflowStepResults: [] } as unknown as Task);
  /** One graph attempt as the recorders write it: a pending lease, then the terminal row for the same startedAt. */
  const runAttempt = async (
    task: Task,
    store: unknown,
    startedAt: string,
    readTaskArtifact: ((...args: unknown[]) => unknown) | undefined,
    overrides: Partial<WorkflowStepResult> = {},
  ) => {
    await persistWorkflowStepResultWithOutcome(
      depsWith(store, readTaskArtifact), task.id, { ...pending("plan-review", startedAt), workflowStepName: "Plan Review" },
    );
    return persistWorkflowStepResultWithOutcome(
      depsWith(store, readTaskArtifact), task.id, planFailure(startedAt, overrides), { requireAttemptStartedAt: startedAt },
    );
  };

  it("records the plan fingerprint on a verdict-less failure", async () => {
    const task = emptyTask();
    const { store } = createStore(task, tier);
    const reader = vi.fn(async () => planText);

    const outcome = await runAttempt(task, store, "attempt-a", reader);

    expect(outcome).toMatchObject({ persisted: true, disposition: "applied" });
    expect(outcome.persistedResult?.reviewInputFingerprint).toBe(planFingerprint);
    expect(storedRow(task)).toMatchObject({ status: "failed", startedAt: "attempt-a", reviewInputFingerprint: planFingerprint });
    expect(storedRow(task)?.verdict).toBeUndefined();
    // The pending lease is written without reading the plan.
    expect(reader).toHaveBeenCalledOnce();
    expect(reader).toHaveBeenCalledWith(task.id, "PROMPT.md");
  });

  it("keeps each attempt's identity in history and stamps the next attempt with the plan read at that time", async () => {
    const task = emptyTask();
    const { store } = createStore(task, tier);
    const changedText = `${planText}\n### Step 1: More work\n`;

    await runAttempt(task, store, "attempt-a", async () => planText);
    await runAttempt(task, store, "attempt-b", async () => changedText);

    const row = storedRow(task);
    expect(row).toMatchObject({ startedAt: "attempt-b", reviewInputFingerprint: computePlanApprovalFingerprint(changedText) });
    expect(row?.reviewInputFingerprint).not.toBe(planFingerprint);
    expect(row?.priorAttempts).toHaveLength(1);
    expect(row?.priorAttempts?.[0]).toMatchObject({ status: "failed", startedAt: "attempt-a", reviewInputFingerprint: planFingerprint });
  });

  it("gives CRLF text with trailing spaces the identity of its LF form", async () => {
    const task = emptyTask();
    const { store } = createStore(task, tier);
    const windowsText = planText.split("\n").map((line) => (line ? `${line}  ` : line)).join("\r\n");

    await runAttempt(task, store, "attempt-a", async () => windowsText);

    expect(storedRow(task)?.reviewInputFingerprint).toBe(planFingerprint);
  });

  it.each([
    ["a rejecting reader", async () => { throw new Error("documents unavailable"); }],
    ["an undefined plan", async () => undefined],
    ["a blank plan", async () => " \n\t\n"],
    ["no reader", undefined],
  ] as const)("stores the failure without an identity for %s", async (_label, reader) => {
    const task = emptyTask();
    const { store } = createStore(task, tier);

    const outcome = await runAttempt(task, store, "attempt-a", reader);

    expect(outcome).toMatchObject({ persisted: true, disposition: "applied" });
    expect(storedRow(task)).toMatchObject({ status: "failed", startedAt: "attempt-a" });
    expect(storedRow(task)).not.toHaveProperty("reviewInputFingerprint");
  });

  it.each([
    ["a REVISE", planFailure("attempt-a", { verdict: "REVISE" })],
    ["an approval", planFailure("attempt-a", { status: "passed", verdict: "APPROVE" })],
    ["a pending lease", { ...pending("plan-review", "attempt-a"), workflowStepName: "Plan Review" }],
    ["a verdict-less failure of another review step", terminal("code-review", "attempt-a")],
  ] as const)("does not read the plan or stamp %s", async (_label, incoming) => {
    const task = emptyTask();
    const { store } = createStore(task, tier);
    const reader = vi.fn(async () => planText);

    await expect(persistWorkflowStepResultWithOutcome(depsWith(store, reader), task.id, incoming))
      .resolves.toMatchObject({ persisted: true, disposition: "applied" });

    expect(reader).not.toHaveBeenCalled();
    expect(storedRow(task, incoming.workflowStepId)).toMatchObject({ status: incoming.status });
    expect(storedRow(task, incoming.workflowStepId)).not.toHaveProperty("reviewInputFingerprint");
  });

  it("keeps the review input a failure already carries", async () => {
    const task = emptyTask();
    const { store } = createStore(task, tier);
    const reader = vi.fn(async () => planText);

    await persistWorkflowStepResultWithOutcome(
      depsWith(store, reader), task.id, { ...terminal("code-review", "attempt-a"), reviewInputFingerprint: "diff-fingerprint" },
    );
    await persistWorkflowStepResultWithOutcome(
      depsWith(store, reader), task.id, planFailure("attempt-a", { reviewInputFingerprint: "caller-supplied" }),
    );

    expect(reader).not.toHaveBeenCalled();
    expect(storedRow(task, "code-review")?.reviewInputFingerprint).toBe("diff-fingerprint");
    expect(storedRow(task)?.reviewInputFingerprint).toBe("caller-supplied");
  });

  it("spends the retry budget on stored genuine failures and never on a rate-limited one", async () => {
    const task = emptyTask();
    const { store } = createStore(task, tier);
    const reader = async () => planText;

    for (const startedAt of ["attempt-a", "attempt-b", "attempt-c"]) await runAttempt(task, store, startedAt, reader);
    expect(hasExhaustedPlanReviewNoVerdictRecovery(storedRow(task), planFingerprint)).toBe(false);

    await runAttempt(task, store, "attempt-d", reader, { providerFailure: { origin: "model-provider", code: "RATE_LIMIT" } });
    expect(storedRow(task)).toMatchObject({ startedAt: "attempt-d", reviewInputFingerprint: planFingerprint });
    expect(storedRow(task)?.priorAttempts).toHaveLength(3);
    expect(hasExhaustedPlanReviewNoVerdictRecovery(storedRow(task), planFingerprint)).toBe(false);

    await runAttempt(task, store, "attempt-e", reader);
    expect(storedRow(task)?.priorAttempts).toHaveLength(4);
    expect(hasExhaustedPlanReviewNoVerdictRecovery(storedRow(task), planFingerprint)).toBe(true);
    expect(hasExhaustedPlanReviewNoVerdictRecovery(storedRow(task), computePlanApprovalFingerprint(`${planText}\nchanged\n`))).toBe(false);
  });
});

/*
FNXC:WorkflowStepResults 2026-08-29-02:41:
The unit interleaving above proves the accepted Plan Review branch recomputes against the fenced
row. This PostgreSQL proof drives that production branch while Reset holds the shared advisory
lock, so a late approval cannot restore either its result or approvedPlanFingerprint.
*/
pgDescribe("persistWorkflowStepResult Plan Review reset fence", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_plan_review_reset_fence",
    poolMax: 4,
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("blocks an accepted Plan Review write behind Reset and refuses the fresh task row", async () => {
    const store = h.store();
    const subject = await store.createTask({ description: "Plan Review reset serialization" });
    const attemptStartedAt = "2026-08-29T02:41:00.000Z";
    await store.updateTask(subject.id, {
      column: "in-progress",
      workflowStepResults: [pending("plan-review", attemptStartedAt)],
      approvedPlanFingerprint: "old-plan-fingerprint",
    });

    let releasePlanLock!: () => void;
    const planLockRelease = new Promise<void>((resolve) => { releasePlanLock = resolve; });
    let signalPlanLockReached!: () => void;
    const planLockReached = new Promise<void>((resolve) => { signalPlanLockReached = resolve; });
    const originalPlanLock = store.lockCurrentPlanWhilePlanningLocked.bind(store);
    const planLockSpy = vi.spyOn(store, "lockCurrentPlanWhilePlanningLocked").mockImplementation(async (...args) => {
      signalPlanLockReached();
      await planLockRelease;
      return originalPlanLock(...args);
    });

    let signalResetLock!: () => void;
    const resetLockHeld = new Promise<void>((resolve) => { signalResetLock = resolve; });
    let releaseReset!: () => void;
    const resetRelease = new Promise<void>((resolve) => { releaseReset = resolve; });
    const restoreResetHook = __setResetPublicationFailureForTesting(async () => {
      signalResetLock();
      await resetRelease;
    });

    let signalFencedWriter!: () => void;
    const fencedWriterStarted = new Promise<void>((resolve) => { signalFencedWriter = resolve; });
    let observedResults: WorkflowStepResult[] | undefined;
    const originalFencedWriter = store.updateWorkflowStepResultsFenced.bind(store);
    const fencedWriterSpy = vi.spyOn(store, "updateWorkflowStepResultsFenced").mockImplementation(async (taskId, compute) => {
      signalFencedWriter();
      return originalFencedWriter(taskId, (current) => {
        observedResults = current.workflowStepResults;
        return compute(current);
      });
    });
    const reconcileSpy = vi.spyOn(store, "reconcileSpecDriftWhilePlanningLocked");

    try {
      const persisted = persistWorkflowStepResult(
        { store, getRunContextFor: () => undefined, readTaskArtifact: async () => "## Mission\nApprove the task plan.\n" },
        subject.id,
        {
          workflowStepId: "plan-review",
          workflowStepName: "Plan Review",
          phase: "pre-merge",
          source: "optional-group",
          status: "passed",
          verdict: "APPROVE",
          startedAt: attemptStartedAt,
          completedAt: "2026-08-29T02:42:00.000Z",
        },
        { requireAttemptStartedAt: attemptStartedAt },
      );

      await planLockReached;
      const reset = store.resetTaskPublication(subject.id, "todo");
      await resetLockHeld;

      let settled = false;
      void persisted.then(() => { settled = true; });
      releasePlanLock();
      await fencedWriterStarted;
      expect(settled).toBe(false);

      releaseReset();
      await reset;
      await expect(persisted).resolves.toBe(true);
      expect(observedResults ?? []).toEqual([]);
      expect(reconcileSpy).not.toHaveBeenCalled();
    } finally {
      // Release both test gates on assertion failure so the harness can clean its pool.
      releasePlanLock();
      releaseReset();
      restoreResetHook();
      planLockSpy.mockRestore();
      fencedWriterSpy.mockRestore();
      reconcileSpy.mockRestore();
    }

    const fresh = await store.getTask(subject.id);
    expect(fresh?.workflowStepResults ?? []).toEqual([]);
    expect(fresh?.approvedPlanFingerprint).toBeUndefined();
  });
});
