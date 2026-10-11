/*
FNXC:WorkflowSettings 2026-10-10-23:00:
The workflow "Step timeout" an operator stores for a workflow bounds that workflow's steps.

Original symptom (KB-080): with the stored value at 2700000 ms, Code Review was aborted at 900000 ms four times, because the graph run handed its steps the raw project settings, where a moved workflow setting no longer lives.

Surface enumeration (engine only, no UI):
- Stored value above the default, stored value below the default, and no stored value (the 15-minute default stays).
- The value is read by the step a real graph run dispatches, not by a step called with hand-built settings.

FNXC:WorkflowSettings 2026-10-11-07:35:
The stored step timeout bounds every AI-session step kind, not only reviews.
A non-review prompt step (no review name, kind or group) gets the same stored, lower and default values through the same real graph run.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDetail, WorkflowIr } from "@fusion/core";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, mockedCreateFnAgent, mockedExecSync, mockedExistsSync, resetExecutorMocks } from "./executor-test-helpers.js";

const now = "2026-10-10T20:00:00.000Z";
const WORKFLOW_ID = "WF-step-timeout";
const MINUTE = 60_000;

const reviewWorkflow: WorkflowIr = {
  version: "v2",
  name: "single review step",
  columns: [{ id: "in-review", name: "Review", traits: [] }],
  settings: [{ id: "workflowStepTimeoutMs", name: "Step timeout (ms)", type: "number", default: 900_000 }],
  nodes: [
    { id: "start", kind: "start" },
    {
      id: "code-review",
      kind: "optional-group",
      config: {
        name: "Code Review",
        defaultOn: true,
        phase: "pre-merge",
        template: {
          nodes: [{ id: "code-review-step", kind: "prompt", config: { prompt: "Review the implementation.", toolMode: "readonly" } }],
          edges: [],
        },
      },
    },
    { id: "end", kind: "end" },
  ],
  edges: [
    { from: "start", to: "code-review" },
    { from: "code-review", to: "end" },
  ],
} as WorkflowIr;

/** A non-review prompt step: no review/verification name, no reviewKind, and not in a review group. */
const documentationWorkflow: WorkflowIr = {
  version: "v2",
  name: "single documentation step",
  columns: [{ id: "in-review", name: "Review", traits: [] }],
  settings: [{ id: "workflowStepTimeoutMs", name: "Step timeout (ms)", type: "number", default: 900_000 }],
  nodes: [
    { id: "start", kind: "start" },
    {
      id: "documentation",
      kind: "optional-group",
      config: {
        name: "Documentation & Delivery",
        defaultOn: true,
        phase: "pre-merge",
        template: {
          nodes: [{ id: "documentation-step", kind: "prompt", config: { prompt: "Update the documentation.", toolMode: "coding" } }],
          edges: [],
        },
      },
    },
    { id: "end", kind: "end" },
  ],
  edges: [
    { from: "start", to: "documentation" },
    { from: "documentation", to: "end" },
  ],
} as WorkflowIr;

function reviewCard(): TaskDetail {
  return {
    id: "KB-080",
    title: "Long review",
    description: "A review that needs more than the default step timeout",
    column: "in-review",
    dependencies: [],
    steps: [{ name: "Implement", status: "done" }],
    currentStep: 0,
    log: [],
    branch: "fusion/kb-080",
    baseBranch: "main",
    baseCommitSha: "abc123",
    worktree: "/tmp/fusion-kb-080",
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    autoMerge: false,
    enabledWorkflowSteps: ["code-review"],
    workflowStepResults: [],
    createdAt: now,
    updatedAt: now,
  } as unknown as TaskDetail;
}

/** Starts a real graph run whose only step is a session that never answers. */
function startHangingStep(ir: WorkflowIr, enabledStepId: string, storedWorkflowValues: Record<string, unknown>) {
  const store = createMockStore();
  const task = { ...reviewCard(), enabledWorkflowSteps: [enabledStepId] } as TaskDetail;
  store.getTask.mockResolvedValue(task);
  store.getSettings.mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4, pollIntervalMs: 15_000, autoMerge: false });
  Object.assign(store, {
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: WORKFLOW_ID, stepIds: [] })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: WORKFLOW_ID, stepIds: [] })),
    getWorkflowDefinition: vi.fn(async () => ({ id: WORKFLOW_ID, name: ir.name, ir })),
    getWorkflowSettingValues: vi.fn(() => storedWorkflowValues),
    getWorkflowSettingsProjectId: vi.fn(() => "proj-1"),
    updateTaskAtomic: vi.fn(async (taskId: string, updater: (current: TaskDetail) => Partial<TaskDetail> | null) => {
      const patch = updater(task);
      if (patch) Object.assign(task, patch);
      return task;
    }),
  });
  mockedCreateFnAgent.mockImplementation(async () => ({
    session: {
      state: {},
      subscribe: () => () => {},
      prompt: vi.fn(() => new Promise(() => {})),
      dispose: vi.fn(),
    },
  }) as never);
  const executor = new TaskExecutor(store as never, "/tmp/test", {
    agentStore: { getAgent: vi.fn().mockResolvedValue(null), createAgent: vi.fn() },
  } as never);
  void (executor as unknown as { executeWorkflowGraph: (task: TaskDetail) => Promise<void> }).executeWorkflowGraph(task).catch(() => undefined);
  const timeoutLines = () => store.logEntry.mock.calls
    .map((call: unknown[]) => String(call[1]))
    .filter((line: string) => line.includes("timed out after"));
  const sessions = () => mockedCreateFnAgent.mock.calls.length;
  /** The step reaches its session after real asynchronous work (git, prompt assembly), so wait for it before moving the clock. */
  const sessionOpened = () => vi.waitFor(() => expect(sessions()).toBe(1), { timeout: 10_000 });
  return { timeoutLines, sessions, sessionOpened };
}

function startHangingReview(storedWorkflowValues: Record<string, unknown>) {
  return startHangingStep(reviewWorkflow, "code-review", storedWorkflowValues);
}

function startHangingDocumentationStep(storedWorkflowValues: Record<string, unknown>) {
  return startHangingStep(documentationWorkflow, "documentation", storedWorkflowValues);
}

describe("workflow step timeout comes from the task's effective workflow settings", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedExecSync.mockImplementation(() => Buffer.from(""));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets a review run past 15 minutes when the stored step timeout is 45 minutes", async () => {
    const { timeoutLines, sessions, sessionOpened } = startHangingReview({ workflowStepTimeoutMs: 2_700_000 });
    await sessionOpened();

    await vi.advanceTimersByTimeAsync(44 * MINUTE);
    expect(sessions()).toBe(1);
    expect(timeoutLines()).toEqual([]);

    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(timeoutLines()[0]).toContain("timed out after 2700s");
  });

  it("times a review out early when the stored step timeout is 5 minutes", async () => {
    const { timeoutLines, sessionOpened } = startHangingReview({ workflowStepTimeoutMs: 300_000 });
    await sessionOpened();

    await vi.advanceTimersByTimeAsync(6 * MINUTE);

    expect(timeoutLines()[0]).toContain("timed out after 300s");
  });

  it("keeps the 15-minute default when no step timeout is stored", async () => {
    const { timeoutLines, sessionOpened } = startHangingReview({});
    await sessionOpened();

    await vi.advanceTimersByTimeAsync(14 * MINUTE);
    expect(timeoutLines()).toEqual([]);

    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(timeoutLines()[0]).toContain("timed out after 900s");
  });

  it("lets a non-review step run past 15 minutes when the stored step timeout is 45 minutes", async () => {
    const { timeoutLines, sessions, sessionOpened } = startHangingDocumentationStep({ workflowStepTimeoutMs: 2_700_000 });
    await sessionOpened();

    await vi.advanceTimersByTimeAsync(44 * MINUTE);
    expect(sessions()).toBe(1);
    expect(timeoutLines()).toEqual([]);

    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(timeoutLines()[0]).toContain("'documentation-step'");
    expect(timeoutLines()[0]).toContain("timed out after 2700s");
  });

  it("times a non-review step out early when the stored step timeout is 5 minutes", async () => {
    const { timeoutLines, sessionOpened } = startHangingDocumentationStep({ workflowStepTimeoutMs: 300_000 });
    await sessionOpened();

    await vi.advanceTimersByTimeAsync(6 * MINUTE);

    expect(timeoutLines()[0]).toContain("timed out after 300s");
  });

  it("keeps the 15-minute default for a non-review step when no step timeout is stored", async () => {
    const { timeoutLines, sessionOpened } = startHangingDocumentationStep({});
    await sessionOpened();

    await vi.advanceTimersByTimeAsync(14 * MINUTE);
    expect(timeoutLines()).toEqual([]);

    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(timeoutLines()[0]).toContain("timed out after 900s");
  });
});
