/*
FNXC:ReviewFailureReason 2026-10-12-03:04:
A review step whose session fails with an empty error message, or rejects with a value that is not an Error, must record a specific reason.
Before the fix the stored step result read "Plan Review failed before producing a verdict: failed" (or ": undefined"), with no provider classification even when the error's cause was a 429.
The graph cases drive the real step executor, the real graph custom-node runner and the real graph recorder; the step-executor cases cover all four review steps at the shared session catch.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { postMergeVerificationOptionalGroupNode, type Settings, type TaskDetail, type WorkflowIr, type WorkflowIrNode, type WorkflowStepResult } from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import { createMockStore, mockedCreateFnAgent, mockedExecSync, resetExecutorMocks } from "./executor-test-helpers.js";
import { runGraphCustomNode, toWorkspaceRepoReviewResult } from "../executor/run-graph-custom-node.js";
import { WorkflowGraphExecutor, type WorkflowNodeHandler } from "../workflows/workflow-graph-executor.js";
import { describeFailure } from "../errors/describe-failure.js";

/* The executor test helpers mock node:fs, so the worktree is a path only; no filesystem is touched. */
const WORKTREE = "/tmp/kb-145-wt";
const EMPTY_SESSION = "Agent session failed without an error message";
const EMPTY_NODE = "Workflow node failed without an error message";
const PLAN_REVIEW_PREFIX = "Plan Review failed before producing a verdict: ";

/** A rejection reply rejects that session's prompt with exactly `value`; a string streams as the reviewer's text. */
type Reply = string | { reject: unknown };

function installSessions(replies: Reply[]) {
  let created = 0;
  mockedCreateFnAgent.mockImplementation(async () => {
    const reply = replies[Math.min(created++, replies.length - 1)];
    const listeners: Array<(event: unknown) => void> = [];
    const session = {
      state: {},
      subscribe: (listener: (event: unknown) => void) => {
        listeners.push(listener);
        return () => {};
      },
      prompt: vi.fn(async () => {
        if (typeof reply !== "string") throw reply.reject;
        for (const listener of listeners) {
          listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: reply } });
        }
      }),
      dispose: vi.fn(),
    };
    return { session } as never;
  });
}

function reviewTask(enabledWorkflowSteps: string[]): TaskDetail {
  const now = new Date().toISOString();
  return {
    id: "KB-145-T",
    title: "Empty review session error",
    description: "Empty review session error",
    column: "todo",
    priority: "normal",
    worktree: WORKTREE,
    branch: "fusion/kb-145-t",
    baseCommitSha: "abc123",
    dependencies: [],
    steps: [{ name: "Implement", status: "done" }],
    currentStep: 0,
    log: [],
    enabledWorkflowSteps,
    workflowStepResults: [],
    createdAt: now,
    updatedAt: now,
  } as unknown as TaskDetail;
}

function newExecutor() {
  const store = createMockStore();
  const executor = new TaskExecutor(store as never, "/tmp/test", {
    agentStore: { getAgent: vi.fn().mockResolvedValue(null), createAgent: vi.fn() },
  } as never);
  return { executor, store };
}

function executeStep(executor: TaskExecutor, task: unknown, step: unknown): Promise<Record<string, unknown>> {
  return (executor as unknown as { executeWorkflowStep: (...args: unknown[]) => Promise<Record<string, unknown>> })
    .executeWorkflowStep(task, step, WORKTREE, { workflowStepTimeoutMs: 600_000 }, undefined);
}

/** Graph custom-node deps whose step executor is the REAL `TaskExecutor.executeWorkflowStep`. */
function graphNodeDeps(row: TaskDetail, executor: TaskExecutor) {
  return {
    store: {
      getTask: vi.fn(async () => row),
      logEntry: vi.fn(async () => undefined),
    },
    rootDir: "/tmp/test",
    workspaceConfig: null,
    options: {},
    graphUnattendedRuns: new Set<string>(),
    getRunContextFor: () => undefined,
    adoptColumnAgentForNode: vi.fn(async () => undefined),
    buildInjectedRuntimeEnv: vi.fn(async () => ({ env: {}, pathEntryCount: 0, injectedKeyCount: 0 })),
    ensureGraphCustomNodeWorktree: vi.fn(async () => row),
    executeScriptWorkflowStep: vi.fn(),
    executeWorkflowStep: (...args: unknown[]) =>
      (executor as unknown as { executeWorkflowStep: (...a: unknown[]) => Promise<unknown> }).executeWorkflowStep(...args),
    pauseForCliApproval: vi.fn(),
    resolveWorkflowInputMarkerForGraphNode: vi.fn(async () => undefined),
    runAwaitInputNode: vi.fn(),
    runCliAgentNode: vi.fn(),
    runRawCliCommand: vi.fn(),
    runConfiguredCommand: vi.fn(),
    worktreePath: WORKTREE,
  };
}

function singleNodeGraph(node: WorkflowIrNode, columnId = "todo"): WorkflowIr {
  return {
    version: "v2",
    name: "empty-session-error",
    columns: [{ id: columnId, name: columnId, traits: [] }],
    nodes: [{ id: "start", kind: "start" }, node, { id: "end", kind: "end" }],
    edges: [
      { from: "start", to: node.id },
      { from: node.id, to: "end", condition: "success" },
      { from: node.id, to: "end", condition: "failure" },
    ],
  };
}

const planReviewGroup: WorkflowIrNode = {
  id: "plan-review",
  kind: "optional-group",
  config: {
    name: "Plan Review",
    reviewKind: "plan",
    defaultOn: true,
    maxRevisions: "unbounded",
    template: {
      nodes: [{ id: "plan-review-step", kind: "prompt", config: { name: "Plan Review", prompt: "Review the plan.", toolMode: "readonly", gateMode: "gate" } }],
      edges: [],
    },
  },
};

const topLevelReviewNode: WorkflowIrNode = { id: "browser-check", kind: "prompt", config: { name: "Browser check", prompt: "verify", reviewKind: "code" } };

async function runGraph(ir: WorkflowIr, row: TaskDetail, prompt: WorkflowNodeHandler): Promise<WorkflowStepResult[]> {
  const persisted: WorkflowStepResult[] = [];
  const graph = new WorkflowGraphExecutor({
    handlers: { prompt },
    recordWorkflowStepResult: async (_taskId, result) => {
      persisted.push(result);
    },
    requestPreMergeOptionalStepFix: vi.fn(async () => true),
  });
  await graph.run(row, { experimentalFeatures: { workflowGraphExecutor: true }, workflowStepTimeoutMs: 600_000 } as never, ir);
  return persisted;
}

/** Runs one review group through the real step executor with a session that rejects with `reject`, and returns its terminal step result. */
async function runReviewGroup(group: WorkflowIrNode, reject: unknown, columnId = "todo"): Promise<WorkflowStepResult | undefined> {
  installSessions([{ reject }]);
  const row = reviewTask([group.id]);
  const { executor } = newExecutor();
  const deps = graphNodeDeps(row, executor);
  const persisted = await runGraph(
    singleNodeGraph(group, columnId),
    row,
    (node, context) => runGraphCustomNode(deps as never, node, context.task, context.settings as Settings, undefined, context.context),
  );
  return persisted.filter((result) => result.workflowStepId === group.id).at(-1);
}

function expectNoBareReason(output: string | undefined) {
  expect(output).toBeTruthy();
  expect(output).not.toMatch(/: (?:failed|exception|undefined|\[object Object\])$/);
}

beforeEach(() => {
  resetExecutorMocks();
  vi.restoreAllMocks();
  mockedExecSync.mockImplementation(() => Buffer.from(""));
});

describe("Plan Review whose session fails without an error message (production path)", () => {
  it("records the error type for an empty-message Error", async () => {
    const result = await runReviewGroup(planReviewGroup, new Error(""));
    expect(result).toMatchObject({
      status: "failed",
      output: "Plan Review failed before producing a verdict: Agent session failed without an error message (error type: Error)",
    });
    expect(result?.verdict).toBeUndefined();
    expect(result?.providerFailure).toBeUndefined();
  });

  it("records the rejection value for an undefined rejection", async () => {
    const result = await runReviewGroup(planReviewGroup, undefined);
    expect(result).toMatchObject({
      status: "failed",
      output: "Plan Review failed before producing a verdict: Agent session failed without an error message (rejection value: undefined)",
    });
    expect(result?.providerFailure).toBeUndefined();
  });

  it.each<[string, unknown]>([
    ["a whitespace Error message", new Error("   ")],
    ["null", null],
    ["an empty object", {}],
    ["an exit code and stderr", Object.assign(new Error(""), { exitCode: 1, stderr: "fatal: not logged in" })],
  ])("records a specific reason for %s", async (_label, value) => {
    const result = await runReviewGroup(planReviewGroup, value);
    expect(result).toMatchObject({ status: "failed", output: `${PLAN_REVIEW_PREFIX}${describeFailure(value, "Agent session")}` });
    expect(result?.verdict).toBeUndefined();
    expect(result?.providerFailure).toBeUndefined();
    expectNoBareReason(result?.output);
  });

  it("classifies a 429 cause behind an empty message as a provider rate limit", async () => {
    const result = await runReviewGroup(planReviewGroup, new Error("", { cause: new Error("429 Too Many Requests") }));
    expect(result?.status).toBe("failed");
    expect(result?.output).toContain("cause: 429 Too Many Requests");
    expect(result?.providerFailure).toEqual({ origin: "model-provider", code: "RATE_LIMIT" });
  });

  it("keeps a message-bearing error byte-identical and classified", async () => {
    const result = await runReviewGroup(planReviewGroup, new Error("429 too many requests"));
    expect(result).toMatchObject({ status: "failed", output: "Plan Review failed before producing a verdict: 429 too many requests" });
    expect(result?.providerFailure).toEqual({ origin: "model-provider", code: "RATE_LIMIT" });
  });
});

describe("Post-merge Verification whose session fails without an error message (production path)", () => {
  /*
  The built-in Post-merge verification group runs through the same graph recorder as Plan Review and needs no browser or git checkout, so it is the second review step proven end to end.
  Code Review's content-binding input proof needs a real git checkout and Browser Verification needs the agent-browser probe; both are covered at the step-executor level below.
  */
  it("records the error type for an empty-message Error", async () => {
    const group = postMergeVerificationOptionalGroupNode("todo");
    const result = await runReviewGroup(group, new Error(""));
    expect(result?.status).toBe("failed");
    expect(result?.verdict).toBeUndefined();
    expect(result?.output).toBe(`Post-merge verification failed before producing a verdict: ${EMPTY_SESSION} (error type: Error)`);
  });
});

describe("review node whose handler throws without an error message", () => {
  it("records the error type on an optional-group review", async () => {
    const persisted = await runGraph(singleNodeGraph(planReviewGroup), reviewTask(["plan-review"]), async () => {
      throw new Error("");
    });
    const result = persisted.filter((entry) => entry.workflowStepId === "plan-review").at(-1);
    expect(result).toMatchObject({ status: "failed", output: `${PLAN_REVIEW_PREFIX}${EMPTY_NODE} (error type: Error)` });
  });

  it("records the rejection value on a top-level review node", async () => {
    const persisted = await runGraph(singleNodeGraph(topLevelReviewNode), reviewTask([]), async () => {
      throw undefined;
    });
    const result = persisted.filter((entry) => entry.workflowStepId === "browser-check").at(-1);
    expect(result?.status).toBe("failed");
    expect(result?.output?.endsWith(`${EMPTY_NODE} (rejection value: undefined)`)).toBe(true);
  });
});

describe("every review step at the shared session catch", () => {
  const now = new Date().toISOString();
  const stepBase = { description: "", mode: "prompt", phase: "pre-merge", gateMode: "gate", toolMode: "readonly", enabled: true, createdAt: now, updatedAt: now };
  const steps = {
    "Plan Review": { ...stepBase, id: "graph:plan-review-step", name: "Plan Review", prompt: "Review the plan.", optionalGroupId: "plan-review" },
    "Code Review": { ...stepBase, id: "graph:code-review-step", name: "Code Review", prompt: "Review the code.", optionalGroupId: "code-review" },
    "Post-merge Verification": { ...stepBase, id: "graph:post-merge-verification-step", name: "Post-merge verification", prompt: "Verify the merge.", phase: "post-merge", optionalGroupId: "post-merge-verification" },
    "Browser Verification": { ...stepBase, id: "graph:browser-verification-step", name: "Browser Verification", prompt: "Verify in browser.", gateMode: "advisory", toolMode: "coding", requiresBrowser: true },
  };
  const expectedError = `${EMPTY_SESSION} (error type: Error)`;

  it.each(Object.keys(steps) as Array<keyof typeof steps>)("%s returns a specific error for an empty-message rejection", async (name) => {
    mockedExecSync.mockImplementation((command: string) => Buffer.from(command === "agent-browser --version" ? "agent-browser 9.9.9\n" : ""));
    installSessions([{ reject: new Error("") }]);
    const { executor, store } = newExecutor();
    const result = await executeStep(executor, reviewTask([]), steps[name]);

    expect(result).toMatchObject({ success: false, error: expectedError });
    if (name === "Browser Verification") {
      expect(store.appendAgentLog).toHaveBeenCalledWith(
        "KB-145-T",
        `[browser-verification] finished browser verification for task KB-145-T: failed — ${expectedError}`,
        "status",
        undefined,
        "reviewer",
      );
    }
    if (name === "Code Review") {
      // Workspace per-repository reviews come from the same step executor, so they inherit the reason.
      expect(toWorkspaceRepoReviewResult(result as never).review).toBe(expectedError);
    }
  });
});
