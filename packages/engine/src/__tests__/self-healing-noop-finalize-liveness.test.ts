/*
FNXC:SelfHealingNoOpFinalize 2026-10-12-12:33:
The no-op review finalize sweep parked a live no-commit card `failed` 14 s after it entered review: its graph run was still between Completion summary and Code Review, and the no-commits guard read the missing Code Review result as incomplete work.
These cases drive `finalizeNoOpReviewTasks` against an in-memory store with fake timers and a faked branch probe, so no git or real waits are involved.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore, WorkflowIr, WorkflowStepResult } from "@fusion/core";
import { getBuiltinWorkflow, resolveRequiredPreMergeStepIds } from "@fusion/core";

const isBranchAheadOfBase = vi.fn(async (..._args: unknown[]) => ({ aheadCount: 0, baseRef: "main" }));
vi.mock("../healing/self-healing-branch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../healing/self-healing-branch.js")>();
  return { ...actual, isBranchAheadOfBase: (...args: unknown[]) => isBranchAheadOfBase(...args) };
});

const classifyOwnedLandedEvidence = vi.fn(async (..._args: unknown[]) => ({ kind: "proven-no-op", baseRef: "main", ownDiffEmpty: true }));
vi.mock("../merger.js", () => ({
  classifyOwnedLandedEvidence: (...args: unknown[]) => classifyOwnedLandedEvidence(...args),
}));

vi.mock("../merge/integration-branch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../merge/integration-branch.js")>();
  return { ...actual, resolveIntegrationBranch: vi.fn(async () => "main") };
});

vi.mock("../merge/post-landing-worktree-cleanup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../merge/post-landing-worktree-cleanup.js")>();
  return { ...actual, cleanupLandedTaskWorktree: vi.fn(async () => ({ outcome: "removed", removed: true })) };
});

const auditRows: Array<{ type: string; target?: string; metadata?: Record<string, unknown> }> = [];
vi.mock("../util/run-audit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../util/run-audit.js")>();
  return {
    ...actual,
    createRunAuditor: vi.fn(() => ({
      database: vi.fn(async (row: { type: string; target?: string; metadata?: Record<string, unknown> }) => {
        auditRows.push(row);
      }),
      git: vi.fn(),
      filesystem: vi.fn(),
      sandbox: vi.fn(),
    })),
  };
});

import { SelfHealingManager } from "../self-healing.js";
import { activeSessionRegistry, executingTaskLock } from "../agents/active-session-registry.js";
import { RENAMED_VOCAB, lifecycleIr } from "./_workflow-vocabulary-fixture.js";

const NOW = Date.parse("2026-10-12T12:05:19.000Z");
const ENTERED_REVIEW = "2026-10-12T12:05:05.000Z";
const LONG_AGO = "2026-10-12T10:00:00.000Z";
const BLOCKED_AUDIT = "task:no-commits-finalize-blocked-incomplete-steps";
const LOST_WORK_AUDIT = "task:finalize-lost-work-blocked";
const RENAMED_WORKFLOW_ID = "noop-finalize-renamed";

/* The renamed board's review lane also carries a default-on Code Review optional group, so the required gate set is non-empty there too. */
const RENAMED_IR = (() => {
  const base = lifecycleIr(RENAMED_VOCAB, RENAMED_WORKFLOW_ID, { mergeOrchestration: true });
  return {
    ...base,
    nodes: [
      ...base.nodes,
      { id: "code-review", kind: "optional-group", column: RENAMED_VOCAB.review, config: { name: "Code Review", defaultOn: true, phase: "pre-merge" } },
    ],
  } as WorkflowIr;
})();

type WorkItem = { state: string };

interface Harness {
  store: TaskStore & EventEmitter;
  tasks: Map<string, Task>;
  settings: Partial<Settings>;
  moveTask: ReturnType<typeof vi.fn>;
  updateTask: ReturnType<typeof vi.fn>;
  updateTaskAtomic: ReturnType<typeof vi.fn>;
  logEntry: ReturnType<typeof vi.fn>;
  workItems: { current: WorkItem[] | Error | undefined };
  beforeAtomicUpdate: { current: (() => void) | undefined };
}

function makeHarness(initial: Task[], options: { renamed?: boolean; withSelection?: boolean; withWorkItemReader?: boolean } = {}): Harness {
  const tasks = new Map(initial.map((task) => [task.id, structuredClone(task)]));
  const settings: Partial<Settings> = { autoMerge: true, globalPause: false, enginePaused: false, taskStuckTimeoutMs: 600_000 };
  const workItems: Harness["workItems"] = { current: [] };
  const beforeAtomicUpdate: Harness["beforeAtomicUpdate"] = { current: undefined };
  const workflowId = options.renamed ? RENAMED_WORKFLOW_ID : "builtin:coding";
  const selection = { workflowId, stepIds: [] };

  const updateTask = vi.fn(async (id: string, patch: Partial<Task>) => {
    const next = { ...tasks.get(id)!, ...patch } as Task;
    tasks.set(id, next);
    return next;
  });
  const updateTaskAtomic = vi.fn(async (id: string, updater: (live: Task) => Partial<Task> | null) => {
    beforeAtomicUpdate.current?.();
    const live = tasks.get(id)!;
    const patch = updater(structuredClone(live));
    if (!patch) return live;
    const next = { ...live, ...patch } as Task;
    tasks.set(id, next);
    return next;
  });
  const moveTask = vi.fn(async (id: string, column: string) => {
    const next = { ...tasks.get(id)!, column } as Task;
    tasks.set(id, next);
    return next;
  });
  const logEntry = vi.fn(async () => undefined);

  const store = Object.assign(new EventEmitter(), {
    getSettings: vi.fn(async () => settings as Settings),
    listTasks: vi.fn(async (query?: { column?: string }) => {
      const all = [...tasks.values()].map((task) => structuredClone(task));
      return query?.column === undefined ? all : all.filter((task) => task.column === query.column);
    }),
    getTask: vi.fn(async (id: string) => structuredClone(tasks.get(id))),
    updateTask,
    updateTaskAtomic,
    moveTask,
    logEntry,
    recordRunAuditEvent: vi.fn(async () => undefined),
    ...(options.withSelection === false
      ? {}
      : {
        getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
        getTaskWorkflowSelection: vi.fn(() => selection),
      }),
    getWorkflowDefinition: vi.fn(async (id: string) => (id === RENAMED_WORKFLOW_ID ? { ir: RENAMED_IR } : undefined)),
    ...(options.renamed ? { listWorkflowDefinitions: vi.fn(async () => [{ ir: RENAMED_IR }]) } : {}),
    ...(options.withWorkItemReader === false
      ? {}
      : {
        listWorkflowWorkItemsForTask: vi.fn(async () => {
          if (workItems.current instanceof Error) throw workItems.current;
          return workItems.current;
        }),
      }),
  }) as unknown as TaskStore & EventEmitter;

  return { store, tasks, settings, moveTask, updateTask, updateTaskAtomic, logEntry, workItems, beforeAtomicUpdate };
}

function codeReview(status: WorkflowStepResult["status"]): WorkflowStepResult {
  return {
    workflowStepId: "code-review",
    workflowStepName: "Code Review",
    phase: "pre-merge",
    status,
    startedAt: "2026-10-12T12:05:44.000Z",
    completedAt: "2026-10-12T12:05:44.000Z",
  } as WorkflowStepResult;
}

/** A read-only verification card that expects no commits, shaped like the card in the motivating incident. */
function noCommitCard(overrides: Partial<Task> = {}): Task {
  return {
    id: "KB-NOOP",
    title: "read-only verification",
    description: "verify, change nothing",
    column: "in-review",
    status: null,
    paused: false,
    worktree: "worktrees/kb-noop",
    branch: "fusion/kb-noop",
    noCommitsExpected: true,
    enabledWorkflowSteps: ["code-review"],
    steps: [
      { name: "Preflight", status: "done" },
      { name: "Verify", status: "done" },
    ],
    currentStep: 2,
    workflowStepResults: [],
    dependencies: [],
    log: [],
    mergeDetails: undefined,
    createdAt: LONG_AGO,
    updatedAt: ENTERED_REVIEW,
    columnMovedAt: ENTERED_REVIEW,
    ...overrides,
  } as unknown as Task;
}

/** A no-commit card whose verification step was skipped: the no-commits guard must refuse it. */
function incompleteCard(overrides: Partial<Task> = {}): Task {
  return noCommitCard({
    id: "KB-SKIP",
    steps: [
      { name: "Preflight", status: "done" },
      { name: "Testing & Verification", status: "skipped" },
    ] as Task["steps"],
    workflowStepResults: [codeReview("passed")],
    columnMovedAt: LONG_AGO,
    updatedAt: LONG_AGO,
    ...overrides,
  });
}

function blockedAuditRows(type = BLOCKED_AUDIT) {
  return auditRows.filter((row) => row.type === type);
}

function expectUntouched(harness: Harness, id: string, column = "in-review") {
  const task = harness.tasks.get(id)!;
  expect(task.error ?? undefined).toBeUndefined();
  expect(task.status).not.toBe("failed");
  expect(task.column).toBe(column);
  expect(harness.moveTask).not.toHaveBeenCalled();
  expect(harness.updateTask).not.toHaveBeenCalled();
  expect(harness.updateTaskAtomic).not.toHaveBeenCalled();
  expect(harness.logEntry).not.toHaveBeenCalled();
  expect(blockedAuditRows()).toHaveLength(0);
  expect(blockedAuditRows(LOST_WORK_AUDIT)).toHaveLength(0);
}

function expectFinalized(harness: Harness, id: string, completeLane = "done") {
  const task = harness.tasks.get(id)!;
  expect(task.column).toBe(completeLane);
  expect(task.mergeDetails?.noOpMerge).toBe(true);
  expect(task.mergeDetails?.mergeConfirmed).toBe(true);
  expect(task.status ?? null).toBeNull();
  expect(blockedAuditRows()).toHaveLength(0);
}

function resetHarnessSpies(harness: Harness) {
  harness.moveTask.mockClear();
  harness.updateTask.mockClear();
  harness.updateTaskAtomic.mockClear();
  harness.logEntry.mockClear();
}

type LivenessSignal = {
  name: string;
  options?: (taskId: string) => ConstructorParameters<typeof SelfHealingManager>[1];
  apply?: (harness: Harness, taskId: string) => void;
};

const LIVENESS_SIGNALS: LivenessSignal[] = [
  { name: "an active session path", apply: (_harness, taskId) => activeSessionRegistry.registerPath(`worktrees/${taskId.toLowerCase()}`, { taskId, kind: "workflow-step", ownerKey: "test" }) },
  { name: "the executing-task lock", apply: (_harness, taskId) => { executingTaskLock.tryClaim(taskId); } },
  { name: "isTaskActive", options: (taskId) => ({ rootDir: "repo", isTaskActive: (id) => id === taskId }) },
  { name: "getExecutingTaskIds", options: (taskId) => ({ rootDir: "repo", getExecutingTaskIds: () => new Set([taskId]) }) },
  { name: "hasLiveSessionSurface", options: (taskId) => ({ rootDir: "repo", hasLiveSessionSurface: (id) => id === taskId }) },
  { name: "getActiveMergeTaskId", options: (taskId) => ({ rootDir: "repo", getActiveMergeTaskId: () => taskId }) },
  ...["runnable", "running", "held", "retrying"].map((state) => ({
    name: `a ${state} task work item`,
    apply: (harness: Harness) => { harness.workItems.current = [{ state }]; },
  })),
  { name: "an unreadable work-item list", apply: (harness) => { harness.workItems.current = new Error("database unavailable"); } },
];

describe("finalizeNoOpReviewTasks waits for a live or not-yet-reviewed card", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    auditRows.length = 0;
    isBranchAheadOfBase.mockClear();
    classifyOwnedLandedEvidence.mockClear();
    activeSessionRegistry.clear();
    executingTaskLock._clearForTest();
  });
  afterEach(() => {
    activeSessionRegistry.clear();
    executingTaskLock._clearForTest();
    vi.useRealTimers();
  });

  it("the builtin coding workflow requires Code Review when the card enables it", () => {
    /* Guard on the fixture: without a required gate the symptom cases below would pass vacuously. */
    const ir = getBuiltinWorkflow("builtin:coding")!.ir!;
    expect(resolveRequiredPreMergeStepIds(ir, ["code-review"]).has("code-review")).toBe(true);
    expect(resolveRequiredPreMergeStepIds(RENAMED_IR, ["code-review"]).has("code-review")).toBe(true);
  });

  it("defers a live no-commit card whose Code Review has not run, then finalizes it once Code Review passes", async () => {
    const harness = makeHarness([noCommitCard()]);
    let active = true;
    const manager = new SelfHealingManager(harness.store, { rootDir: "repo", isTaskActive: (id) => active && id === "KB-NOOP" });

    expect(await manager.finalizeNoOpReviewTasks()).toBe(0);
    expectUntouched(harness, "KB-NOOP");
    expect(isBranchAheadOfBase).not.toHaveBeenCalled();

    harness.tasks.set("KB-NOOP", { ...harness.tasks.get("KB-NOOP")!, workflowStepResults: [codeReview("passed")] });
    active = false;
    vi.setSystemTime(NOW + 25_000);

    expect(await manager.finalizeNoOpReviewTasks()).toBe(1);
    expectFinalized(harness, "KB-NOOP");
    manager.stop();
  });

  it("defers an idle no-commit card inside the grace window whose Code Review has not run, then finalizes it once Code Review passes", async () => {
    const harness = makeHarness([noCommitCard()]);
    const manager = new SelfHealingManager(harness.store, { rootDir: "repo" });

    expect(await manager.finalizeNoOpReviewTasks()).toBe(0);
    expectUntouched(harness, "KB-NOOP");

    harness.tasks.set("KB-NOOP", { ...harness.tasks.get("KB-NOOP")!, workflowStepResults: [codeReview("passed")] });
    expect(await manager.finalizeNoOpReviewTasks()).toBe(1);
    expectFinalized(harness, "KB-NOOP");
    manager.stop();
  });

  it("defers a dead-run card whose Code Review has not run even outside the grace window", async () => {
    const harness = makeHarness([noCommitCard({ columnMovedAt: LONG_AGO, updatedAt: LONG_AGO })]);
    const manager = new SelfHealingManager(harness.store, { rootDir: "repo" });

    expect(await manager.finalizeNoOpReviewTasks()).toBe(0);
    expectUntouched(harness, "KB-NOOP");
    expect(isBranchAheadOfBase).not.toHaveBeenCalled();
    manager.stop();
  });

  it("defers on a renamed review lane until Code Review passes, then finalizes into the renamed complete lane", async () => {
    const harness = makeHarness([noCommitCard({ column: RENAMED_VOCAB.review })], { renamed: true });
    const manager = new SelfHealingManager(harness.store, { rootDir: "repo", isTaskActive: () => false });

    expect(await manager.finalizeNoOpReviewTasks()).toBe(0);
    expectUntouched(harness, "KB-NOOP", RENAMED_VOCAB.review);

    harness.tasks.set("KB-NOOP", { ...harness.tasks.get("KB-NOOP")!, workflowStepResults: [codeReview("passed")] });
    expect(await manager.finalizeNoOpReviewTasks()).toBe(1);
    expectFinalized(harness, "KB-NOOP", RENAMED_VOCAB.complete);
    manager.stop();
  });

  describe.each(LIVENESS_SIGNALS)("a live run signalled by $name", (signal) => {
    it("defers a card whose gates passed", async () => {
      const harness = makeHarness([noCommitCard({ workflowStepResults: [codeReview("passed")] })]);
      signal.apply?.(harness, "KB-NOOP");
      const manager = new SelfHealingManager(harness.store, signal.options?.("KB-NOOP") ?? { rootDir: "repo" });

      expect(await manager.finalizeNoOpReviewTasks()).toBe(0);
      expectUntouched(harness, "KB-NOOP");
      manager.stop();
    });

    it("defers a genuinely incomplete card outside the grace window", async () => {
      const harness = makeHarness([incompleteCard()]);
      signal.apply?.(harness, "KB-SKIP");
      const manager = new SelfHealingManager(harness.store, signal.options?.("KB-SKIP") ?? { rootDir: "repo" });

      expect(await manager.finalizeNoOpReviewTasks()).toBe(0);
      expectUntouched(harness, "KB-SKIP");
      manager.stop();
    });
  });

  it.each(["succeeded", "failed", "cancelled", "exhausted", "manual-required"])("a %s work item does not veto finalization", async (state) => {
    const harness = makeHarness([noCommitCard({ workflowStepResults: [codeReview("passed")] })]);
    harness.workItems.current = [{ state }];
    const manager = new SelfHealingManager(harness.store, { rootDir: "repo" });

    expect(await manager.finalizeNoOpReviewTasks()).toBe(1);
    expectFinalized(harness, "KB-NOOP");
    manager.stop();
  });

  it("parks a genuinely incomplete idle card only after its grace window, with one audit row", async () => {
    const harness = makeHarness([incompleteCard({ columnMovedAt: ENTERED_REVIEW, updatedAt: ENTERED_REVIEW })]);
    const manager = new SelfHealingManager(harness.store, { rootDir: "repo" });

    expect(await manager.finalizeNoOpReviewTasks()).toBe(0);
    expectUntouched(harness, "KB-SKIP");

    vi.setSystemTime(Date.parse(ENTERED_REVIEW) + 600_000);
    expect(await manager.finalizeNoOpReviewTasks()).toBe(0);
    const parked = harness.tasks.get("KB-SKIP")!;
    expect(parked.status).toBe("failed");
    expect(parked.column).toBe("in-review");
    expect(parked.error).toMatch(/^Finalize blocked \(no-commits incomplete-work guard\): skipped verification step\(s\)/);
    expect(parked.error).toMatch(/Retry the task to re-run implementation\.$/);
    expect(blockedAuditRows()).toHaveLength(1);
    expect(harness.logEntry).toHaveBeenCalledWith("KB-SKIP", expect.stringContaining("Finalize blocked (no-commits incomplete-work guard)"), expect.any(String));
    expect(harness.moveTask).not.toHaveBeenCalled();
    manager.stop();
  });

  it("parks a lost-work card only after its grace window, with one audit row", async () => {
    const harness = makeHarness([noCommitCard({
      id: "KB-LOST",
      modifiedFiles: ["packages/engine/src/lost.ts"],
      workflowStepResults: [codeReview("passed")],
    })]);
    const manager = new SelfHealingManager(harness.store, { rootDir: "repo" });

    expect(await manager.finalizeNoOpReviewTasks()).toBe(0);
    expectUntouched(harness, "KB-LOST");

    vi.setSystemTime(Date.parse(ENTERED_REVIEW) + 600_000);
    expect(await manager.finalizeNoOpReviewTasks()).toBe(0);
    const parked = harness.tasks.get("KB-LOST")!;
    expect(parked.status).toBe("failed");
    expect(parked.error).toMatch(/^Finalize blocked \(lost-work guard\): task claims 1 modifiedFiles/);
    expect(blockedAuditRows(LOST_WORK_AUDIT)).toHaveLength(1);
    expect(blockedAuditRows()).toHaveLength(0);
    expect(harness.moveTask).not.toHaveBeenCalled();
    manager.stop();
  });

  it("applies the 10-minute default grace window when stuck detection is disabled", async () => {
    const harness = makeHarness([incompleteCard({ columnMovedAt: ENTERED_REVIEW, updatedAt: ENTERED_REVIEW })]);
    harness.settings.taskStuckTimeoutMs = 0;
    const manager = new SelfHealingManager(harness.store, { rootDir: "repo" });

    vi.setSystemTime(Date.parse(ENTERED_REVIEW) + 5 * 60_000);
    expect(await manager.finalizeNoOpReviewTasks()).toBe(0);
    expectUntouched(harness, "KB-SKIP");

    vi.setSystemTime(Date.parse(ENTERED_REVIEW) + 10 * 60_000);
    expect(await manager.finalizeNoOpReviewTasks()).toBe(0);
    expect(harness.tasks.get("KB-SKIP")!.status).toBe("failed");
    expect(blockedAuditRows()).toHaveLength(1);
    manager.stop();
  });

  it.each([
    { name: "the executor reports the task active", flip: (state: { active: boolean }, _harness: Harness) => { state.active = true; } },
    { name: "a running task work item appears", flip: (_state: { active: boolean }, harness: Harness) => { harness.workItems.current = [{ state: "running" }]; } },
  ])("does not park when $name during the branch probe", async ({ flip }) => {
    const harness = makeHarness([incompleteCard()]);
    const state = { active: false };
    const manager = new SelfHealingManager(harness.store, { rootDir: "repo", isTaskActive: (id) => state.active && id === "KB-SKIP" });
    isBranchAheadOfBase.mockImplementationOnce(async () => {
      flip(state, harness);
      return { aheadCount: 0, baseRef: "main" };
    });

    expect(await manager.finalizeNoOpReviewTasks()).toBe(0);
    expect(isBranchAheadOfBase).toHaveBeenCalledTimes(1);
    expectUntouched(harness, "KB-SKIP");
    manager.stop();
  });

  it("writes no log or audit row when the run turns live inside the atomic park", async () => {
    const harness = makeHarness([incompleteCard()]);
    let active = false;
    harness.beforeAtomicUpdate.current = () => { active = true; };
    const manager = new SelfHealingManager(harness.store, { rootDir: "repo", isTaskActive: (id) => active && id === "KB-SKIP" });

    expect(await manager.finalizeNoOpReviewTasks()).toBe(0);
    expect(harness.updateTaskAtomic).toHaveBeenCalledTimes(1);
    const task = harness.tasks.get("KB-SKIP")!;
    expect(task.status).not.toBe("failed");
    expect(task.error ?? undefined).toBeUndefined();
    expect(harness.updateTask).not.toHaveBeenCalled();
    expect(harness.logEntry).not.toHaveBeenCalled();
    expect(blockedAuditRows()).toHaveLength(0);
    manager.stop();
  });

  it("neither finalizes nor parks a card whose Code Review failed", async () => {
    const harness = makeHarness([noCommitCard({ workflowStepResults: [codeReview("failed")], columnMovedAt: LONG_AGO, updatedAt: LONG_AGO })]);
    const manager = new SelfHealingManager(harness.store, { rootDir: "repo" });

    expect(await manager.finalizeNoOpReviewTasks()).toBe(0);
    expectUntouched(harness, "KB-NOOP");
    expect(isBranchAheadOfBase).not.toHaveBeenCalled();
    manager.stop();
  });

  it("keeps finalizing a gates-passed card when the store has no workflow selection or work-item reader", async () => {
    const harness = makeHarness([noCommitCard({ enabledWorkflowSteps: undefined })], { withSelection: false, withWorkItemReader: false });
    const manager = new SelfHealingManager(harness.store, { rootDir: "repo" });

    expect(await manager.finalizeNoOpReviewTasks()).toBe(1);
    expectFinalized(harness, "KB-NOOP");
    manager.stop();
  });
});
