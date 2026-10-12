/**
 * FNXC:PostgresCutover 2026-07-04-00:00:
 * Migrated from the legacy SQLite `new TaskStore(tmpDir)` harness to the
 * PostgreSQL extension harness. `runTaskRetry` resolves its store through the
 * CLI command path (`project-context.resolveProject`), which is independent of
 * the extension store cache the harness injects — so `resolveProject` is
 * redirected to the harness's PG-backed store, and the full retry lifecycle
 * (moveTask / updateTask / getTask / logEntry) runs against real PostgreSQL
 * state instead of the removed SQLite runtime.
 *
 * FNXC:CliTests 2026-07-16-08:45:
 * FN-8102 repairs stale retry scaffolding left after the PG migration: every
 * lifecycle seed and verification read must use the initialized harness store,
 * rather than the removed `createStore()` helper.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { createPgExtensionHarness } from "./pg-extension-harness.js";
import { MANUAL_RETRY_RESET_COUNTER_KEYS, type WorkflowStepResult } from "@fusion/core";
import {
  hasExhaustedNoVerdictRecovery,
  hasExhaustedPlanReviewNoVerdictRecovery,
  isFailedNoVerdictPreMergeReviewResult,
} from "../../../engine/src/merge/pre-merge-gate-reseed.js";

// `runTaskRetry` resolves its store via resolveProject() (commands/task.ts →
// project-context.ts), a separate cache from the extension store the harness
// injects. Redirect resolveProject to the harness PG store so the command path
// and the seeded task share one isolated PostgreSQL database.
const resolveProjectMock = vi.hoisted(() => vi.fn());
const closeProjectStoreMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../project-context.js", () => ({
  resolveProject: resolveProjectMock,
  // FNXC:CliTests 2026-07-16-08:47: FN-8102 keeps command-finally cleanup
  // awaitable while the PG harness retains ownership of the test store lifecycle.
  closeProjectStore: closeProjectStoreMock,
}));

import { runTaskRetry } from "../commands/task.js";

const pgTest = pgDescribe;

pgTest("runTaskRetry", () => {
  const h = createPgExtensionHarness("fn-task-retry");

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    resolveProjectMock.mockResolvedValue({
      store: h.store(),
      projectId: h.rootDir(),
      projectPath: h.rootDir(),
      projectName: "test",
      isRegistered: false,
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    resolveProjectMock.mockReset();
    closeProjectStoreMock.mockClear();
    await h.afterEach();
  });
  afterAll(h.afterAll);

  it("retries merge-active missing-worktree session failures by clearing phantom metadata", async () => {
    const store = h.store();
    const task = await store.createTask({
      title: "missing worktree merge-active task",
      description: "test",
      column: "todo",
    });
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "in-review");
    await store.updateTask(task.id, {
      status: "merging",
      error: "Refusing to start coding agent in missing worktree: /tmp/fusion-missing-worktree",
      worktree: "/tmp/fusion-missing-worktree",
      branch: `fusion/${task.id}`,
      // FNXC:CliTests 2026-08-23-16:14: FN-107 requires branchWriteOrigin provenance on every branch write; this engine-simulated fixture predates that guard.
      branchWriteOrigin: "engine" as const,
      sessionFile: "/tmp/fusion-session.json",
      steps: [{ name: "implemented", status: "done" }, { name: "fix", status: "pending" }],
      worktreeSessionRetryCount: 3,
      mergeRetries: 3,
    });

    await runTaskRetry(task.id);

    const verificationStore = h.store();
    const updated = await verificationStore.getTask(task.id);
    expect(updated.column).toBe("todo");
    expect(updated.status).toBeUndefined();
    expect(updated.error).toBeUndefined();
    expect(updated.worktree).toBeUndefined();
    expect(updated.branch).toBeUndefined();
    expect(updated.sessionFile).toBeUndefined();
    expect(updated.worktreeSessionRetryCount).toBe(0);
    expect(updated.mergeRetries).toBe(0);
    expect(updated.steps?.[0]?.status).toBe("done");
  });

  it("rejects unrelated merge-active tasks without the missing-worktree signature", async () => {
    const store = h.store();
    const task = await store.createTask({ title: "ordinary merge", description: "test", column: "todo" });
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "in-review");
    await store.updateTask(task.id, {
      status: "merging",
      error: "ordinary merge still running",
      steps: [{ name: "implemented", status: "done" }],
    });

    await expect(runTaskRetry(task.id)).rejects.toThrow(/not in a retryable state/);
  });

  /*
  FNXC:TaskRetry 2026-10-07-17:57:
  A manual retry either fully resets or fully refuses, and never leaves a half-applied state.
  The generic and in-review branches moved first; the reopen move clears worktree (and branch from review), so the fenced reset saw a "newer lifecycle" and threw "superseded" after the card had already moved, leaving retry counters, mergeRetries and stale base refs in place.
  Every branch is exercised on a card that still holds a worktree and branch, which is the ordinary failed-task shape.
  */
  const nonZeroRetryCounters = Object.fromEntries(MANUAL_RETRY_RESET_COUNTER_KEYS.map((key, index) => [key, index + 1]));
  it.each([
    { branch: "generic failure", toReview: false, patch: {} },
    { branch: "in-review execution failure", toReview: true, patch: { steps: [{ name: "implemented", status: "done" }, { name: "fix", status: "pending" }] } },
    { branch: "deadlock auto-pause", toReview: true, patch: { paused: true, pausedReason: "in-review-stall-deadlock", steps: [{ name: "implemented", status: "done" }] } },
  ])("fully resets a $branch retry on a card that holds a worktree and branch", async ({ toReview, patch }) => {
    const store = h.store();
    const task = await store.createTask({ title: "failed with a checkout", description: "test", column: "todo" });
    await store.moveTask(task.id, "in-progress");
    if (toReview) await store.moveTask(task.id, "in-review");
    await store.updateTask(task.id, {
      status: "failed",
      error: "boom",
      worktree: "/tmp/fusion-retry-worktree",
      branch: `fusion/${task.id}`,
      branchWriteOrigin: "engine" as const,
      mergeRetries: 4,
      nextRecoveryAt: new Date(Date.now() + 60_000).toISOString(),
      ...nonZeroRetryCounters,
      ...patch,
    } as never);

    const provenance: Array<string | undefined> = [];
    const onMoved = (data: { workflowMoveSource?: string }) => { provenance.push(data.workflowMoveSource); };
    store.on("task:moved", onMoved as never);
    try {
      await expect(runTaskRetry(task.id)).resolves.toBeUndefined();
    } finally {
      store.off("task:moved", onMoved as never);
    }

    store.taskCache.delete(task.id);
    const updated = await store.getTask(task.id);
    expect(updated.column).toBe("todo");
    expect(updated.status).toBeFalsy();
    expect(updated.error).toBeFalsy();
    expect(updated.userPaused).not.toBe(true);
    expect(updated.paused).toBeFalsy();
    for (const key of MANUAL_RETRY_RESET_COUNTER_KEYS) expect(updated[key] ?? 0).toBe(0);
    expect(updated.nextRecoveryAt ?? null).toBeNull();
    expect(provenance).toEqual(["manual-retry"]);
  });

  it("clears the deadlock auto-pause when retrying a failed task", async () => {
    const store = h.store();
    const task = await store.createTask({
      title: "deadlock-paused task",
      description: "test",
      column: "todo",
    });
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "in-review");
    await store.updateTask(task.id, {
      status: "failed",
      error: "merge deadlock",
      paused: true,
      pausedReason: "in-review-stall-deadlock",
      steps: [{ name: "implemented", status: "done" }],
      mergeRetries: 4,
    });

    await runTaskRetry(task.id);

    const updated = await store.getTask(task.id);
    expect(updated.column).toBe("todo");
    expect(updated.status).toBeFalsy();
    expect(updated.error).toBeFalsy();
    expect(updated.paused).toBeFalsy();
    expect(updated.pausedReason).toBeFalsy();
    expect(updated.mergeRetries).toBe(0);
  });

  /*
  FNXC:ReviewRecovery 2026-10-12-04:10:
  A card stopped by a no-verdict review limit must get a fresh retry budget from `fn task retry`, with its review history kept.
  The stored row is read back from PostgreSQL and checked with the predicates the engine sweeps use.
  */
  /** A review row that failed without a verdict four times on one input: the first attempt plus three automatic retries. */
  const exhaustedReviewRow = (workflowStepId: string, workflowStepName: string, input: Partial<WorkflowStepResult>): WorkflowStepResult => {
    const attempt = (sequence: number): WorkflowStepResult => ({
      workflowStepId, workflowStepName, phase: "pre-merge", status: "failed",
      startedAt: `2026-10-12T0${sequence}:00:00.000Z`, completedAt: `2026-10-12T0${sequence}:00:16.000Z`,
      output: `Review failed before producing a verdict (attempt ${sequence})`, ...input,
    });
    return { ...attempt(4), priorAttempts: [attempt(3), attempt(2), attempt(1)] };
  };

  it("re-arms the Plan Review no-verdict budget of a parked hold-lane card and keeps its review history", async () => {
    const store = h.store();
    const task = await store.createTask({ title: "parked plan review", description: "test", column: "todo" });
    const row = exhaustedReviewRow("plan-review", "Plan Review", { reviewInputFingerprint: "plan" });
    await store.updateTask(task.id, {
      status: "failed",
      error: "Plan Review recovery stopped in 'todo': no verdict after 3 automatic retries on the unchanged plan.",
      workflowStepResults: [row],
    });
    expect(hasExhaustedPlanReviewNoVerdictRecovery(row, "plan")).toBe(true);

    await runTaskRetry(task.id);

    store.taskCache.delete(task.id);
    const updated = await store.getTask(task.id);
    expect(updated.column).toBe("todo");
    expect(updated.status).toBeFalsy();
    expect(updated.error).toBeFalsy();
    expect(updated.workflowStepResults).toHaveLength(1);
    const [stored] = updated.workflowStepResults!;
    expect(stored).toEqual({ ...row, noVerdictBudgetRearmedAt: expect.any(String) });
    expect(hasExhaustedPlanReviewNoVerdictRecovery(stored, "plan")).toBe(false);
  });

  it("re-arms the review no-verdict budget of a parked review-lane card and keeps it in review", async () => {
    const store = h.store();
    const task = await store.createTask({ title: "parked code review", description: "test", column: "todo" });
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "in-review");
    const row = exhaustedReviewRow("code-review", "Code Review", { reviewInputFingerprint: "diff", reviewedCommitSha: "abc123" });
    await store.updateTask(task.id, {
      status: "failed",
      error: "Review recovery stopped at 'code-review': Review failed before producing a verdict (attempt 4) Correct the review input or provider failure before retrying.",
      steps: [{ name: "implemented", status: "done" }],
      mergeRetries: 2,
      workflowStepResults: [row],
    });
    expect(hasExhaustedNoVerdictRecovery(row)).toBe(true);
    expect(isFailedNoVerdictPreMergeReviewResult(row, new Set(["code-review"]))).toBe(false);

    await runTaskRetry(task.id);

    store.taskCache.delete(task.id);
    const updated = await store.getTask(task.id);
    expect(updated.column).toBe("in-review");
    expect(updated.status).toBeFalsy();
    expect(updated.error).toBeFalsy();
    expect(updated.mergeRetries).toBe(0);
    const [stored] = updated.workflowStepResults!;
    expect(stored).toEqual({ ...row, noVerdictBudgetRearmedAt: expect.any(String) });
    expect(hasExhaustedNoVerdictRecovery(stored)).toBe(false);
    expect(isFailedNoVerdictPreMergeReviewResult(stored, new Set(["code-review"]))).toBe(true);
  });

  it("writes no review results when the retried card has no failed verdict-less review", async () => {
    const store = h.store();
    const task = await store.createTask({ title: "rejected plan", description: "test", column: "todo" });
    const rejected: WorkflowStepResult = {
      workflowStepId: "plan-review", workflowStepName: "Plan Review", phase: "pre-merge", status: "failed", verdict: "REVISE",
      startedAt: "2026-10-12T01:00:00.000Z", output: "The plan misses a step.",
    };
    await store.updateTask(task.id, { status: "failed", error: "boom", workflowStepResults: [rejected] });

    await runTaskRetry(task.id);

    store.taskCache.delete(task.id);
    const updated = await store.getTask(task.id);
    expect(updated.status).toBeFalsy();
    expect(updated.workflowStepResults).toEqual([rejected]);
  });
});
