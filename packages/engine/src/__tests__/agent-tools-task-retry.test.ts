import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowStepResult } from "@fusion/core";
import { createTaskRetryTool } from "../agent-tools.js";
import { hasExhaustedNoVerdictRecovery, hasExhaustedPlanReviewNoVerdictRecovery } from "../merge/pre-merge-gate-reseed.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-9317",
    description: "Recover an admitted merge retry",
    dependencies: [],
    column: "in-review",
    steps: [{ id: "step-1", title: "Implement", status: "done" }],
    currentStep: 0,
    log: [],
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    status: null,
    mergeRetries: 0,
    ...overrides,
  } as Task;
}

function atomicStore(task: Task) {
  return vi.fn(async (_id: string, mutate: (current: Task) => Partial<Task> | null | Promise<Partial<Task> | null>) => {
    const patch = await mutate(task);
    return patch ? { ...task, ...patch } : task;
  });
}

describe("createTaskRetryTool", () => {
  it("keeps a completed status-none review task in review and resets its merge recovery state", async () => {
    const completedReviewTask = task();
    const updateTask = vi.fn().mockResolvedValue(completedReviewTask);
    const logEntry = vi.fn().mockResolvedValue(undefined);
    const moveTask = vi.fn();
    const updateTaskAtomic = atomicStore(completedReviewTask);
    const resetInReviewMergeRetry = vi.fn().mockResolvedValue("reset");
    const store = {
      getTask: vi.fn().mockResolvedValue(completedReviewTask),
      getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined),
      getSettings: vi.fn().mockResolvedValue({ autoMerge: true }),
      updateTask,
      updateTaskAtomic,
      logEntry,
      moveTask,
    } as unknown as TaskStore;

    const result = await createTaskRetryTool(store, { resetInReviewMergeRetry }).execute(
      "run", { id: completedReviewTask.id }, undefined as never, undefined as never, undefined as never,
    );

    expect((result as { isError?: boolean }).isError).not.toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Retried FN-9317 in review");
    expect(resetInReviewMergeRetry).toHaveBeenCalledWith(completedReviewTask);
    expect(updateTaskAtomic).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(logEntry).toHaveBeenCalledWith("FN-9317", expect.stringContaining("in-review merge retry"));
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("re-seeds a failed no-verdict review through the ProjectEngine fence without resetting merge state", async () => {
    const noVerdictTask = task({
      workflowStepResults: [{
        workflowStepId: "code-review",
        status: "failed",
        phase: "pre-merge",
        findings: [{ id: "fn-9372-unfixed-pipeline-smoke", severity: "critical" }],
      }],
    });
    const resetInReviewMergeRetry = vi.fn();
    const rerouteFailedNoVerdictPreMergeReview = vi.fn().mockResolvedValue("rerouted");
    const logEntry = vi.fn().mockResolvedValue(undefined);
    const store = {
      getTask: vi.fn().mockResolvedValue(noVerdictTask),
      getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined),
      getSettings: vi.fn().mockResolvedValue({ autoMerge: true }),
      logEntry,
    } as unknown as TaskStore;

    const result = await createTaskRetryTool(store, {
      resetInReviewMergeRetry,
      rerouteFailedNoVerdictPreMergeReview,
    }).execute("run", { id: noVerdictTask.id }, undefined as never, undefined as never, undefined as never);

    expect((result as { isError?: boolean }).isError).not.toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("failed review re-seeded");
    expect(rerouteFailedNoVerdictPreMergeReview).toHaveBeenCalledWith(noVerdictTask);
    expect(resetInReviewMergeRetry).not.toHaveBeenCalled();
    expect(logEntry).toHaveBeenCalledWith(noVerdictTask.id, expect.stringContaining("failed no-verdict"));
  });

  it("refuses a no-verdict retry when ProjectEngine observes a selection race before queue admission", async () => {
    const noVerdictTask = task({
      workflowStepResults: [{
        workflowStepId: "code-review",
        status: "failed",
        phase: "pre-merge",
        findings: [{ id: "fn-9372-unfixed-pipeline-smoke", severity: "critical" }],
      }],
    });
    const resetInReviewMergeRetry = vi.fn();
    const rerouteFailedNoVerdictPreMergeReview = vi.fn().mockImplementation(async () => {
      await Promise.resolve();
      return "changed";
    });
    const logEntry = vi.fn();
    const store = {
      getTask: vi.fn().mockResolvedValue(noVerdictTask),
      getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined),
      getSettings: vi.fn().mockResolvedValue({ autoMerge: true }),
      logEntry,
      seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(),
    } as unknown as TaskStore;

    const result = await createTaskRetryTool(store, {
      resetInReviewMergeRetry,
      rerouteFailedNoVerdictPreMergeReview,
    }).execute("run", { id: noVerdictTask.id }, undefined as never, undefined as never, undefined as never);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("ownership is unavailable, active, or changed");
    expect(resetInReviewMergeRetry).not.toHaveBeenCalled();
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
    expect(logEntry).not.toHaveBeenCalled();
  });

  it("refuses a status-none retry while ProjectEngine still owns the queued merge", async () => {
    const queuedMergeTask = task();
    const updateTask = vi.fn();
    const logEntry = vi.fn();
    const updateTaskAtomic = vi.fn();
    const isMergePending = vi.fn().mockResolvedValue(true);
    const resetInReviewMergeRetry = vi.fn().mockResolvedValue("pending");
    const store = {
      getTask: vi.fn().mockResolvedValue(queuedMergeTask),
      getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined),
      getSettings: vi.fn().mockResolvedValue({ autoMerge: true }),
      updateTask,
      updateTaskAtomic,
      logEntry,
    } as unknown as TaskStore;

    const result = await createTaskRetryTool(store, { isMergePending, resetInReviewMergeRetry }).execute(
      "run", { id: queuedMergeTask.id }, undefined as never, undefined as never, undefined as never,
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("merge is queued or active");
    expect(resetInReviewMergeRetry).toHaveBeenCalledWith(queuedMergeTask);
    expect(isMergePending).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(updateTaskAtomic).not.toHaveBeenCalled();
    expect(logEntry).not.toHaveBeenCalled();
  });

  it("refuses a completed status-none review card held for manual merge", async () => {
    const manualReviewTask = task({ autoMerge: false });
    const updateTask = vi.fn();
    const logEntry = vi.fn();
    const moveTask = vi.fn();
    const store = {
      getTask: vi.fn().mockResolvedValue(manualReviewTask),
      getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined),
      getSettings: vi.fn().mockResolvedValue({ autoMerge: true }),
      updateTask,
      logEntry,
      moveTask,
    } as unknown as TaskStore;

    const result = await createTaskRetryTool(store).execute(
      "run", { id: manualReviewTask.id }, undefined as never, undefined as never, undefined as never,
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("not in a retryable state");
    expect(updateTask).not.toHaveBeenCalled();
    expect(logEntry).not.toHaveBeenCalled();
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("fails closed when chat lacks ProjectEngine merge ownership", async () => {
    const completedReviewTask = task();
    const updateTaskAtomic = vi.fn();
    const store = {
      getTask: vi.fn().mockResolvedValue(completedReviewTask),
      getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined),
      getSettings: vi.fn().mockResolvedValue({ autoMerge: true }),
      updateTaskAtomic,
      logEntry: vi.fn(),
    } as unknown as TaskStore;

    const result = await createTaskRetryTool(store).execute("run", { id: completedReviewTask.id }, undefined as never, undefined as never, undefined as never);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("authoritative merge ownership is unavailable");
    expect(updateTaskAtomic).not.toHaveBeenCalled();
  });

  it("refuses when the ProjectEngine-owned reset fence observes a merge admission", async () => {
    const completedReviewTask = task();
    const resetInReviewMergeRetry = vi.fn().mockResolvedValue("pending");
    const logEntry = vi.fn();
    const store = {
      getTask: vi.fn().mockResolvedValue(completedReviewTask),
      getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined),
      getSettings: vi.fn().mockResolvedValue({ autoMerge: true }),
      logEntry,
    } as unknown as TaskStore;

    const result = await createTaskRetryTool(store, { resetInReviewMergeRetry }).execute("run", { id: completedReviewTask.id }, undefined as never, undefined as never, undefined as never);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("merge is queued or active");
    expect(resetInReviewMergeRetry).toHaveBeenCalledWith(completedReviewTask);
    expect(logEntry).not.toHaveBeenCalled();
  });

  describe("no-verdict review budget re-arm", () => {
    /** A review row that failed without a verdict four times on the same input: one attempt plus three retries. */
    function exhaustedRow(workflowStepId: string, input: Partial<WorkflowStepResult>): WorkflowStepResult {
      const attempt = (sequence: number): WorkflowStepResult => ({
        workflowStepId, workflowStepName: workflowStepId, phase: "pre-merge", status: "failed",
        startedAt: `2026-10-12T0${sequence}:00:00.000Z`, output: `no verdict (attempt ${sequence})`, ...input,
      });
      return { ...attempt(4), priorAttempts: [attempt(3), attempt(2), attempt(1)] };
    }

    /** A store whose writes land on the fixture, so the stored rows can be read back after the retry. */
    function parkedStore(parked: Task) {
      const updateTask = vi.fn();
      const updateTaskAtomic = vi.fn(async (_id: string, mutate: (current: Task) => Partial<Task> | null) => {
        const patch = mutate(parked);
        if (patch) Object.assign(parked, patch);
        return parked;
      });
      const moveTask = vi.fn(async (_id: string, column: string) => Object.assign(parked, { column }));
      const store = {
        getTask: vi.fn(async () => parked),
        getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined),
        getSettings: vi.fn().mockResolvedValue({ autoMerge: true }),
        updateTask,
        updateTaskAtomic,
        moveTask,
        logEntry: vi.fn().mockResolvedValue(undefined),
      } as unknown as TaskStore;
      return { store, updateTask, updateTaskAtomic, moveTask };
    }

    const retry = (store: TaskStore, id: string) => createTaskRetryTool(store).execute(
      "run", { id }, undefined as never, undefined as never, undefined as never,
    );

    it("re-arms a hold-lane card parked by the Plan Review no-verdict limit and keeps its history", async () => {
      const row = exhaustedRow("plan-review", { reviewInputFingerprint: "plan" });
      const parked = task({
        column: "todo", status: "failed", error: "Plan Review recovery stopped in 'todo'", steps: [], workflowStepResults: [row],
      });
      expect(hasExhaustedPlanReviewNoVerdictRecovery(row, "plan")).toBe(true);
      const { store, updateTask } = parkedStore(parked);

      const result = await retry(store, parked.id);

      expect((result as { isError?: boolean }).isError).not.toBe(true);
      expect(updateTask).not.toHaveBeenCalled();
      expect(parked.status).toBeNull();
      expect(parked.error).toBeNull();
      const [stored] = parked.workflowStepResults!;
      expect(typeof stored.noVerdictBudgetRearmedAt).toBe("string");
      expect(stored.priorAttempts).toEqual(row.priorAttempts);
      expect(stored).toEqual({ ...row, noVerdictBudgetRearmedAt: stored.noVerdictBudgetRearmedAt });
      expect(hasExhaustedPlanReviewNoVerdictRecovery(stored, "plan")).toBe(false);
    });

    it("re-arms a review-lane card parked by the review no-verdict limit and keeps its history", async () => {
      const row = exhaustedRow("code-review", { reviewInputFingerprint: "diff", reviewedCommitSha: "sha" });
      const parked = task({
        status: "failed", error: "Review recovery stopped at 'code-review': no verdict", workflowStepResults: [row],
      });
      expect(hasExhaustedNoVerdictRecovery(row)).toBe(true);
      const { store } = parkedStore(parked);

      const result = await retry(store, parked.id);

      expect((result as { isError?: boolean }).isError).not.toBe(true);
      expect(parked.status).toBeNull();
      expect(parked.error).toBeNull();
      const [stored] = parked.workflowStepResults!;
      expect(typeof stored.noVerdictBudgetRearmedAt).toBe("string");
      expect(stored.priorAttempts).toEqual(row.priorAttempts);
      expect(hasExhaustedNoVerdictRecovery(stored)).toBe(false);
    });

    it.each([
      ["no review results", undefined],
      ["an approved review", [{ workflowStepId: "code-review", workflowStepName: "Code Review", status: "passed", verdict: "APPROVE" }]],
      ["a rejected review", [{ workflowStepId: "code-review", workflowStepName: "Code Review", status: "failed", verdict: "REVISE" }]],
    ] as const)("writes no step results when retrying a failed card with %s", async (_label, workflowStepResults) => {
      const parked = task({
        column: "in-progress", status: "failed", error: "executor failed",
        workflowStepResults: workflowStepResults as WorkflowStepResult[] | undefined,
      });
      const { store, updateTaskAtomic } = parkedStore(parked);

      const result = await retry(store, parked.id);

      expect((result as { isError?: boolean }).isError).not.toBe(true);
      expect(updateTaskAtomic).toHaveBeenCalledOnce();
      await expect(updateTaskAtomic.mock.results[0]!.value).resolves.toBe(parked);
      const patch = (updateTaskAtomic.mock.calls[0]![1] as (current: Task) => Partial<Task>)(parked);
      expect(patch).toEqual({ status: null, error: null });
    });
  });
});
