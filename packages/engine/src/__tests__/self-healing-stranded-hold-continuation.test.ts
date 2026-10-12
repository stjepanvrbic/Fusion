import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Settings, Task, TaskStore, WorkflowIr, WorkflowStepResult, WorkflowWorkItem } from "@fusion/core";

const { recordRunAuditEventMock, resolveWorkflowIrForTaskMock } = vi.hoisted(() => ({
  recordRunAuditEventMock: vi.fn(async () => undefined),
  resolveWorkflowIrForTaskMock: vi.fn(),
}));
vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  resolveWorkflowIrForTask: resolveWorkflowIrForTaskMock,
}));
vi.mock("../util/run-audit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../util/run-audit.js")>()),
  createRunAuditor: vi.fn(() => ({ database: recordRunAuditEventMock })),
}));

import { SelfHealingManager } from "../self-healing.js";
import { InProcessRuntime } from "../runtimes/in-process-runtime.js";
import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";
import { evaluateStrandedHoldContinuation, planReviewInputFingerprint } from "../plan-review-continuation.js";
import { persistWorkflowStepResultWithOutcome } from "../executor/execute-workflow-graph.js";
import { readTaskArtifact } from "../executor/read-task-artifact.js";

const workflow: WorkflowIr = {
  version: "v2", name: "stranded-test", columns: [
    { id: "holding-area", name: "Holding", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "in-progress", name: "Working", traits: [{ trait: "wip" }] },
  ],
  nodes: [
    { id: "start", kind: "start", column: "holding-area" },
    { id: "plan-review", kind: "optional-group", column: "holding-area", config: { defaultOn: true, template: { nodes: [{ id: "reviewer", kind: "prompt", config: { prompt: "Review the plan" } }], edges: [] } } },
  ],
  edges: [{ from: "start", to: "plan-review" }],
};

function strandedTask(overrides: Partial<Task> = {}): Task {
  const stale = new Date(Date.now() - 120_000).toISOString();
  return {
    id: "FN-8592-test", title: "Real specification", description: "A real task", column: "holding-area",
    dependencies: [], steps: [], currentStep: 0, log: [], createdAt: stale, updatedAt: stale,
    columnMovedAt: stale, workflowStepResults: [], ...overrides,
  } as Task;
}

function storeFor(task: Task, settings: Partial<Settings> = {}) {
  const items: WorkflowWorkItem[] = [];
  return {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false, ...settings } as Settings)),
    listTasks: vi.fn(async () => [task]),
    getTask: vi.fn(async (id: string) => id === task.id ? task : undefined),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(task, patch)),
    updateTaskAtomic: vi.fn(async (_id: string, compute: (current: Task) => Partial<Task> | null) => {
      const patch = compute(task);
      if (patch) Object.assign(task, patch);
      return task;
    }),
    logEntry: vi.fn(async () => undefined),
    moveTask: vi.fn(),
    recordRunAuditEvent: vi.fn(async () => undefined),
    recordAgentActivity: vi.fn(async () => undefined),
    // The task artifact reader looks in task documents first, then falls back to the plan a fixture sets as `task.prompt`.
    getTaskDocument: vi.fn(async () => undefined),
    listWorkflowWorkItemsForTask: vi.fn(async () => items),
    listDueWorkflowWorkItems: vi.fn(async () => items.filter((item) => item.state === "runnable" || item.state === "retrying")),
    seedStrandedPlanReviewContinuation: vi.fn(async (input: any) => {
      const item = { ...input, id: "seeded", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as WorkflowWorkItem;
      items.push(item);
      return { seeded: true, workItemId: item.id };
    }),
    withPlanningLifecycleLock: vi.fn(async (_id: string, callback: () => Promise<unknown>) => callback()),
    getTasksDir: vi.fn(() => ""),
    // FNXC:StrandedHoldContinuation 2026-08-02-00:15: 713e9320b0 routed continuation dispatch through createPlanningContinuationDispatcher, whose capacity gate reads projectId from store.getRootDir(); the mock must expose it so drainWorkflowContinuations does not throw.
    getRootDir: vi.fn(() => "fn8592-project"),
    _items: items,
  } as unknown as TaskStore & { _items: WorkflowWorkItem[] };
}

const PLAN = "# Task\n\n## Steps\n\n### Step 0: Real work";
const CHANGED_PLAN = `${PLAN}\n\n### Step 1: More work`;
const planIdentity = planReviewInputFingerprint(PLAN)!;
const RATE_LIMIT = { origin: "model-provider", code: "RATE_LIMIT" } as const;
const LOCK_UNAVAILABLE = "Plan approved but spec lock unavailable: mission-missing (mission).";

/** One Plan Review attempt that ended without a verdict on the unchanged plan. */
function noVerdictFailure(sequence: number, overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  const startedAt = new Date(Date.UTC(2026, 9, 10, 10, sequence * 5)).toISOString();
  return {
    workflowStepId: "plan-review", workflowStepName: "Plan Review", phase: "pre-merge", status: "failed",
    startedAt, completedAt: new Date(Date.parse(startedAt) + 16_000).toISOString(),
    output: `Plan Review failed before producing a verdict: reviewer session ended (attempt ${sequence})`,
    reviewInputFingerprint: planIdentity,
    ...overrides,
  } as WorkflowStepResult;
}

/** The stored Plan Review row after `priorCount` earlier attempts, newest first as the store keeps them. */
function planReviewRow(
  priorCount: number,
  latest: Partial<WorkflowStepResult> = {},
  prior: Partial<WorkflowStepResult> = {},
): WorkflowStepResult {
  const priorAttempts = Array.from({ length: priorCount }, (_unused, index) => noVerdictFailure(priorCount - 1 - index, prior));
  return { ...noVerdictFailure(priorCount, latest), ...(priorCount > 0 ? { priorAttempts } : {}) };
}

/*
FNXC:StrandedHoldContinuation 2026-07-26-16:55:
These fixtures reproduce the FN-8591 durable shape rather than an abort timing:
a real prompt plus no all-kind active continuation is sufficient for recovery.
They also pin the audit-noise boundary: healthy active ownership is silent.
*/
describe("FN-8592 stranded hold continuation recovery", () => {
  let root = "";
  beforeEach(async () => {
    vi.clearAllMocks();
    root = await mkdtemp(join(tmpdir(), "fusion-fn8592-"));
    resolveWorkflowIrForTaskMock.mockResolvedValue(workflow);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function writePrompt(id: string, text = "# Task\n\n## Steps\n\n### Step 0: Real work") {
    const dir = join(root, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "PROMPT.md"), text);
  }

  it("re-seeds a real-spec hold card and records ids-only recovery metadata", async () => {
    const task = strandedTask();
    const store = storeFor(task);
    store.getTasksDir.mockReturnValue(root);
    await writePrompt(task.id);
    const manager = new SelfHealingManager(store, { rootDir: root });

    await expect(manager.reconcileStrandedHoldContinuations()).resolves.toBe(1);
    expect(store.seedStrandedPlanReviewContinuation).toHaveBeenCalledOnce();
    expect(store.withPlanningLifecycleLock).toHaveBeenCalledWith(task.id, expect.any(Function));
    expect(store._items).toHaveLength(1);
    expect(recordRunAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "task:reconcile-stranded-hold-continuation",
      metadata: expect.objectContaining({ taskId: task.id, column: "holding-area" }),
    }));
    expect(JSON.stringify(recordRunAuditEventMock.mock.calls)).not.toContain("Real work");
  });

  it("defers the exact stale null-status persisted-plan episode to lifecycle recovery", () => {
    const stale = new Date(Date.now() - 31 * 60_000).toISOString();
    const task = strandedTask({
      status: null as never,
      steps: [{ name: "Persisted planner step", status: "pending" }],
      updatedAt: stale,
      columnMovedAt: stale,
    });

    expect(evaluateStrandedHoldContinuation({
      task,
      columnFlags: { hold: true, intake: true },
      ir: workflow,
      continuations: [],
      stepResults: [],
      effectiveSettings: {},
      enginePaused: false,
      promptContent: "# Task\n\n## Steps\n\n### Step 0: Persisted planner step",
      live: false,
      stalenessMs: 31 * 60_000,
      graceMs: 60_000,
      now: Date.now(),
    })).toMatchObject({ stranded: false, candidate: false, reason: "planning-recovery-owned" });
  });

  it("treats a Fast hold card as a non-candidate for Plan Review reseeding", () => {
    const task = strandedTask({ executionMode: "fast" });

    expect(evaluateStrandedHoldContinuation({
      task,
      columnFlags: { hold: true },
      ir: workflow,
      continuations: [],
      stepResults: [],
      effectiveSettings: {},
      enginePaused: false,
      promptContent: "# FN-8592-test: Real specification\n\nA Fast request",
      live: false,
      stalenessMs: 120_000,
      graceMs: 60_000,
    })).toMatchObject({ stranded: false, candidate: false, reason: "fast-lane" });
  });

  it("keeps ordinary null-status continuation recovery outside the conservative legacy shape", () => {
    const task = strandedTask({ status: null as never, steps: [] });

    expect(evaluateStrandedHoldContinuation({
      task,
      columnFlags: { hold: true, intake: true },
      ir: workflow,
      continuations: [],
      stepResults: [],
      effectiveSettings: {},
      enginePaused: false,
      promptContent: "# Task\n\n## Steps\n\n### Step 0: Ordinary continuation",
      live: false,
      stalenessMs: 120_000,
      graceMs: 60_000,
      now: Date.now(),
    })).toMatchObject({ stranded: true, candidate: true, reason: "ready" });
  });

  it("drives the repaired continuation through the runtime processor and graph reviewer seam", async () => {
    const task = strandedTask();
    const store = storeFor(task);
    store.getTasksDir.mockReturnValue(root);
    await writePrompt(task.id);
    const manager = new SelfHealingManager(store, { rootDir: root });
    // Optional groups run only when this task's resolved graph selection enables it.
    (task as any).enabledWorkflowSteps = ["plan-review"];

    expect(evaluateStrandedHoldContinuation({ task, columnFlags: { hold: true }, ir: workflow, continuations: [], stepResults: [], effectiveSettings: {}, enginePaused: false, promptContent: "# Task\\n\\n## Steps\\n\\n### Step 0: Real work", live: false, stalenessMs: 120_000, graceMs: 60_000 })).toMatchObject({ stranded: true });
    await expect(manager.reconcileStrandedHoldContinuations()).resolves.toBe(1);

    const reviewer = vi.fn(async () => ({ outcome: "success" as const, value: "APPROVE" }));
    const graph = new WorkflowGraphExecutor({
      handlers: { prompt: reviewer },
      recordWorkflowStepResult: async (_taskId, result) => {
        await store.updateTask(task.id, { workflowStepResults: [result] as any });
      },
    });
    // Invoke the production continuation drain, which selects the seeded row and
    // dispatches it to the graph executor; this is deliberately not a direct
    // reviewer call or a hand-written workflowStepResults fixture.
    const runtime = Object.create(InProcessRuntime.prototype) as any;
    runtime.status = "active";
    runtime.workflowContinuationDrainActive = false;
    runtime.taskStore = store;
    let dispatched!: Promise<unknown>;
    runtime.executor = { execute: vi.fn((dispatchedTask: Task) => {
      dispatched = graph.run(dispatchedTask as any, {} as any, workflow);
      return dispatched;
    }) };
    await runtime.drainWorkflowContinuations();
    await dispatched;

    expect(runtime.executor.execute).toHaveBeenCalledWith(task);
    expect(reviewer).toHaveBeenCalled();
    expect(task.workflowStepResults).toEqual([expect.objectContaining({ workflowStepId: "plan-review", status: "passed" })]);
    expect(evaluateStrandedHoldContinuation({ task, columnFlags: { hold: true }, ir: workflow, continuations: [], stepResults: task.workflowStepResults, effectiveSettings: {}, enginePaused: false, promptContent: "# Task\\n\\n## Steps\\n\\n### Step 0: Real work", live: false, stalenessMs: 120_000, graceMs: 60_000 })).toMatchObject({ candidate: false, reason: "plan-review-passed" });
  });

  it("silently skips a healthy active continuation of a non-task kind", async () => {
    const task = strandedTask();
    const store = storeFor(task);
    store.getTasksDir.mockReturnValue(root);
    store._items.push({ id: "step", taskId: task.id, kind: "workflow-step", state: "held" } as WorkflowWorkItem);
    await writePrompt(task.id);

    await expect(new SelfHealingManager(store, { rootDir: root }).reconcileStrandedHoldContinuations()).resolves.toBe(0);
    expect(store.seedStrandedPlanReviewContinuation).not.toHaveBeenCalled();
    expect(recordRunAuditEventMock).not.toHaveBeenCalled();
    expect(evaluateStrandedHoldContinuation({ task, columnFlags: { hold: true }, ir: workflow, continuations: store._items, stepResults: [], effectiveSettings: {}, enginePaused: false, promptContent: "real", live: false, stalenessMs: 120_000, graceMs: 60_000 })).toMatchObject({ candidate: false, reason: "active-continuation" });
  });

  it("audits but does not repair a globally paused candidate, then recovers once cleared", async () => {
    const task = strandedTask();
    const store = storeFor(task, { globalPause: true });
    store.getTasksDir.mockReturnValue(root);
    await writePrompt(task.id);
    const manager = new SelfHealingManager(store, { rootDir: root });

    await expect(manager.reconcileStrandedHoldContinuations()).resolves.toBe(0);
    expect(store.seedStrandedPlanReviewContinuation).not.toHaveBeenCalled();
    expect(recordRunAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: "task:reconcile-stranded-hold-continuation-no-action", metadata: expect.objectContaining({ reason: "engine-paused" }) }));
    await expect(manager.reconcileStrandedHoldContinuations()).resolves.toBe(0);
    expect(recordRunAuditEventMock).toHaveBeenCalledTimes(1);
    store.getSettings.mockResolvedValue({ globalPause: false, enginePaused: false } as Settings);
    await expect(manager.reconcileStrandedHoldContinuations()).resolves.toBe(1);
  });

  /*
  FNXC:ReviewRecovery 2026-10-12-02:05:
  A hold-lane Plan Review that keeps failing without a verdict gets one attempt plus three automatic retries per unchanged plan, counted from stored history.
  Then the card stops being re-seeded and becomes a visible failed row in its column with the last failure and the remedy.
  A changed plan starts a fresh budget, and provider rate-limit and spec-lock failures neither spend the budget nor stop here.
  */
  describe("bounded no-verdict Plan Review recovery", () => {
    async function holdCard(
      overrides: Partial<Task> = {},
      settings: Partial<Settings> = {},
      options: { isTaskActive?: (taskId: string) => boolean } = {},
    ) {
      const task = strandedTask({ prompt: PLAN, workflowStepResults: [planReviewRow(3)], ...overrides } as Partial<Task>);
      const store = storeFor(task, settings) as any;
      store.getTasksDir.mockReturnValue(root);
      await writePrompt(task.id);
      return { task, store, manager: new SelfHealingManager(store, { rootDir: root, ...options }) };
    }
    const noActionAudit = (task: Task, reason: string) => expect.objectContaining({
      type: "task:reconcile-stranded-hold-continuation-no-action",
      metadata: { taskId: task.id, column: task.column, reason },
    });

    it("parks an exhausted card failed in place and seeds nothing", async () => {
      const { task, store, manager } = await holdCard();
      const failureText = task.workflowStepResults![0]!.output!;

      await expect(manager.reconcileStrandedHoldContinuations()).resolves.toBe(0);

      expect(store.seedStrandedPlanReviewContinuation).not.toHaveBeenCalled();
      expect(task.status).toBe("failed");
      expect(task.error).toContain(failureText);
      expect(task.error).toContain("no verdict after 3 automatic retries on the unchanged plan");
      expect(task.error).toContain("'holding-area'");
      expect(task.error).toContain("Retry the task from the dashboard to re-plan it with a fresh review budget");
      expect(task.error).toContain("a changed plan also starts a fresh budget");
      expect(task.column).toBe("holding-area");
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(store.logEntry).toHaveBeenCalledOnce();
      expect(store.logEntry).toHaveBeenCalledWith(task.id, task.error, undefined, undefined);
      expect(store.withPlanningLifecycleLock).toHaveBeenCalledWith(task.id, expect.any(Function));
      expect(recordRunAuditEventMock).toHaveBeenCalledWith(noActionAudit(task, "no-verdict-recovery-exhausted"));
    });

    it("quotes the reviewer notes of the last failure when it has them", async () => {
      const { task, manager } = await holdCard({
        workflowStepResults: [planReviewRow(3, { notes: "Reviewer transport closed before the verdict", output: "raw session transcript" })],
      });

      await manager.reconcileStrandedHoldContinuations();

      expect(task.error).toContain("Last failure: Reviewer transport closed before the verdict.");
      expect(task.error).not.toContain("raw session transcript");
    });

    it("gives a changed plan a fresh budget, identified by the task artifact and not by the prompt file", async () => {
      // The prompt file on disk still holds the plan the failures were recorded on.
      const { task, store, manager } = await holdCard({ prompt: CHANGED_PLAN } as Partial<Task>);

      await expect(manager.reconcileStrandedHoldContinuations()).resolves.toBe(1);

      expect(store.seedStrandedPlanReviewContinuation).toHaveBeenCalledOnce();
      expect(task.status).toBeUndefined();
      expect(task.error).toBeUndefined();
      expect(store.updateTaskAtomic).not.toHaveBeenCalled();
    });

    it("keeps the budget spent when only the prompt file on disk differs from the reviewed plan", async () => {
      const { task, store, manager } = await holdCard();
      await writePrompt(task.id, CHANGED_PLAN);

      await expect(manager.reconcileStrandedHoldContinuations()).resolves.toBe(0);

      expect(store.seedStrandedPlanReviewContinuation).not.toHaveBeenCalled();
      expect(task.status).toBe("failed");
    });

    it.each([
      ["review history that an operator Retry discarded", () => []],
      ["two matching prior attempts", () => [planReviewRow(2)]],
      ["a genuine failure whose prior attempts were all rate-limited", () => [planReviewRow(3, {}, { providerFailure: RATE_LIMIT })]],
      ["a rate-limited latest failure after three genuine attempts", () => [planReviewRow(3, { providerFailure: RATE_LIMIT })]],
      ["a spec-lock rejection as the latest failure", () => [planReviewRow(3, { output: LOCK_UNAVAILABLE, notes: LOCK_UNAVAILABLE })]],
      ["history recorded before failures carried a plan identity", () => [{
        ...noVerdictFailure(4, { reviewInputFingerprint: undefined, output: "Plan Review failed before producing a verdict: failed" }),
        priorAttempts: [
          noVerdictFailure(3, { reviewInputFingerprint: undefined, output: "Plan Review failed before producing a verdict: failed" }),
          noVerdictFailure(2, { reviewInputFingerprint: undefined, providerFailure: RATE_LIMIT }),
          noVerdictFailure(1, { reviewInputFingerprint: undefined, output: LOCK_UNAVAILABLE, notes: LOCK_UNAVAILABLE }),
          noVerdictFailure(0, { reviewInputFingerprint: undefined, output: "Plan Review failed before producing a verdict: failed" }),
        ],
      }]],
    ] as const)("re-seeds and does not park %s", async (_label, results) => {
      const { task, store, manager } = await holdCard({ workflowStepResults: results() as WorkflowStepResult[] });

      await expect(manager.reconcileStrandedHoldContinuations()).resolves.toBe(1);

      expect(store.seedStrandedPlanReviewContinuation).toHaveBeenCalledOnce();
      expect(task.status).toBeUndefined();
      expect(task.error).toBeUndefined();
      expect(store.updateTaskAtomic).not.toHaveBeenCalled();
      expect(store.logEntry).not.toHaveBeenCalled();
    });

    it.each([
      ["a paused card", () => ({ paused: true }), {}, {}, "paused"],
      ["a card frozen on a provider rate limit", () => ({ paused: true, pausedReason: "provider-rate-limit:plan-review" }), {}, {}, "paused"],
      ["a user-paused card", () => ({ userPaused: true }), {}, {}, "paused"],
      ["a card awaiting plan approval", () => ({ status: "awaiting-approval" }), {}, {}, "awaiting-approval"],
      ["an engine pause", () => ({}), { enginePaused: true }, {}, "engine-paused"],
      ["a global pause", () => ({}), { globalPause: true }, {}, "engine-paused"],
      ["a live session", () => ({}), {}, { isTaskActive: () => true }, "live"],
      ["a card inside the grace window", () => ({ columnMovedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }), {}, {}, "too-fresh"],
      ["auto-merge Off", () => ({}), { autoMerge: false }, {}, "auto-merge-off"],
    ] as const)("lets %s keep precedence over the park", async (_label, overrides, settings, options, reason) => {
      const { task, store, manager } = await holdCard(overrides() as Partial<Task>, settings as Partial<Settings>, options);
      const statusBefore = task.status;

      await expect(manager.reconcileStrandedHoldContinuations()).resolves.toBe(0);

      expect(store.seedStrandedPlanReviewContinuation).not.toHaveBeenCalled();
      expect(store.updateTaskAtomic).not.toHaveBeenCalled();
      expect(store.logEntry).not.toHaveBeenCalled();
      expect(task.status).toBe(statusBefore);
      expect(task.error).toBeUndefined();
      expect(recordRunAuditEventMock).toHaveBeenCalledOnce();
      expect(recordRunAuditEventMock).toHaveBeenCalledWith(noActionAudit(task, reason));
    });

    it.each(["needs-replan", "planning"] as const)("leaves a %s card to triage without parking or auditing it", async (status) => {
      const { task, store, manager } = await holdCard({ status } as Partial<Task>);

      await expect(manager.reconcileStrandedHoldContinuations()).resolves.toBe(0);

      expect(store.seedStrandedPlanReviewContinuation).not.toHaveBeenCalled();
      expect(store.updateTaskAtomic).not.toHaveBeenCalled();
      expect(task.status).toBe(status);
      expect(recordRunAuditEventMock).not.toHaveBeenCalled();
    });

    it("parks once and leaves the parked card alone on later passes", async () => {
      const { task, store, manager } = await holdCard();
      await manager.reconcileStrandedHoldContinuations();
      const parkedError = task.error;

      await expect(manager.reconcileStrandedHoldContinuations()).resolves.toBe(0);
      await expect(new SelfHealingManager(store, { rootDir: root }).reconcileStrandedHoldContinuations()).resolves.toBe(0);

      expect(store.seedStrandedPlanReviewContinuation).not.toHaveBeenCalled();
      expect(store.updateTaskAtomic).toHaveBeenCalledOnce();
      expect(store.logEntry).toHaveBeenCalledOnce();
      expect(task.status).toBe("failed");
      expect(task.error).toBe(parkedError);
    });

    it("neither seeds nor rewrites a card that another owner already failed", async () => {
      const { task, store, manager } = await holdCard({ status: "failed", error: "Automatic recovery exhausted elsewhere" } as Partial<Task>);

      await expect(manager.reconcileStrandedHoldContinuations()).resolves.toBe(0);

      expect(store.seedStrandedPlanReviewContinuation).not.toHaveBeenCalled();
      expect(store.updateTaskAtomic).not.toHaveBeenCalled();
      expect(store.logEntry).not.toHaveBeenCalled();
      expect(task.error).toBe("Automatic recovery exhausted elsewhere");
    });

    it("does not park when a new review attempt claims the row before the lifecycle lock is taken", async () => {
      const { task, store, manager } = await holdCard();
      store.withPlanningLifecycleLock.mockImplementationOnce(async (_id: string, callback: () => Promise<unknown>) => {
        const [exhausted] = task.workflowStepResults!;
        const { priorAttempts, ...snapshot } = exhausted!;
        task.workflowStepResults = [{
          workflowStepId: "plan-review", workflowStepName: "Plan Review", phase: "pre-merge", status: "pending",
          startedAt: "2026-10-10T11:00:00.000Z", priorAttempts: [snapshot, ...(priorAttempts ?? [])],
        } as WorkflowStepResult];
        return callback();
      });

      await expect(manager.reconcileStrandedHoldContinuations()).resolves.toBe(0);

      expect(store.updateTaskAtomic).not.toHaveBeenCalled();
      expect(store.seedStrandedPlanReviewContinuation).not.toHaveBeenCalled();
      expect(task.status).toBeUndefined();
      expect(task.error).toBeUndefined();
    });

    it("does not park when a newer failed attempt replaces the row between the re-read and the write", async () => {
      const { task, store, manager } = await holdCard();
      store.updateTaskAtomic.mockImplementationOnce(async (_id: string, compute: (current: Task) => Partial<Task> | null) => {
        const patch = compute({ ...task, workflowStepResults: [planReviewRow(4)] } as Task);
        if (patch) Object.assign(task, patch);
        return task;
      });

      await expect(manager.reconcileStrandedHoldContinuations()).resolves.toBe(0);

      expect(store.updateTaskAtomic).toHaveBeenCalledOnce();
      expect(store.logEntry).not.toHaveBeenCalled();
      expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
      expect(task.status).toBeUndefined();
      expect(task.error).toBeUndefined();
    });

    it("still parks when the task log and every audit sink reject", async () => {
      const { task, store, manager } = await holdCard();
      store.logEntry.mockRejectedValue(new Error("log unavailable"));
      store.recordRunAuditEvent.mockRejectedValue(new Error("audit unavailable"));
      recordRunAuditEventMock.mockRejectedValueOnce(new Error("audit unavailable"));

      await expect(manager.reconcileStrandedHoldContinuations()).resolves.toBe(0);

      expect(recordRunAuditEventMock).toHaveBeenCalledOnce();
      expect(store.recordRunAuditEvent).toHaveBeenCalledOnce();
      expect(store.seedStrandedPlanReviewContinuation).not.toHaveBeenCalled();
      expect(task.status).toBe("failed");
      expect(task.error).toContain("no verdict after 3 automatic retries on the unchanged plan");
    });

    it("records the park with ids, counts and fixed outcomes only", async () => {
      const { task, store, manager } = await holdCard();
      const failureText = task.workflowStepResults![0]!.output!;

      await manager.reconcileStrandedHoldContinuations();

      expect(store.recordRunAuditEvent).toHaveBeenCalledOnce();
      expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        taskId: task.id,
        agentId: "self-healing",
        mutationType: "auto-recovery:retry-budget-escalated",
        target: task.id,
        metadata: { taskId: task.id, owner: "self-healing-plan-review-no-verdict", outcome: "parked", attempts: 3, column: "holding-area" },
      }));
      const audited = JSON.stringify([store.recordRunAuditEvent.mock.calls, recordRunAuditEventMock.mock.calls]);
      expect(audited).not.toContain(failureText);
      expect(audited).not.toContain("Real work");
      expect(audited).not.toContain(planIdentity);
    });

    it("stops re-dispatching an unchanged plan after three retries, and a restart does not reset the count", async () => {
      const { task, store } = await holdCard({ workflowStepResults: [planReviewRow(0)] });
      const graphWriter = {
        store,
        getRunContextFor: () => undefined,
        readTaskArtifact: (taskId: string, key: string) => readTaskArtifact({ store }, taskId, key),
      } as never;
      // The seeded review runs and dies without a verdict: its work item ends, and the graph recorder writes a lease and then the failure.
      const failSeededReviewWithoutVerdict = async (retry: number) => {
        for (const item of store._items as WorkflowWorkItem[]) item.state = "failed";
        const startedAt = new Date(Date.UTC(2026, 9, 10, 12, retry * 5)).toISOString();
        const lease = { workflowStepId: "plan-review", workflowStepName: "Plan Review", phase: "pre-merge", status: "pending", startedAt } as WorkflowStepResult;
        await persistWorkflowStepResultWithOutcome(graphWriter, task.id, lease);
        await persistWorkflowStepResultWithOutcome(graphWriter, task.id, {
          ...lease,
          status: "failed",
          completedAt: new Date(Date.parse(startedAt) + 16_000).toISOString(),
          output: `Plan Review failed before producing a verdict: reviewer session ended (retry ${retry})`,
        }, { requireAttemptStartedAt: startedAt });
      };

      let manager = new SelfHealingManager(store, { rootDir: root });
      const seededPerPass: number[] = [];
      for (let pass = 1; pass <= 10; pass++) {
        if (pass === 10) manager = new SelfHealingManager(store, { rootDir: root });
        const seeded = await manager.reconcileStrandedHoldContinuations();
        seededPerPass.push(seeded);
        if (seeded > 0) await failSeededReviewWithoutVerdict(pass);
      }

      expect(seededPerPass).toEqual([1, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
      expect(store.seedStrandedPlanReviewContinuation).toHaveBeenCalledTimes(3);
      expect(task.workflowStepResults![0]!.priorAttempts).toHaveLength(3);
      expect(task.column).toBe("holding-area");
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(task.status).toBe("failed");
      expect(task.error).toContain("reviewer session ended (retry 3)");
      expect(task.error).toContain("Retry the task from the dashboard to re-plan it with a fresh review budget");
    });

    it("reports the spent budget from the evaluator only for the current plan identity, after every other guard", () => {
      const task = strandedTask({ workflowStepResults: [planReviewRow(3)] });
      const input = {
        task, columnFlags: { hold: true }, ir: workflow, continuations: [], stepResults: task.workflowStepResults,
        effectiveSettings: {}, enginePaused: false, promptContent: PLAN, live: false, stalenessMs: 120_000, graceMs: 60_000,
      };

      expect(evaluateStrandedHoldContinuation({ ...input, planFingerprint: planIdentity }))
        .toEqual({ stranded: false, candidate: true, reason: "no-verdict-recovery-exhausted" });
      expect(evaluateStrandedHoldContinuation(input)).toEqual({ stranded: true, candidate: true, reason: "ready" });
      expect(evaluateStrandedHoldContinuation({ ...input, planFingerprint: planReviewInputFingerprint(CHANGED_PLAN) }))
        .toEqual({ stranded: true, candidate: true, reason: "ready" });
      expect(evaluateStrandedHoldContinuation({ ...input, planFingerprint: planIdentity, task: { ...task, paused: true } }))
        .toMatchObject({ stranded: false, reason: "paused" });
      expect(evaluateStrandedHoldContinuation({ ...input, planFingerprint: planIdentity, effectiveSettings: { autoMerge: false } }))
        .toMatchObject({ stranded: false, reason: "auto-merge-off" });
    });
  });
});
