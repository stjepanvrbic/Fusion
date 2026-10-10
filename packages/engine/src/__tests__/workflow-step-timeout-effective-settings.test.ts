/*
FNXC:WorkflowSettings 2026-10-10-23:00:
The workflow "Step timeout" an operator stores for a workflow bounds that workflow's steps.

Original symptom (KB-080): with the stored value at 2700000 ms, Code Review was aborted at 900000 ms four times, because the graph run handed its steps the raw project settings, where a moved workflow setting no longer lives.

Surface enumeration (engine only, no UI):
- Stored value above the default, stored value below the default, and no stored value (the 15-minute default stays).
- The value is read by the step a real graph run dispatches, not by a step called with hand-built settings.
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

/** Starts a real graph run whose only step is a review session that never answers. */
function startHangingReview(storedWorkflowValues: Record<string, unknown>) {
  const store = createMockStore();
  const task = reviewCard();
  store.getTask.mockResolvedValue(task);
  store.getSettings.mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4, pollIntervalMs: 15_000, autoMerge: false });
  Object.assign(store, {
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: WORKFLOW_ID, stepIds: [] })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: WORKFLOW_ID, stepIds: [] })),
    getWorkflowDefinition: vi.fn(async () => ({ id: WORKFLOW_ID, name: "single review step", ir: reviewWorkflow })),
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
});
