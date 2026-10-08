/*
FNXC:ProviderRateLimitDeferral 2026-10-08-16:05:
KB-065 (2026-10-08 10:49Z): an AI merge session hit a 429 and the merge pump parked the card `failed` in review with the raw 429 text as
its error. A provider rate limit is transient: both merge entry shapes (the ProjectEngine pump's auto path and the graph-owned merge's
bounded retry router) freeze the card at its workflow's merge node on the executor's external-block schedule, keep it clean in review,
spend no merge retry budget, and park only when the shared automatic-resume budget is spent.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_CODING_WORKFLOW_IR, type Task } from "@fusion/core";

const testState = vi.hoisted(() => ({
  currentStore: null as unknown,
  runAiMerge: vi.fn(),
}));

vi.mock("../merger.js", () => ({
  sweepStaleAutostashes: vi.fn(async () => undefined),
  VerificationError: class VerificationError extends Error {},
}));

vi.mock("../merge/merger-ai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../merge/merger-ai.js")>();
  return { ...actual, runAiMerge: testState.runAiMerge };
});

vi.mock("../runtimes/in-process-runtime.js", () => ({
  InProcessRuntime: vi.fn().mockImplementation(function () {
    return {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      getTaskStore: () => testState.currentStore,
      getAgentStore: vi.fn(),
      getMessageStore: vi.fn(),
      getRoutineStore: vi.fn(),
      getRoutineRunner: vi.fn(),
      getHeartbeatMonitor: vi.fn(),
      getTriggerScheduler: vi.fn(),
      configurePrMonitoring: vi.fn(),
      setActiveMergeTaskIdProvider: vi.fn(),
      setActiveMergeStartedAtMsProvider: vi.fn(),
      setActiveMergeAborter: vi.fn(),
      setMergeEnqueuer: vi.fn(),
      setMergeActiveClearer: vi.fn(),
      setMergePendingProvider: vi.fn(),
      setMergeRequester: vi.fn(),
      resumeAfterUnpause: vi.fn(async () => undefined),
      getPluginRunner: vi.fn(() => undefined),
    };
  }),
}));

import { ProjectEngine } from "../project-engine.js";
import { runtimeLog } from "../logger.js";
import { routeGraphMergeFailureToRetry } from "../executor/route-graph-merge-failure-to-retry.js";
import { deferMergeOnProviderRateLimit } from "../external-block/provider-rate-limit-deferral.js";
import { resumeDueExternalBlocks } from "../external-block/external-block-lifecycle.js";
import { AUTO_MERGE_RETRY_REJECTED_PREFIX } from "../merge/stale-content-park.js";
import { MINUTE, T0, createRateLimitStore, reviewCard } from "./fixtures/rate-limit-deferral-store.js";

const RAW_MERGE_429 = "429 Too Many Requests: rate limit exceeded";

function mergeCard(overrides: Partial<Task> = {}): Task {
  return reviewCard("KB-065", { column: "in-review", mergeRetries: 0, enabledWorkflowSteps: [], log: [], ...overrides } as Partial<Task>);
}

function mergeEnv(task: Task, settings: Record<string, unknown> = {}) {
  const env = createRateLimitStore([task], { ir: BUILTIN_CODING_WORKFLOW_IR, settings: { autoResolveConflicts: true, baseBranch: "main", pollIntervalMs: 15_000, ...settings } });
  Object.assign(env.store, {
    moveTask: vi.fn(async () => env.rows.get(task.id)),
    moveTaskIf: vi.fn(async () => ({ moved: false, task: env.rows.get(task.id) })),
    getActiveMergingTask: vi.fn(() => null),
    getStaleReviewCallbackWaiverReceipts: vi.fn(async () => []),
    getProjectId: vi.fn(() => "proj_kb077"),
    createTask: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  });
  return env;
}

function createEngine(store: unknown): ProjectEngine {
  testState.currentStore = store;
  return new ProjectEngine(
    { projectId: "proj_kb077", workingDirectory: "/tmp/proj_kb077", isolationMode: "in-process", maxConcurrent: 1, maxWorktrees: 1 },
    {} as never,
    { skipNotifier: true, getTaskMergeBlocker: () => undefined },
  );
}

async function runMergeCycle(engine: ProjectEngine, taskId = "KB-065"): Promise<void> {
  const privateEngine = engine as unknown as { mergeQueue: string[]; mergeActive: Set<string>; drainMergeQueue: () => Promise<void> };
  privateEngine.mergeActive.add(taskId);
  privateEngine.mergeQueue.push(taskId);
  await privateEngine.drainMergeQueue();
}

function failedWrites(env: ReturnType<typeof mergeEnv>) {
  return env.store.updateTask.mock.calls.filter(([, patch]) => (patch as { status?: unknown }).status === "failed");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  testState.runAiMerge.mockReset();
  vi.spyOn(runtimeLog, "error").mockImplementation(() => undefined);
  vi.spyOn(runtimeLog, "warn").mockImplementation(() => undefined);
  vi.spyOn(runtimeLog, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("KB-077 merge pump: a rate-limited AI merge freezes instead of parking failed", () => {
  it("KB-065 repro: an auto-merge card whose merger hits a 429 is frozen at the merge node, not failed, with no retry budget spent", async () => {
    const env = mergeEnv(mergeCard());
    testState.runAiMerge.mockRejectedValueOnce(new Error(RAW_MERGE_429));
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await runMergeCycle(createEngine(env.store));

    const row = env.rows.get("KB-065")!;
    expect(failedWrites(env)).toEqual([]);
    expect(row.status).toBe("blocked");
    expect(row.status).not.toBe("failed");
    expect(row.error).not.toBe(RAW_MERGE_429);
    expect(row.pausedReason).toBe("external-block");
    expect(row.column).toBe("in-review");
    expect(row.externalBlock).toMatchObject({ origin: "model-provider", code: "RATE_LIMIT", resume: { column: "in-review", nodeId: "merge-gate" } });
    expect(row.externalBlock?.autoResume?.resumeAt).toBe(new Date(T0 + 5 * MINUTE).toISOString());
    expect(row.mergeRetries).toBe(0);
    expect(row.mergeTransientRetryCount).toBeUndefined();
    expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 5000);
    expect(env.audits.find((audit) => audit.mutationType === "task:provider-rate-limit-deferred")).toMatchObject({
      agentId: "merger",
      metadata: { taskId: "KB-065", lane: "merge", nodeId: "merge-gate", code: "RATE_LIMIT", attempt: 1, budget: 6, outcome: "deferred" },
    });

    vi.setSystemTime(T0 + 5 * MINUTE);
    expect(await resumeDueExternalBlocks({ store: env.store as never, tasks: [...env.rows.values()] })).toEqual(["KB-065"]);
    expect(env.items.at(-1)).toMatchObject({ nodeId: "merge-gate", sourceColumn: "in-review", state: "runnable" });
  });

  it("supersedes the merger's own provider-rate-limit pause (UsageLimitPauser fired)", async () => {
    const env = mergeEnv(mergeCard());
    testState.runAiMerge.mockImplementationOnce(async () => {
      await env.store.updateTask("KB-065", { paused: true, pausedReason: "provider-rate-limit:anthropic" });
      throw new Error(RAW_MERGE_429);
    });

    await runMergeCycle(createEngine(env.store));

    const row = env.rows.get("KB-065")!;
    expect(row.status).toBe("blocked");
    expect(row.pausedReason).toBe("external-block");
    expect(failedWrites(env)).toEqual([]);
  });

  it("a spent budget freezes without an automatic resume and is still not failed", async () => {
    const env = mergeEnv(mergeCard({ externalBlockAutoResumeCount: 6 }));
    testState.runAiMerge.mockRejectedValueOnce(new Error(RAW_MERGE_429));

    await runMergeCycle(createEngine(env.store));

    const row = env.rows.get("KB-065")!;
    expect(row.status).toBe("blocked");
    expect(row.externalBlock?.autoResume).toBeUndefined();
    expect(failedWrites(env)).toEqual([]);
  });

  it("a non-rate-limit non-conflict error still parks failed (today's contract)", async () => {
    const env = mergeEnv(mergeCard());
    testState.runAiMerge.mockRejectedValueOnce(new Error("remote rejected the push"));

    await runMergeCycle(createEngine(env.store));

    expect(env.rows.get("KB-065")!.status).toBe("failed");
    expect(env.rows.get("KB-065")!.externalBlock).toBeUndefined();
  });

  it("a quota (USAGE_LIMIT) error keeps today's path and is not frozen by this lane", async () => {
    const env = mergeEnv(mergeCard());
    testState.runAiMerge.mockRejectedValueOnce(new Error("insufficient_quota: you exceeded your current quota, check your plan and billing details"));

    await runMergeCycle(createEngine(env.store));

    expect(env.rows.get("KB-065")!.externalBlock).toBeUndefined();
    expect(env.audits.some((audit) => audit.mutationType === "task:provider-rate-limit-deferred")).toBe(false);
  });

  it("a frozen card is not dispatched by the merge pump until its automatic resume is admitted", async () => {
    const env = mergeEnv(mergeCard());
    testState.runAiMerge.mockRejectedValueOnce(new Error(RAW_MERGE_429));
    const engine = createEngine(env.store);
    await runMergeCycle(engine);
    expect(env.rows.get("KB-065")!.status).toBe("blocked");

    testState.runAiMerge.mockClear();
    await runMergeCycle(engine);
    expect(testState.runAiMerge).not.toHaveBeenCalled();
  });
});

describe("KB-077 deferMergeOnProviderRateLimit guards", () => {
  it("never freezes a merge-confirmed card", async () => {
    const env = mergeEnv(mergeCard({ mergeDetails: { mergeConfirmed: true } as never }));
    expect(await deferMergeOnProviderRateLimit({ store: env.store as never, taskId: "KB-065", errorMessage: RAW_MERGE_429, nowMs: T0 }))
      .toEqual({ deferred: false, reason: "merge-confirmed" });
    expect(env.store.updateTask).not.toHaveBeenCalled();
  });

  it("refuses when the workflow has no merge node to resume at", async () => {
    const env = createRateLimitStore([mergeCard()], {
      ir: { version: "v2", name: "no-merge", columns: [{ id: "review", name: "Review", traits: [] }], nodes: [{ id: "start", kind: "start" }], edges: [] },
    });
    expect(await deferMergeOnProviderRateLimit({ store: env.store as never, taskId: "KB-065", errorMessage: RAW_MERGE_429, nowMs: T0 }))
      .toEqual({ deferred: false, reason: "no-resume-node" });
    expect(env.store.updateTask).not.toHaveBeenCalled();
  });

  it("refuses a user-paused card and a non-rate-limit error", async () => {
    const env = mergeEnv(mergeCard({ userPaused: true, paused: true }));
    expect(await deferMergeOnProviderRateLimit({ store: env.store as never, taskId: "KB-065", errorMessage: RAW_MERGE_429, nowMs: T0 }))
      .toEqual({ deferred: false, reason: "user-paused" });
    expect(await deferMergeOnProviderRateLimit({ store: env.store as never, taskId: "KB-065", errorMessage: "remote rejected the push", nowMs: T0 }))
      .toEqual({ deferred: false, reason: "not-rate-limit" });
  });
});

describe("KB-077 graph-owned merge: a rate-limited merge request freezes instead of AUTO_MERGE_RETRY_REJECTED", () => {
  it("freezes at the merge node when the merge requester rejects with a 429", async () => {
    const env = mergeEnv(mergeCard());
    const live = env.rows.get("KB-065")!;
    const handled = await routeGraphMergeFailureToRetry({
      store: env.store as never,
      getRunContextFor: () => undefined,
      mergeRequester: vi.fn(async () => { throw new Error(RAW_MERGE_429); }),
      ensureWorkflowMergeBoundaryTask: vi.fn(async (task) => ({ task })) as never,
      persistTokenUsage: vi.fn(async () => undefined),
    }, live as never, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["start", "merge-gate"],
      context: { "node:merge-gate:value": "failed" },
    }, undefined);

    expect(handled).toBe(true);
    const row = env.rows.get("KB-065")!;
    expect(row.status).toBe("blocked");
    expect(row.error ?? "").not.toContain(AUTO_MERGE_RETRY_REJECTED_PREFIX);
    expect(row.externalBlock?.resume.nodeId).toBe("merge-gate");
    expect(row.mergeRetries).toBe(0);
  });

  it("keeps the AUTO_MERGE_RETRY_REJECTED park for a non-rate-limit rejection", async () => {
    const env = mergeEnv(mergeCard());
    const live = env.rows.get("KB-065")!;
    await routeGraphMergeFailureToRetry({
      store: env.store as never,
      getRunContextFor: () => undefined,
      mergeRequester: vi.fn(async () => { throw new Error("task is marked 'needs-replan'"); }),
      ensureWorkflowMergeBoundaryTask: vi.fn(async (task) => ({ task })) as never,
      persistTokenUsage: vi.fn(async () => undefined),
    }, live as never, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["start", "merge-gate"],
      context: { "node:merge-gate:value": "failed" },
    }, undefined);

    const row = env.rows.get("KB-065")!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain(AUTO_MERGE_RETRY_REJECTED_PREFIX);
  });
});
