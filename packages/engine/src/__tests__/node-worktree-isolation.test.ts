/*
FNXC:NodeWorktreeIsolation 2026-07-25-22:10 (no lane runs in the shared checkout — regression):
Operator requirement: Plan Review, Code Review, and every other node run in the TASK-SPECIFIC worktree;
the shared main checkout is for merge only. Before this, read-only graph gates fell back to
`this.rootDir` because a pre-execution task has no worktree yet. That is what let two tasks share one
path (the reported FN-1398/FN-1403 Plan Review session collision) and what let reviewers read a checkout
that other tasks and the operator mutate underneath them.

Invariant under test across the node surfaces that previously degraded to the root:
 - Plan Review (no worktree yet) acquires and runs in a task worktree;
 - a custom read-only gate (no worktree yet) does the same — this is not Plan-Review-special;
 - an existing usable worktree is REUSED, not re-acquired;
 - workspace Plan Review acquires every configured child checkout and runs from the task directory.
*/
import { describe, expect, it, vi, beforeEach } from "vitest";
import { join, sep } from "node:path";
import type { TaskDetail } from "@fusion/core";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { classifyTaskWorktree } from "../worktree/worktree-pool.js";
import { WORKFLOW_OPTIONAL_GROUP_CONTEXT_KEY, WORKFLOW_OPTIONAL_GROUP_PHASE_CONTEXT_KEY } from "../workflows/workflow-graph-executor.js";
import {
  createMockStore,
  mockedExecSync,
  mockedExistsSync,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

const ROOT = "/tmp/test";

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  const now = new Date().toISOString();
  return {
    id: "FN-1403",
    title: "Isolation",
    description: "Desc",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    worktree: undefined,
    branch: undefined,
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as TaskDetail;
}

const PLAN_REVIEW_NODE = {
  id: "plan-review-step",
  kind: "prompt",
  config: { name: "Plan Review", prompt: "Review the plan.", toolMode: "readonly", reviewKind: "plan" },
};
const CUSTOM_READONLY_GATE = {
  id: "custom-gate",
  kind: "prompt",
  config: { name: "Custom Gate", prompt: "Check something.", toolMode: "readonly" },
};

describe("every workflow node runs in the task worktree, never the shared checkout", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExecSync.mockReturnValue("" as any);
  });

  it.each([
    ["Plan Review", PLAN_REVIEW_NODE],
    ["a custom read-only gate", CUSTOM_READONLY_GATE],
  ])("acquires a task worktree for %s when the task has none", async (_label, node) => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, ROOT);
    mockedExistsSync.mockReturnValue(false);

    const captured: { worktreePath?: string } = {};
    vi.spyOn(executor as any, "executeWorkflowStep").mockImplementation(async (...args: any[]) => {
      captured.worktreePath = args[2];
      return { success: true, output: "APPROVE" };
    });

    const live = makeTask();
    store.getTask.mockResolvedValue(live as any);
    await (executor as any).runGraphCustomNode(node, live, { reviewerInlineFixes: false }, undefined);

    expect(captured.worktreePath).not.toBe(ROOT);
    expect(captured.worktreePath).toContain(join(ROOT, ".fusion", "worktrees") + sep);
  });

  it("reuses an existing usable worktree instead of acquiring another", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, ROOT);
    const existing = `${ROOT}/.worktrees/existing`;
    mockedExistsSync.mockReturnValue(true);

    const acquireSpy = vi.spyOn(executor as any, "ensureGraphCustomNodeWorktree");
    const captured: { worktreePath?: string } = {};
    vi.spyOn(executor as any, "executeWorkflowStep").mockImplementation(async (...args: any[]) => {
      captured.worktreePath = args[2];
      return { success: true, output: "APPROVE" };
    });

    const live = makeTask({ worktree: existing, branch: "fusion/fn-1403" });
    store.getTask.mockResolvedValue(live as any);
    await (executor as any).runGraphCustomNode(PLAN_REVIEW_NODE, live, {}, undefined);

    expect(captured.worktreePath).toBe(existing);
    expect(acquireSpy).not.toHaveBeenCalled();
  });

  it("uses a task directory and workspace boundary for workspace Plan Review", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, ROOT);
    (executor as any).workspaceConfig = { repos: ["apps/web"] };
    mockedExistsSync.mockReturnValue(true);

    const acquiredPath = `${ROOT}/.fusion/worktrees/fn-1403/apps/web`;
    const acquiredTask = makeTask({
      workspaceWorktrees: { "apps/web": { worktreePath: acquiredPath, branch: "fusion/fn-1403-apps-web" } },
    });
    const acquireSpy = vi.spyOn(executor as any, "ensureGraphCustomNodeWorktree").mockResolvedValue(acquiredTask);
    const captured: { worktreePath?: string; boundary?: unknown } = {};
    vi.spyOn(executor as any, "executeWorkflowStep").mockImplementation(async (...args: any[]) => {
      captured.worktreePath = args[2];
      captured.boundary = args[5]?.sessionBoundary;
      return { success: true, output: "APPROVE" };
    });

    const live = makeTask();
    store.getTask.mockResolvedValueOnce(live as any).mockResolvedValueOnce(live as any).mockResolvedValue(acquiredTask as any);
    await (executor as any).runGraphCustomNode(PLAN_REVIEW_NODE, live, {}, undefined);

    expect(captured.worktreePath).toBe(join(ROOT, ".fusion", "worktrees", "fn-1403"));
    expect(captured.boundary).toMatchObject({ kind: "workspace-task-dir", writableRoot: join(ROOT, ".fusion", "worktrees", "fn-1403"), projectRoot: ROOT });
    expect(acquireSpy).toHaveBeenCalledTimes(1);
  });
});

/*
FNXC:PostMergeRecovery 2026-10-07-05:29:
KB-003 invariant: a post-merge node on a LANDED card treats an absent, `.git`-less, or unregistered
recorded checkout as missing and re-acquires a fresh checkout at the integration branch. Healthy
checkouts are reused, unlanded cards and pre-merge nodes keep the fail-fast recorded path.
*/
describe("landed post-merge nodes re-acquire an unusable recorded worktree", () => {
  const POST_MERGE_GATE = {
    id: "post-merge-verification-inner",
    kind: "prompt",
    config: { name: "Post-merge verification", prompt: "Verify the landed result.", toolMode: "readonly" },
  };
  const POST_MERGE_CONTEXT = {
    [WORKFLOW_OPTIONAL_GROUP_CONTEXT_KEY]: "post-merge-verification",
    [WORKFLOW_OPTIONAL_GROUP_PHASE_CONTEXT_KEY]: "post-merge",
  };
  const recorded = `${ROOT}/.fusion/worktrees/fn-1403`;
  const acquiredPath = `${ROOT}/.fusion/worktrees/fn-1403-fresh`;
  const landed = { mergeConfirmed: true, commitSha: "abc123" };

  beforeEach(() => {
    resetExecutorMocks();
    mockedExecSync.mockReturnValue("" as any);
    mockedExistsSync.mockReturnValue(true);
    vi.mocked(classifyTaskWorktree).mockReset();
    vi.mocked(classifyTaskWorktree).mockResolvedValue({ ok: true });
  });

  function harness(task: TaskDetail, acquired: TaskDetail = makeTask({ worktree: acquiredPath, branch: "fusion/fn-1403", mergeDetails: landed } as any)) {
    const store = createMockStore();
    const executor = new TaskExecutor(store, ROOT);
    const acquireSpy = vi.spyOn(executor as any, "ensureGraphCustomNodeWorktree").mockResolvedValue(acquired);
    const captured: { worktreePath?: string } = {};
    vi.spyOn(executor as any, "executeWorkflowStep").mockImplementation(async (...args: any[]) => {
      captured.worktreePath = args[2];
      return { success: true, output: '{"verdict":"APPROVE"}' };
    });
    store.getTask.mockResolvedValue(task as any);
    return { store, executor, acquireSpy, captured };
  }

  it.each([
    ["incomplete", "missing .git metadata"],
    ["unregistered", "not registered in git worktree list"],
    ["missing", "worktree directory does not exist"],
  ] as const)("re-acquires a %s recorded worktree at the integration branch", async (classification, reason) => {
    const live = makeTask({ column: "in-review", worktree: recorded, branch: "fusion/fn-1403", executionStartBranch: "fusion/fn-1000", sessionFile: "/s.json", mergeDetails: landed } as any);
    const { executor, acquireSpy, captured } = harness(live);
    vi.mocked(classifyTaskWorktree).mockResolvedValueOnce({ ok: false, classification, reason });

    const result = await (executor as any).runGraphCustomNode(POST_MERGE_GATE, live, {}, undefined, POST_MERGE_CONTEXT);

    expect(acquireSpy).toHaveBeenCalledTimes(1);
    expect(acquireSpy.mock.calls[0]![0]).toMatchObject({ id: "FN-1403", worktree: undefined, sessionFile: undefined, executionStartBranch: undefined });
    expect(captured.worktreePath).toBe(acquiredPath);
    expect(result.outcome).toBe("success");
  });

  it("acquires at the integration branch when cleanup already cleared the pointer", async () => {
    const live = makeTask({ column: "in-review", worktree: undefined, branch: "fusion/fn-1403", executionStartBranch: "fusion/fn-1000", mergeDetails: landed } as any);
    const { executor, acquireSpy, captured } = harness(live);

    const result = await (executor as any).runGraphCustomNode(POST_MERGE_GATE, live, {}, undefined, POST_MERGE_CONTEXT);

    expect(acquireSpy).toHaveBeenCalledTimes(1);
    expect(acquireSpy.mock.calls[0]![0]).toMatchObject({ id: "FN-1403", worktree: undefined, executionStartBranch: undefined });
    expect(captured.worktreePath).toBe(acquiredPath);
    expect(result.outcome).toBe("success");
  });

  it("honours the node's own post-merge phase without graph context", async () => {
    const live = makeTask({ column: "in-review", worktree: recorded, mergeDetails: landed } as any);
    const { executor, acquireSpy } = harness(live);
    vi.mocked(classifyTaskWorktree).mockResolvedValueOnce({ ok: false, classification: "incomplete", reason: "missing .git metadata" });

    await (executor as any).runGraphCustomNode({ ...POST_MERGE_GATE, config: { ...POST_MERGE_GATE.config, phase: "post-merge" } }, live, {}, undefined, undefined);

    expect(acquireSpy).toHaveBeenCalledTimes(1);
  });

  it("reuses a healthy recorded worktree without acquisition", async () => {
    const live = makeTask({ column: "in-review", worktree: recorded, mergeDetails: landed } as any);
    const { executor, acquireSpy, captured } = harness(live);

    await (executor as any).runGraphCustomNode(POST_MERGE_GATE, live, {}, undefined, POST_MERGE_CONTEXT);

    expect(acquireSpy).not.toHaveBeenCalled();
    expect(captured.worktreePath).toBe(recorded);
  });

  it("keeps the recorded path when the card has not landed", async () => {
    const live = makeTask({ column: "in-review", worktree: recorded, mergeDetails: { mergeConfirmed: false } } as any);
    const { executor, acquireSpy, captured } = harness(live);
    vi.mocked(classifyTaskWorktree).mockResolvedValue({ ok: false, classification: "incomplete", reason: "missing .git metadata" });

    await (executor as any).runGraphCustomNode(POST_MERGE_GATE, live, {}, undefined, POST_MERGE_CONTEXT);

    expect(acquireSpy).not.toHaveBeenCalled();
    expect(captured.worktreePath).toBe(recorded);
  });

  it("keeps a pre-merge gate on its recorded path even when the checkout is unusable", async () => {
    const live = makeTask({ column: "in-review", worktree: recorded, mergeDetails: landed } as any);
    const { executor, acquireSpy, captured } = harness(live);
    vi.mocked(classifyTaskWorktree).mockResolvedValue({ ok: false, classification: "incomplete", reason: "missing .git metadata" });

    await (executor as any).runGraphCustomNode(CUSTOM_READONLY_GATE, live, {}, undefined, undefined);

    expect(acquireSpy).not.toHaveBeenCalled();
    expect(captured.worktreePath).toBe(recorded);
  });

  it("returns a recoverable failure instead of throwing when acquisition fails", async () => {
    const live = makeTask({ column: "in-review", worktree: recorded, mergeDetails: landed } as any);
    const { executor, acquireSpy, captured } = harness(live);
    acquireSpy.mockRejectedValue(Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" }));
    vi.mocked(classifyTaskWorktree).mockResolvedValueOnce({ ok: false, classification: "incomplete", reason: "missing .git metadata" });

    const result = await (executor as any).runGraphCustomNode(POST_MERGE_GATE, live, {}, undefined, POST_MERGE_CONTEXT);

    expect(result).toEqual({ outcome: "failure", value: "post-merge-checkout-unavailable" });
    expect(captured.worktreePath).toBeUndefined();
  });

  it("re-acquires a workspace post-merge node when one configured child is unusable", async () => {
    const child = `${ROOT}/.fusion/worktrees/fn-1403/apps/web`;
    const live = makeTask({
      column: "in-review",
      mergeDetails: landed,
      workspaceWorktrees: { "apps/web": { worktreePath: child, branch: "fusion/fn-1403-apps-web" } },
    } as any);
    const { executor, acquireSpy } = harness(live, live);
    (executor as any).workspaceConfig = { repos: ["apps/web"] };
    vi.mocked(classifyTaskWorktree).mockResolvedValueOnce({ ok: false, classification: "incomplete", reason: "missing .git metadata" });

    await (executor as any).runGraphCustomNode(POST_MERGE_GATE, live, {}, undefined, POST_MERGE_CONTEXT);

    expect(acquireSpy).toHaveBeenCalledTimes(1);
  });
});
