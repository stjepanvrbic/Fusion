/*
FNXC:ExternalBlockAutoResume 2026-10-08-08:29:
A rate-limit freeze schedules automatic resumes (5, 15, 30, 60, 120, 120 minutes; six at most) that re-enter through project admission,
emit ids/counts-only run-audit rows, and log one line per scheduled resume. Operator Retry works at any time and clears the budget.
A resumed frozen card waits for a running-agent slot: the freeze is cleared only by the admitted run.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRunningAgentTask, type Task, type TaskExternalBlock, type WorkflowWorkItem } from "@fusion/core";
import {
  clearExternalBlockForAdmittedResume,
  isExternalBlockResumeWorkItem,
  isQueuedExternalBlockResume,
  parkTaskOnExternalObstacle,
  requestExternalBlockResume,
  resumeDueExternalBlocks,
} from "../external-block/external-block-lifecycle.js";
import { EventEmitter } from "node:events";
import {
  InProcessRuntime,
  admitPlanningContinuation,
  createPlanningContinuationRun,
  resolvePlanningContinuationCandidate,
} from "../runtimes/in-process-runtime.js";
import { projectAdmissionCoordinator } from "../concurrency/concurrency.js";
import { deferReviewStepOnProviderRateLimit } from "../external-block/provider-rate-limit-deferral.js";

const IR = {
  version: "v2",
  name: "external-block-auto-resume",
  columns: [
    { id: "planning", name: "Planning", traits: [{ trait: "hold" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip" }] },
    { id: "review", name: "Review", traits: [{ trait: "human-review" }] },
    { id: "done", name: "Done", traits: [{ trait: "complete" }] },
  ],
  nodes: [
    { id: "start", kind: "start" },
    { id: "implement", kind: "execute", column: "building" },
    { id: "code-review", kind: "prompt", column: "review" },
  ],
  edges: [
    { from: "start", to: "implement" },
    { from: "implement", to: "code-review" },
  ],
} as never;

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-08T07:27:00.000Z");

function block(code: string, overrides: Partial<TaskExternalBlock> = {}): TaskExternalBlock {
  return {
    origin: code === "CREDENTIALS" ? "credentials" : "model-provider",
    code,
    message: `${code} raw provider text`,
    source: "session-failure",
    blockedAt: new Date(T0).toISOString(),
    resume: { column: "building", nodeId: "implement", currentStep: 1, worktree: "/worktrees/kb-046", branch: "fusion/kb-046" },
    ...overrides,
  };
}

function card(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    description: id,
    column: "building",
    dependencies: [],
    steps: [{ name: "Implementation", status: "in-progress" }],
    currentStep: 0,
    worktree: `/worktrees/${id.toLowerCase()}`,
    createdAt: "2026-10-08T06:00:00.000Z",
    updatedAt: "2026-10-08T06:00:00.000Z",
    ...overrides,
  } as Task;
}

/** In-memory store with TaskStore's null-clears-field update semantics. */
function createStore(initial: Task[]) {
  const rows = new Map(initial.map((task) => [task.id, structuredClone(task)]));
  const items: WorkflowWorkItem[] = [];
  const audits: Array<{ mutationType: string; metadata: Record<string, unknown> }> = [];
  const logs: Array<{ taskId: string; message: string }> = [];
  const store = {
    getRootDir: () => "/project",
    getSettings: vi.fn(async () => ({ maxConcurrent: 6, maxWorktrees: 9, worktreeLimitEnabled: true })),
    getTask: vi.fn(async (id: string) => structuredClone(rows.get(id)) as Task),
    listTasks: vi.fn(async () => [...rows.values()].map((task) => structuredClone(task))),
    updateTask: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const row = rows.get(id)! as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === undefined) delete row[key];
        else row[key] = structuredClone(value);
      }
      return structuredClone(row) as unknown as Task;
    }),
    logEntry: vi.fn(async (taskId: string, message: string) => { logs.push({ taskId, message }); }),
    withPlanningLifecycleLock: vi.fn(async <T>(_id: string, work: () => Promise<T>) => await work()),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "wf-external-block", stepIds: [] })),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "wf-external-block", stepIds: [] })),
    getWorkflowDefinition: vi.fn(async () => ({ id: "wf-external-block", name: "External block", ir: IR })),
    listWorkflowWorkItemsForTask: vi.fn(async (taskId: string) => items.filter((item) => item.taskId === taskId).map((item) => ({ ...item }))),
    replaceActiveTaskWorkflowContinuation: vi.fn(async (input: Record<string, unknown>) => {
      for (const item of items) {
        if (item.taskId === input.taskId && ["runnable", "running", "held", "retrying"].includes(item.state)) item.state = "cancelled";
      }
      const item = { id: `continuation-${items.length}`, attempt: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...input } as unknown as WorkflowWorkItem;
      items.push(item);
      return item;
    }),
    getWorkflowWorkItem: vi.fn(async (id: string) => items.find((item) => item.id === id) ?? null),
    transitionWorkflowWorkItem: vi.fn(async (id: string, state: WorkflowWorkItem["state"]) => {
      const item = items.find((candidate) => candidate.id === id);
      if (item) item.state = state;
      return item ?? null;
    }),
    recordRunAuditEvent: vi.fn(async (event: { mutationType: string; metadata: Record<string, unknown> }) => { audits.push(event); }),
  };
  return { store, rows, items, audits, logs };
}

async function park(env: ReturnType<typeof createStore>, taskId: string, code: string) {
  const live = await env.store.getTask(taskId);
  await parkTaskOnExternalObstacle({
    store: env.store as never,
    task: live,
    externalBlock: block(code),
    logMessage: `External session obstacle frozen (model-provider/${code}); worktree and execution progress retained for Retry`,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  projectAdmissionCoordinator.clearReservationsForTests();
});

afterEach(() => {
  projectAdmissionCoordinator.clearReservationsForTests();
  vi.useRealTimers();
});

describe("rate-limit freeze automatic resume", () => {
  it("schedules a resume at the backoff, resumes on the timer, and stops after the budget", async () => {
    const env = createStore([card("KB-046")]);
    const delays: number[] = [];

    for (let cycle = 1; cycle <= 6; cycle += 1) {
      const parkedAt = Date.now();
      await park(env, "KB-046", "RATE_LIMIT");
      const frozen = env.rows.get("KB-046")!;
      expect(frozen.externalBlock?.autoResume?.attempt).toBe(cycle);
      const resumeAt = Date.parse(frozen.externalBlock!.autoResume!.resumeAt);
      delays.push((resumeAt - parkedAt) / MINUTE);

      // Not due yet: the sweep leaves the freeze alone.
      vi.setSystemTime(resumeAt - 1);
      expect(await resumeDueExternalBlocks({ store: env.store as never, tasks: [frozen] })).toEqual([]);

      vi.setSystemTime(resumeAt);
      expect(await resumeDueExternalBlocks({ store: env.store as never, tasks: [frozen] })).toEqual(["KB-046"]);
      const requested = env.rows.get("KB-046")!;
      // Requested, not running: the freeze stays raised until admission grants a slot.
      expect(requested.externalBlock?.resumeRequest).toEqual({ requestedAt: new Date(resumeAt).toISOString(), trigger: "automatic" });
      expect(requested.externalBlock?.autoResume).toBeUndefined();
      expect(requested.externalBlockAutoResumeCount).toBe(cycle);
      expect(isRunningAgentTask(requested)).toBe(false);
      const continuation = env.items.at(-1)!;
      expect(continuation).toMatchObject({ nodeId: "implement", state: "runnable", targetColumn: "building" });
      expect(isExternalBlockResumeWorkItem(continuation)).toBe(true);

      // Admission granted: the run clears the freeze, then the session hits the rate limit again.
      await clearExternalBlockForAdmittedResume({ store: env.store as never, taskId: "KB-046", nodeId: "implement" });
      expect(env.rows.get("KB-046")!.externalBlock).toBeUndefined();
    }
    expect(delays).toEqual([5, 15, 30, 60, 120, 120]);

    await park(env, "KB-046", "RATE_LIMIT");
    const exhausted = env.rows.get("KB-046")!;
    expect(exhausted.externalBlock?.autoResume).toBeUndefined();
    vi.setSystemTime(Date.now() + 24 * 60 * MINUTE);
    expect(await resumeDueExternalBlocks({ store: env.store as never, tasks: [exhausted] })).toEqual([]);

    const scheduled = env.audits.filter((event) => event.mutationType === "task:external-block-auto-resume-scheduled");
    expect(scheduled.map((event) => event.metadata.outcome)).toEqual([...Array(6).fill("scheduled"), "budget-exhausted"]);
    expect(scheduled[0]!.metadata).toEqual({ taskId: "KB-046", code: "RATE_LIMIT", attempt: 1, budget: 6, delayMs: 5 * MINUTE, outcome: "scheduled" });
    const executed = env.audits.filter((event) => event.mutationType === "task:external-block-auto-resume-executed");
    expect(executed.map((event) => event.metadata.attempt)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(executed[0]!.metadata).toEqual({
      taskId: "KB-046", origin: "model-provider", code: "RATE_LIMIT", attempt: 1, budget: 6, column: "building", resumeNodeId: "implement",
    });
    // Run-audit stays ids/counts/outcomes only: the raw provider text never leaves the task row.
    expect(JSON.stringify(env.audits)).not.toContain("raw provider text");
    // One task-log line per scheduled resume.
    expect(env.logs.filter((entry) => entry.message.startsWith("Automatic resume ") && entry.message.includes("scheduled in"))).toHaveLength(6);
    expect(env.logs.some((entry) => entry.message.includes("Automatic resume budget spent"))).toBe(true);
  });

  it.each(["CREDENTIALS", "USAGE_LIMIT", "ENOSPC"])("keeps a %s freeze waiting for an operator", async (code) => {
    const env = createStore([card("KB-047")]);
    await park(env, "KB-047", code);
    const frozen = env.rows.get("KB-047")!;
    expect(frozen.externalBlock?.autoResume).toBeUndefined();
    vi.setSystemTime(T0 + 24 * 60 * MINUTE);
    expect(await resumeDueExternalBlocks({ store: env.store as never, tasks: [frozen] })).toEqual([]);
    expect(env.items).toEqual([]);
    expect(env.audits.map((event) => event.mutationType)).toEqual(["task:external-block-parked"]);
    expect(env.logs.some((entry) => entry.message.includes("Automatic resume"))).toBe(false);
  });

  it("lets operator Retry resume at any time and clears the automatic budget", async () => {
    const env = createStore([card("KB-048", { externalBlockAutoResumeCount: 3 })]);
    await park(env, "KB-048", "RATE_LIMIT");
    expect(env.rows.get("KB-048")!.externalBlock?.autoResume?.attempt).toBe(4);

    const result = await requestExternalBlockResume({ store: env.store as never, taskId: "KB-048", trigger: "operator" });
    expect(result).toMatchObject({ kind: "requested", nodeId: "implement" });
    const requested = env.rows.get("KB-048")!;
    expect(requested.externalBlockAutoResumeCount).toBe(0);
    expect(requested.externalBlock?.autoResume).toBeUndefined();
    expect(requested.externalBlock?.resumeRequest?.trigger).toBe("operator");
    expect(await requestExternalBlockResume({ store: env.store as never, taskId: "KB-048", trigger: "operator" })).toMatchObject({ kind: "already-requested" });
    expect(env.items).toHaveLength(1);
  });

  it("keeps operator Retry queued at a full running-agent cap", async () => {
    const running = ["KB-001", "KB-002", "KB-003", "KB-004", "KB-005", "KB-006"].map((id) => card(id));
    const env = createStore([...running, card("KB-047")]);
    await park(env, "KB-047", "RATE_LIMIT");

    expect(await requestExternalBlockResume({ store: env.store as never, taskId: "KB-047", trigger: "operator" })).toMatchObject({ kind: "requested" });
    const queued = env.rows.get("KB-047")!;
    expect(queued.status).toBe("blocked");
    expect(queued.externalBlock?.resumeRequest?.trigger).toBe("operator");
    expect(isRunningAgentTask(queued)).toBe(false);
    expect(await requestExternalBlockResume({ store: env.store as never, taskId: "KB-047", trigger: "operator" })).toMatchObject({ kind: "already-requested" });
    expect(projectAdmissionCoordinator.inspectProjectStateForTests("/project").reservedCount).toBe(0);
  });

  it("lets operator Retry take over a pending automatic resume without publishing a second continuation", async () => {
    const env = createStore([card("KB-049", { externalBlockAutoResumeCount: 2 })]);
    await park(env, "KB-049", "RATE_LIMIT");
    vi.setSystemTime(Date.parse(env.rows.get("KB-049")!.externalBlock!.autoResume!.resumeAt));
    await resumeDueExternalBlocks({ store: env.store as never, tasks: [env.rows.get("KB-049")!] });
    expect(env.rows.get("KB-049")!.externalBlockAutoResumeCount).toBe(3);

    expect(await requestExternalBlockResume({ store: env.store as never, taskId: "KB-049", trigger: "operator" })).toMatchObject({ kind: "requested" });
    expect(env.rows.get("KB-049")!.externalBlock?.resumeRequest?.trigger).toBe("operator");
    expect(env.rows.get("KB-049")!.externalBlockAutoResumeCount).toBe(0);
    expect(env.items).toHaveLength(1);
  });
});

/*
FNXC:WorktreeCapacity 2026-10-08-18:22:
KB-092 audit verdict: the synchronous operator-Retry resume is an audited admission owner. It builds its ceilings only via
projectCapacityAdmissionLimits, so worktrees-off constructs no worktree ceiling there and other frozen checkouts can never hold the Retry;
worktrees-on (explicit or omitted) still counts them, with the resuming card's own checkout discounted.
*/
describe("synchronous operator Retry honors the worktree capacity mode", () => {
  const OTHER_FROZEN = ["KB-010", "KB-011", "KB-012"];

  /** One running card, three other frozen checkout holders, and the frozen card the operator retries. */
  async function frozenBoard(settings: Record<string, unknown>) {
    const env = createStore([card("KB-001"), ...OTHER_FROZEN.map((id) => card(id)), card("KB-020")]);
    for (const id of [...OTHER_FROZEN, "KB-020"]) await park(env, id, "RATE_LIMIT");
    env.store.getSettings.mockResolvedValue(settings as never);
    const holders = await projectCapacityHoldersFromStore(env.store as never, [...env.rows.values()]);
    expect(holders.runningTaskIds).toEqual(["KB-001"]);
    expect([...holders.checkoutOnlyHolderTaskIds].sort()).toEqual([...OTHER_FROZEN, "KB-020"]);
    return env;
  }

  async function expectUnfrozen(env: ReturnType<typeof createStore>) {
    const resumed = env.rows.get("KB-020")!;
    expect(resumed.externalBlock).toBeUndefined();
    expect((await projectCapacityHoldersFromStore(env.store as never, [resumed])).runningTaskIds).toEqual(["KB-020"]);
    expect(projectAdmissionCoordinator.inspectProjectStateForTests("/project").reservedCount).toBe(0);
  }

  function expectQueued(env: ReturnType<typeof createStore>) {
    const queued = env.rows.get("KB-020")!;
    expect(queued.status).toBe("blocked");
    expect(queued.externalBlock?.resumeRequest?.trigger).toBe("operator");
    expect(isRunningAgentTask(queued)).toBe(false);
    expect(projectAdmissionCoordinator.inspectProjectStateForTests("/project").reservedCount).toBe(0);
  }

  it("never lets frozen checkouts bind when worktrees are off, even under a tiny maxWorktrees", async () => {
    const env = await frozenBoard({ maxConcurrent: 6, maxWorktrees: 1, worktreeLimitEnabled: false });
    expect(await requestExternalBlockResume({ store: env.store as never, taskId: "KB-020", trigger: "operator" })).toMatchObject({ kind: "requested" });
    await expectUnfrozen(env);
  });

  it("keeps the same Retry queued when worktrees are on and the worktree ceiling is saturated", async () => {
    // running 1 + other frozen checkouts 3 = 4 occupied; the resuming card reuses its own checkout, so maxWorktrees 4 binds.
    const env = await frozenBoard({ maxConcurrent: 6, maxWorktrees: 4, worktreeLimitEnabled: true });
    expect(await requestExternalBlockResume({ store: env.store as never, taskId: "KB-020", trigger: "operator" })).toMatchObject({ kind: "requested" });
    expectQueued(env);
  });

  it("binds on the worktree dimension: one more worktree lets the same Retry unfreeze", async () => {
    const env = await frozenBoard({ maxConcurrent: 6, maxWorktrees: 5, worktreeLimitEnabled: true });
    expect(await requestExternalBlockResume({ store: env.store as never, taskId: "KB-020", trigger: "operator" })).toMatchObject({ kind: "requested" });
    await expectUnfrozen(env);
  });

  it("treats an omitted worktreeLimitEnabled as on", async () => {
    const env = await frozenBoard({ maxConcurrent: 6, maxWorktrees: 4 });
    expect(await requestExternalBlockResume({ store: env.store as never, taskId: "KB-020", trigger: "operator" })).toMatchObject({ kind: "requested" });
    expectQueued(env);
  });

  it("unfreezes an operator takeover of a pending automatic resume when worktrees are off", async () => {
    const env = await frozenBoard({ maxConcurrent: 6, maxWorktrees: 1, worktreeLimitEnabled: false });
    vi.setSystemTime(Date.parse(env.rows.get("KB-020")!.externalBlock!.autoResume!.resumeAt));
    expect(await resumeDueExternalBlocks({ store: env.store as never, tasks: [env.rows.get("KB-020")!] })).toEqual(["KB-020"]);
    // Automatic resumes never admit synchronously.
    expect(env.rows.get("KB-020")!.externalBlock?.resumeRequest?.trigger).toBe("automatic");
    expect(await requestExternalBlockResume({ store: env.store as never, taskId: "KB-020", trigger: "operator" })).toMatchObject({ kind: "requested" });
    await expectUnfrozen(env);
  });
});

describe("a resumed frozen card re-enters through project admission", () => {
  it("offers the resume continuation only once a resume was requested", async () => {
    const env = createStore([card("KB-050")]);
    await park(env, "KB-050", "CREDENTIALS");
    const strayItem = { id: "stray", kind: "task", runId: "KB-050:plain", nodeId: "implement", state: "runnable" } as WorkflowWorkItem;
    expect(resolvePlanningContinuationCandidate(strayItem, env.rows.get("KB-050")!)).toMatchObject({ kind: "skip", reason: "paused" });

    await requestExternalBlockResume({ store: env.store as never, taskId: "KB-050", trigger: "operator" });
    const resumeItem = env.items.at(-1)!;
    expect(resolvePlanningContinuationCandidate(resumeItem, env.rows.get("KB-050")!)).toMatchObject({ kind: "actionable" });
  });

  it("waits while the running-agent cap is full and clears the freeze only when admitted", async () => {
    const running = ["KB-001", "KB-002", "KB-003", "KB-004", "KB-005", "KB-006"].map((id) => card(id));
    const env = createStore([...running, card("KB-046")]);
    await park(env, "KB-046", "RATE_LIMIT");
    await requestExternalBlockResume({ store: env.store as never, taskId: "KB-046", trigger: "operator" });
    const item = env.items.at(-1)!;
    const executed: Task[] = [];
    const run = createPlanningContinuationRun({
      store: env.store as never,
      execute: async (task) => { executed.push(task); },
    });
    const admit = async () => admitPlanningContinuation({
      store: env.store as never,
      projectId: "/project",
      task: env.rows.get("KB-046")!,
      item,
      dispatch: () => run(env.rows.get("KB-046")!, item),
    });

    expect(await admit()).toBe(false);
    expect(executed).toEqual([]);
    expect(env.rows.get("KB-046")!.status).toBe("blocked");
    expect(env.logs.some((entry) => entry.taskId === "KB-046" && entry.message.includes("maxConcurrent capacity exhausted: used=6/6"))).toBe(true);
    expect(env.logs.find((entry) => entry.message.includes("capacity exhausted"))!.message).not.toContain("KB-046");

    env.rows.delete("KB-006");
    expect(await admit()).toBe(true);
    await vi.waitFor(() => expect(executed).toHaveLength(1));
    expect(executed[0]).toMatchObject({ id: "KB-046", paused: false });
    expect(executed[0]!.status).toBeUndefined();
    expect(executed[0]!.externalBlock).toBeUndefined();
    expect(env.audits.find((event) => event.mutationType === "task:external-block-cleared")!.metadata).toMatchObject({
      taskId: "KB-046", code: "RATE_LIMIT", resumeNodeId: "implement", trigger: "operator",
    });
  });

  /*
  FNXC:ProviderRateLimitDeferral 2026-10-08-16:05:
  KB-077: a review step frozen on a provider rate limit resumes through the same schedule and admission as an executor freeze, at its
  own review node in its own lane.
  */
  it("resumes a rate-limited Code Review freeze at code-review in the review lane and clears it only on admission", async () => {
    const env = createStore([card("KB-066", {
      column: "review",
      workflowStepResults: [{
        workflowStepId: "code-review", workflowStepName: "Code Review", phase: "pre-merge", status: "failed",
        output: "Code Review failed before producing a verdict: 429 Too Many Requests",
        providerFailure: { origin: "model-provider", code: "RATE_LIMIT" },
      }],
    })]);
    const result = env.rows.get("KB-066")!.workflowStepResults![0]!;
    expect(await deferReviewStepOnProviderRateLimit({ store: env.store as never, taskId: "KB-066", result, nowMs: T0 })).toMatchObject({ deferred: true });

    vi.setSystemTime(T0 + 5 * MINUTE);
    expect(await resumeDueExternalBlocks({ store: env.store as never, tasks: [...env.rows.values()] })).toEqual(["KB-066"]);
    const item = env.items.at(-1)!;
    expect(item).toMatchObject({ nodeId: "code-review", sourceColumn: "review", targetColumn: "review" });

    const executed: Task[] = [];
    const run = createPlanningContinuationRun({ store: env.store as never, execute: async (task) => { executed.push(task); } });
    expect(await admitPlanningContinuation({
      store: env.store as never,
      projectId: "/project",
      task: env.rows.get("KB-066")!,
      item,
      dispatch: () => run(env.rows.get("KB-066")!, item),
    })).toBe(true);
    await vi.waitFor(() => expect(executed).toHaveLength(1));
    expect(executed[0]).toMatchObject({ id: "KB-066", column: "review", paused: false });
    expect(executed[0]!.status).toBeUndefined();
    expect(executed[0]!.externalBlock).toBeUndefined();
  });
});

/*
FNXC:ExternalBlockResume 2026-10-08-17:40:
Operator Retry only queues the resume (KB-083's S21 harness owns the admission definition), so the task update that records the request
must kick the continuation drain: a free slot then clears the card within about one drain tick instead of at the next periodic pass.
*/
describe("a queued external-block resume kicks the continuation drain", () => {
  it("kicks on the update that records the request, and only for a queued freeze", async () => {
    const env = createStore([card("KB-050")]);
    await park(env, "KB-050", "RATE_LIMIT");
    const frozen = structuredClone(env.rows.get("KB-050")!);
    await requestExternalBlockResume({ store: env.store as never, taskId: "KB-050", trigger: "operator" });
    const queued = structuredClone(env.rows.get("KB-050")!);
    expect(isQueuedExternalBlockResume(frozen)).toBe(false);
    expect(isQueuedExternalBlockResume(queued)).toBe(true);
    expect(isQueuedExternalBlockResume({ ...queued, status: undefined })).toBe(false);

    const store = new EventEmitter();
    const runtime = new InProcessRuntime({
      projectId: "test-project",
      projectName: "Test",
      workingDirectory: "/test/project",
      isolationMode: "in-process",
    }, {} as never);
    (runtime as unknown as { taskStore: unknown }).taskStore = store;
    const kick = vi.spyOn(runtime as never, "kickWorkflowContinuationProcessor").mockImplementation(() => undefined);
    (runtime as unknown as { setupEventForwarding(): void }).setupEventForwarding();

    store.emit("task:updated", frozen);
    store.emit("task:updated", card("KB-051"));
    expect(kick).not.toHaveBeenCalled();
    store.emit("task:updated", queued);
    expect(kick).toHaveBeenCalledOnce();
  });
});

