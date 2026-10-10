/*
FNXC:ProviderRateLimitDeferral 2026-10-08-16:05:
KB-077: a workflow review step that fails before producing a verdict because of a provider rate limit records the provider error and a
structured `providerFailure` marker on its step result, then freezes in place and auto-resumes on the executor's external-block schedule
instead of exhausting its no-verdict repair within a minute. Genuine reviewer failures keep today's re-seed contract.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postMergeVerificationOptionalGroupNode, type Task, type TaskDetail, type WorkflowIr, type WorkflowIrNode, type WorkflowStepResult } from "@fusion/core";

import { PLAN_REVIEW_PROVIDER_FAILURE_HOLD_VALUE, WorkflowGraphExecutor, type WorkflowNodeHandler } from "../workflows/workflow-graph-executor.js";
import type { WorkflowGraphTaskRunResult } from "../workflows/workflow-graph-task-runner.js";
import { handleGraphFailure } from "../executor/handle-graph-failure.js";
import { requestPreMergeOptionalStepFix } from "../executor/request-pre-merge-optional-step-fix.js";
import { recoverFailedPreMergeWorkflowStepDetailed } from "../executor/recover-failed-pre-merge-step.js";
import { hasExhaustedNoVerdictRecovery, rerouteFailedNoVerdictPreMergeGateToReview } from "../merge/pre-merge-gate-reseed.js";
import { SelfHealingManager } from "../self-healing.js";
import { resumeDueExternalBlocks } from "../external-block/external-block-lifecycle.js";
import { projectAdmissionCoordinator } from "../concurrency/concurrency.js";
import { buildStepFailureContextPatch } from "../executor/run-graph-custom-node.js";
import { deferReviewStepOnProviderRateLimit } from "../external-block/provider-rate-limit-deferral.js";
import { ANTHROPIC_RATE_LIMIT_429, MINUTE, RAW_429, T0, createRateLimitStore, graphFailureDeps, rateLimitedResult, reviewCard } from "./fixtures/rate-limit-deferral-store.js";

const settingsOn = () => ({ experimentalFeatures: { workflowGraphExecutor: true } });

function codeReviewGroupIr(): WorkflowIr {
  return {
    version: "v2",
    name: "kb-077-step-result",
    columns: [{ id: "review", name: "Review", traits: [] }],
    nodes: [
      { id: "start", kind: "start" },
      {
        id: "code-review",
        kind: "optional-group",
        config: {
          name: "Code Review",
          defaultOn: true,
          template: { nodes: [{ id: "reviewstep", kind: "prompt", config: { prompt: "review" } }], edges: [] },
        },
      },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "code-review" },
      { from: "code-review", to: "end", condition: "success" },
      { from: "code-review", to: "end", condition: "failure" },
    ],
  };
}

function topLevelReviewIr(): WorkflowIr {
  return {
    version: "v2",
    name: "kb-077-node-result",
    columns: [{ id: "review", name: "Review", traits: [] }],
    nodes: [
      { id: "start", kind: "start" },
      { id: "browser-check", kind: "prompt", config: { name: "Browser check", prompt: "verify", reviewKind: "code" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "browser-check" },
      { from: "browser-check", to: "end", condition: "failure" },
      { from: "browser-check", to: "end", condition: "success" },
    ],
  };
}

function makeRecorder() {
  const results: WorkflowStepResult[] = [];
  const record = async (_taskId: string, result: WorkflowStepResult) => {
    const idx = results.findIndex((entry) => entry.workflowStepId === result.workflowStepId);
    if (idx >= 0) results[idx] = result;
    else results.push(result);
  };
  return { results, record };
}

/**
 * Mirrors `runGraphCustomNode`'s outcome mapping for a failed step session: the real helper builds the context patch the graph records.
 */
function failingStep(
  outcome: { success: boolean; error?: string; output?: string; verdict?: string },
  mode: "prompt" | "script" = "prompt",
): WorkflowNodeHandler {
  return async (node) => {
    if (node.kind === "start" || node.kind === "end") return { outcome: "success" };
    const contextPatch: Record<string, unknown> = { ...buildStepFailureContextPatch(node.id, outcome, mode) };
    if (typeof outcome.output === "string") contextPatch.output = outcome.output;
    return { outcome: "failure", value: outcome.verdict ?? "failed", contextPatch };
  };
}

const task = { id: "KB-066", enabledWorkflowSteps: ["code-review"] } as TaskDetail;

describe("KB-077 step result records the provider error and a structured providerFailure marker", () => {
  it("(a) a code-review prompt step failing with a 429 records the error text and a RATE_LIMIT marker", async () => {
    const recorder = makeRecorder();
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: failingStep({ success: false, error: "429 Too Many Requests" }) },
      recordWorkflowStepResult: recorder.record,
    });
    await executor.run(task, settingsOn(), codeReviewGroupIr());

    const result = recorder.results.find((entry) => entry.workflowStepId === "code-review");
    expect(result?.status).toBe("failed");
    expect(result?.verdict).toBeUndefined();
    expect(result?.output).toBe("Code Review failed before producing a verdict: 429 Too Many Requests");
    expect(result?.providerFailure).toEqual({ origin: "model-provider", code: "RATE_LIMIT" });
  });

  it("(a') a top-level review node records the same marker through the node-progress recorder", async () => {
    const recorder = makeRecorder();
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: failingStep({ success: false, error: "rate limit exceeded, retry later (429)" }) },
      recordWorkflowStepResult: recorder.record,
    });
    await executor.run({ id: "KB-066" } as TaskDetail, settingsOn(), topLevelReviewIr());

    const result = recorder.results.find((entry) => entry.workflowStepId === "browser-check");
    expect(result?.status).toBe("failed");
    expect(result?.output).toContain("rate limit exceeded");
    expect(result?.providerFailure).toEqual({ origin: "model-provider", code: "RATE_LIMIT" });
  });

  it("(b) a quota/billing error records USAGE_LIMIT, not RATE_LIMIT", async () => {
    const recorder = makeRecorder();
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: failingStep({ success: false, error: "insufficient_quota: you exceeded your current quota, check your plan and billing details" }) },
      recordWorkflowStepResult: recorder.record,
    });
    await executor.run(task, settingsOn(), codeReviewGroupIr());

    expect(recorder.results.find((entry) => entry.workflowStepId === "code-review")?.providerFailure)
      .toEqual({ origin: "model-provider", code: "USAGE_LIMIT" });
  });

  it("(c) reviewer prose that discusses rate limiting, with no session error, records no marker", async () => {
    const recorder = makeRecorder();
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: failingStep({ success: false, output: "The retry loop ignores 429 rate limit responses from the API." }) },
      recordWorkflowStepResult: recorder.record,
    });
    await executor.run(task, settingsOn(), codeReviewGroupIr());

    const result = recorder.results.find((entry) => entry.workflowStepId === "code-review");
    expect(result?.status).toBe("failed");
    expect(result?.providerFailure).toBeUndefined();
  });

  it("(d) a script review step never carries a provider marker, even when its error text looks like a 429", async () => {
    const recorder = makeRecorder();
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: failingStep({ success: false, error: "curl: (22) 429 Too Many Requests" }, "script") },
      recordWorkflowStepResult: recorder.record,
    });
    await executor.run(task, settingsOn(), codeReviewGroupIr());

    const result = recorder.results.find((entry) => entry.workflowStepId === "code-review");
    expect(result?.status).toBe("failed");
    expect(result?.output).toContain("429 Too Many Requests");
    expect(result?.providerFailure).toBeUndefined();
  });

  it("a parsed verdict is reviewer evidence: the helper records neither error nor marker", () => {
    expect(buildStepFailureContextPatch("reviewstep", { success: false, verdict: "REVISE", error: "429 Too Many Requests" }, "prompt")).toEqual({});
    expect(buildStepFailureContextPatch("reviewstep", { success: true, error: "429 Too Many Requests" }, "prompt")).toEqual({});
    expect(buildStepFailureContextPatch("reviewstep", { success: false, error: "   " }, "prompt")).toEqual({});
  });
});

describe("KB-077 deferReviewStepOnProviderRateLimit (shared freeze helper)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  it("first deferral freezes at the review node with a 5-minute automatic resume and attributes the audit rows to the reviewer", async () => {
    const env = createRateLimitStore([reviewCard("KB-066", { workflowStepResults: [rateLimitedResult("code-review")] })]);
    const result = await deferReviewStepOnProviderRateLimit({ store: env.store as never, taskId: "KB-066", result: rateLimitedResult("code-review"), nowMs: T0 });

    expect(result).toEqual({ deferred: true, outcome: "deferred", nodeId: "code-review", attempt: 1 });
    const row = env.rows.get("KB-066")!;
    expect(row.status).toBe("blocked");
    expect(row.paused).toBe(true);
    expect(row.pausedReason).toBe("external-block");
    expect(row.column).toBe("review");
    expect(row.externalBlock).toMatchObject({ origin: "model-provider", code: "RATE_LIMIT", source: "session-failure", resume: { column: "review", nodeId: "code-review" } });
    expect(row.externalBlock?.autoResume).toEqual({ attempt: 1, budget: 6, resumeAt: new Date(T0 + 5 * MINUTE).toISOString() });
    expect(env.logs.map((entry) => entry.message)).toContain("Code Review hit a provider rate limit — automatic re-run 1/6 in 5m; Retry re-runs now");
    const deferredRow = env.audits.find((audit) => audit.mutationType === "task:provider-rate-limit-deferred");
    expect(deferredRow?.agentId).toBe("reviewer");
    expect(deferredRow?.metadata).toEqual({
      taskId: "KB-066", lane: "review", nodeId: "code-review", workflowStepId: "code-review", phase: "pre-merge",
      code: "RATE_LIMIT", attempt: 1, budget: 6, outcome: "deferred",
    });
    expect(JSON.stringify(deferredRow?.metadata)).not.toContain("429");
    expect(env.audits.find((audit) => audit.mutationType === "task:external-block-parked")?.agentId).toBe("reviewer");
  });

  it.each([
    [1, 15], [2, 30], [3, 60], [4, 120], [5, 120],
  ])("with %i automatic resumes already spent the next resume is %i minutes out", async (spent, minutes) => {
    const env = createRateLimitStore([reviewCard("KB-066", { externalBlockAutoResumeCount: spent, workflowStepResults: [rateLimitedResult("code-review")] })]);
    await deferReviewStepOnProviderRateLimit({ store: env.store as never, taskId: "KB-066", result: rateLimitedResult("code-review"), nowMs: T0 });
    expect(env.rows.get("KB-066")!.externalBlock?.autoResume).toEqual({ attempt: spent + 1, budget: 6, resumeAt: new Date(T0 + minutes * MINUTE).toISOString() });
  });

  it("a spent budget still freezes (never failed) without an automatic resume", async () => {
    const env = createRateLimitStore([reviewCard("KB-066", { externalBlockAutoResumeCount: 6, workflowStepResults: [rateLimitedResult("code-review")] })]);
    const result = await deferReviewStepOnProviderRateLimit({ store: env.store as never, taskId: "KB-066", result: rateLimitedResult("code-review"), nowMs: T0 });
    expect(result).toMatchObject({ deferred: true, outcome: "budget-exhausted", attempt: 6 });
    const row = env.rows.get("KB-066")!;
    expect(row.status).toBe("blocked");
    expect(row.externalBlock?.autoResume).toBeUndefined();
    expect(env.audits.find((audit) => audit.mutationType === "task:provider-rate-limit-deferred")?.metadata.outcome).toBe("budget-exhausted");
  });

  it.each([
    ["user-paused", { userPaused: true, paused: true }],
    ["deleted", { deletedAt: "2026-10-08T10:00:00.000Z" }],
    ["operator-held", { paused: true, pausedReason: "manual" }],
    ["merge-confirmed", { mergeDetails: { mergeConfirmed: true } }],
    ["auto-merge-off", { autoMerge: false }],
  ] as const)("refuses %s without writing", async (reason, overrides) => {
    const env = createRateLimitStore([reviewCard("KB-066", { ...overrides, workflowStepResults: [rateLimitedResult("code-review")] } as Partial<Task>)]);
    const result = await deferReviewStepOnProviderRateLimit({ store: env.store as never, taskId: "KB-066", result: rateLimitedResult("code-review"), nowMs: T0 });
    expect(result).toEqual({ deferred: false, reason });
    expect(env.store.updateTask).not.toHaveBeenCalled();
  });

  it("defers Post-merge Verification on a merge-confirmed card (the landed commit is what it verifies)", async () => {
    const env = createRateLimitStore([reviewCard("KB-066", { mergeDetails: { mergeConfirmed: true } as never, workflowStepResults: [rateLimitedResult("post-merge-verification")] })]);
    const result = await deferReviewStepOnProviderRateLimit({ store: env.store as never, taskId: "KB-066", result: rateLimitedResult("post-merge-verification"), nowMs: T0 });
    expect(result).toMatchObject({ deferred: true, nodeId: "post-merge-verification" });
    expect(env.audits.find((audit) => audit.mutationType === "task:provider-rate-limit-deferred")?.metadata.phase).toBe("post-merge");
  });

  it("supersedes only the engine's own provider-rate-limit pause", async () => {
    const env = createRateLimitStore([reviewCard("KB-066", { paused: true, pausedReason: "provider-rate-limit:anthropic", workflowStepResults: [rateLimitedResult("code-review")] })]);
    const result = await deferReviewStepOnProviderRateLimit({ store: env.store as never, taskId: "KB-066", result: rateLimitedResult("code-review"), nowMs: T0 });
    expect(result.deferred).toBe(true);
    expect(env.rows.get("KB-066")!.pausedReason).toBe("external-block");
  });

  it("is idempotent on an already-frozen card: no write and no budget change", async () => {
    const env = createRateLimitStore([reviewCard("KB-066", { workflowStepResults: [rateLimitedResult("code-review")] })]);
    await deferReviewStepOnProviderRateLimit({ store: env.store as never, taskId: "KB-066", result: rateLimitedResult("code-review"), nowMs: T0 });
    env.store.updateTask.mockClear();
    const second = await deferReviewStepOnProviderRateLimit({ store: env.store as never, taskId: "KB-066", result: rateLimitedResult("code-review"), nowMs: T0 + 1000 });
    expect(second).toEqual({ deferred: false, reason: "already-frozen" });
    expect(env.store.updateTask).not.toHaveBeenCalled();
    expect(env.rows.get("KB-066")!.externalBlock?.autoResume?.attempt).toBe(1);
  });

  it("refuses a result without a RATE_LIMIT marker", async () => {
    const env = createRateLimitStore([reviewCard("KB-066")]);
    const usage = rateLimitedResult("code-review", { providerFailure: { origin: "model-provider", code: "USAGE_LIMIT" } });
    expect(await deferReviewStepOnProviderRateLimit({ store: env.store as never, taskId: "KB-066", result: usage, nowMs: T0 })).toEqual({ deferred: false, reason: "not-rate-limit" });
    const genuine = rateLimitedResult("code-review", { providerFailure: undefined });
    expect(await deferReviewStepOnProviderRateLimit({ store: env.store as never, taskId: "KB-066", result: genuine, nowMs: T0 })).toEqual({ deferred: false, reason: "not-rate-limit" });
  });

  it.each([
    ["throwing", () => { throw new Error("audit sink down"); }],
    ["rejecting", async () => { throw new Error("audit sink down"); }],
    ["hanging", () => new Promise<void>(() => undefined)],
  ])("a %s audit sink cannot change the freeze (bounded seam)", async (_label, sink) => {
    const env = createRateLimitStore([reviewCard("KB-066", { workflowStepResults: [rateLimitedResult("code-review")] })]);
    env.store.recordRunAuditEvent.mockImplementation(sink as never);
    const pending = deferReviewStepOnProviderRateLimit({ store: env.store as never, taskId: "KB-066", result: rateLimitedResult("code-review"), nowMs: T0 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pending).toMatchObject({ deferred: true, outcome: "deferred" });
    expect(env.rows.get("KB-066")!.status).toBe("blocked");
    expect(env.rows.get("KB-066")!.externalBlock?.autoResume?.attempt).toBe(1);
  });
});

function failedRun(nodeId: string, value = "failed"): WorkflowGraphTaskRunResult {
  return { disposition: "failed", outcome: "failure", visitedNodeIds: ["start", nodeId], context: { [`node:${nodeId}:outcome`]: "failure", [`node:${nodeId}:value`]: value } } as WorkflowGraphTaskRunResult;
}

function rerouter(deps: unknown): ReturnType<typeof vi.fn> {
  return (deps as { rerouteFailedNoVerdictPreMergeReview: ReturnType<typeof vi.fn> }).rerouteFailedNoVerdictPreMergeReview;
}

describe("KB-077 automatic review recovery freezes a rate-limited review instead of exhausting its repair", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    projectAdmissionCoordinator.clearReservationsForTests();
  });
  afterEach(() => {
    projectAdmissionCoordinator.clearReservationsForTests();
    vi.useRealTimers();
  });

  it("KB-066 repro: two consecutive Code Review 429 failures through the real graph produce one freeze, no re-seed, never failed", async () => {
    const env = createRateLimitStore([reviewCard("KB-066", { enabledWorkflowSteps: ["code-review"] })]);
    const recordIntoRow = async (_taskId: string, result: WorkflowStepResult) => {
      const row = env.rows.get("KB-066")!;
      const others = (row.workflowStepResults ?? []).filter((entry) => entry.workflowStepId !== result.workflowStepId);
      row.workflowStepResults = [...others, structuredClone(result)];
    };
    const reviewOnlyIr = { ...codeReviewGroupIr(), edges: [{ from: "start", to: "code-review" }, { from: "code-review", to: "end", condition: "success" }] } as WorkflowIr;
    const deps = graphFailureDeps(env);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const graph = new WorkflowGraphExecutor({
        handlers: { prompt: failingStep({ success: false, error: RAW_429 }) },
        recordWorkflowStepResult: recordIntoRow,
      });
      const run = await graph.run({ ...env.rows.get("KB-066")!, enabledWorkflowSteps: ["code-review"] } as TaskDetail, settingsOn(), reviewOnlyIr);
      expect(run.outcome).toBe("failure");
      await handleGraphFailure(deps, env.rows.get("KB-066")!, { disposition: "failed", outcome: run.outcome, visitedNodeIds: run.visitedNodeIds, context: run.context } as WorkflowGraphTaskRunResult);
    }

    const row = env.rows.get("KB-066")!;
    const result = row.workflowStepResults?.find((entry) => entry.workflowStepId === "code-review");
    expect(result?.output).toContain(RAW_429);
    expect(result?.providerFailure).toEqual({ origin: "model-provider", code: "RATE_LIMIT" });
    expect(row.status).toBe("blocked");
    expect(row.pausedReason).toBe("external-block");
    expect(row.column).toBe("review");
    expect(row.externalBlock?.code).toBe("RATE_LIMIT");
    expect(row.externalBlock?.resume.nodeId).toBe("code-review");
    expect(row.externalBlock?.autoResume?.resumeAt).toBe(new Date(T0 + 5 * MINUTE).toISOString());
    expect(row.error ?? "").not.toMatch(/^Review recovery stopped/);
    expect(row.error).not.toBe(RAW_429);
    expect(rerouter(deps)).not.toHaveBeenCalled();
    expect(env.store.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
    expect(env.items).toHaveLength(0);
    expect(env.audits.filter((audit) => audit.mutationType === "task:external-block-parked")).toHaveLength(1);

    vi.setSystemTime(T0 + 5 * MINUTE + 1);
    expect(await resumeDueExternalBlocks({ store: env.store as never, tasks: [...env.rows.values()] })).toEqual(["KB-066"]);
    expect(env.items.at(-1)).toMatchObject({ nodeId: "code-review", sourceColumn: "review", targetColumn: "review", state: "runnable" });
  });

  it.each([
    ["browser-verification", {}],
    ["post-merge-verification", { mergeDetails: { mergeConfirmed: true } }],
  ] as const)("a %s 429 failure freezes at its own node", async (stepId, overrides) => {
    const env = createRateLimitStore([reviewCard("KB-066", { ...overrides, workflowStepResults: [rateLimitedResult(stepId)] } as Partial<Task>)]);
    await handleGraphFailure(graphFailureDeps(env), env.rows.get("KB-066")!, failedRun(stepId));
    const row = env.rows.get("KB-066")!;
    expect(row.status).toBe("blocked");
    expect(row.externalBlock?.resume.nodeId).toBe(stepId);
  });

  it("a Plan Review 429 in the hold lane freezes at plan-review instead of taking the two-retry provider hold", async () => {
    const env = createRateLimitStore([reviewCard("KB-066", { column: "planning", workflowStepResults: [rateLimitedResult("plan-review")] })]);
    await handleGraphFailure(graphFailureDeps(env), env.rows.get("KB-066")!, failedRun("plan-review", PLAN_REVIEW_PROVIDER_FAILURE_HOLD_VALUE));
    const row = env.rows.get("KB-066")!;
    expect(row.status).toBe("blocked");
    expect(row.column).toBe("planning");
    expect(row.externalBlock?.resume).toMatchObject({ column: "planning", nodeId: "plan-review" });
    expect(row.graphResumeRetryCount).toBeUndefined();
  });

  it("a Plan Review non-rate-limit provider error (ECONNRESET) keeps the existing in-place hold", async () => {
    const env = createRateLimitStore([reviewCard("KB-066", {
      column: "planning",
      workflowStepResults: [rateLimitedResult("plan-review", { output: "Plan Review failed before producing a verdict: read ECONNRESET", providerFailure: { origin: "network", code: "ECONNRESET" } })],
    })]);
    await handleGraphFailure(graphFailureDeps(env), env.rows.get("KB-066")!, failedRun("plan-review", PLAN_REVIEW_PROVIDER_FAILURE_HOLD_VALUE));
    const row = env.rows.get("KB-066")!;
    expect(row.externalBlock).toBeUndefined();
    expect(row.graphResumeRetryCount).toBe(1);
    expect(env.logs.map((entry) => entry.message)).toContain("Plan Review provider failure — retrying in place (1/2)");
  });

  it("a genuine reviewer no-verdict failure (no providerFailure) still takes the no-verdict re-seed", async () => {
    const env = createRateLimitStore([reviewCard("KB-066", { workflowStepResults: [rateLimitedResult("code-review", { providerFailure: undefined, output: "Code Review failed before producing a verdict: exception" })] })]);
    const deps = graphFailureDeps(env);
    await handleGraphFailure(deps, env.rows.get("KB-066")!, failedRun("code-review"));
    expect(env.rows.get("KB-066")!.externalBlock).toBeUndefined();
    expect(rerouter(deps)).toHaveBeenCalledTimes(1);
  });

  it("an auto-merge Off review card keeps today's behaviour (no freeze) while its step result still carries the provider error", async () => {
    const env = createRateLimitStore([reviewCard("KB-066", { autoMerge: false, workflowStepResults: [rateLimitedResult("code-review")] })]);
    const deps = graphFailureDeps(env);
    await handleGraphFailure(deps, env.rows.get("KB-066")!, failedRun("code-review"));
    const row = env.rows.get("KB-066")!;
    expect(row.externalBlock).toBeUndefined();
    expect(row.workflowStepResults?.[0]?.output).toContain(RAW_429);
    expect(rerouter(deps)).toHaveBeenCalledTimes(1);
  });

  it("the remediation producer freezes instead of writing a 'Review recovery stopped' park", async () => {
    const history = [1, 2, 3].map((n) => rateLimitedResult("code-review", { startedAt: new Date(T0 - n * MINUTE).toISOString() }));
    const env = createRateLimitStore([reviewCard("KB-066", { workflowStepResults: [rateLimitedResult("code-review", { priorAttempts: history })] })]);
    const scheduled = await requestPreMergeOptionalStepFix({ store: env.store, getRunContextFor: () => undefined } as never, "KB-066", env.rows.get("KB-066")!, {
      stepName: "Code Review", nodeId: "code-review", feedback: `Code Review failed before producing a verdict: ${RAW_429}`, phase: "pre-merge", status: "failed",
    });
    expect(scheduled).toBe(false);
    const row = env.rows.get("KB-066")!;
    expect(row.status).toBe("blocked");
    expect(row.error ?? "").not.toMatch(/Review recovery stopped/);
  });

  it("rate-limited attempts never exhaust the lost-dispatch re-seed budget", () => {
    const history = [1, 2, 3].map((n) => rateLimitedResult("code-review", { startedAt: new Date(T0 - n * MINUTE).toISOString() }));
    expect(hasExhaustedNoVerdictRecovery(rateLimitedResult("code-review", { providerFailure: undefined, priorAttempts: history }))).toBe(false);
    const genuine = history.map((entry) => ({ ...entry, providerFailure: undefined }));
    expect(hasExhaustedNoVerdictRecovery(rateLimitedResult("code-review", { providerFailure: undefined, priorAttempts: genuine }))).toBe(true);
  });

  it("recover-failed-pre-merge-step never turns a rate-limited review into implementation remediation", async () => {
    const env = createRateLimitStore([reviewCard("KB-066", { workflowStepResults: [rateLimitedResult("code-review")] })]);
    const outcome = await recoverFailedPreMergeWorkflowStepDetailed({ store: env.store } as never, env.rows.get("KB-066")!);
    expect(outcome).toEqual({ kind: "skipped" });
  });
});

function reviewGroupNode(id: string, name: string): WorkflowIrNode {
  return {
    id,
    kind: "optional-group",
    column: "review",
    config: { name, defaultOn: true, template: { nodes: [{ id: `${id}-step`, kind: "prompt", config: { prompt: name, gateMode: "gate" } }], edges: [] } },
  };
}

function singleGateIr(gate: WorkflowIrNode): WorkflowIr {
  return {
    version: "v2",
    name: `single-${gate.id}`,
    columns: [{ id: "planning", name: "Planning", traits: [{ trait: "hold" }] }, { id: "review", name: "Review", traits: [] }],
    nodes: [{ id: "start", kind: "start" }, gate, { id: "end", kind: "end" }],
    edges: [{ from: "start", to: gate.id }, { from: gate.id, to: "end", condition: "success" }],
  } as WorkflowIr;
}

/*
FNXC:ProviderRateLimitDeferral 2026-10-10-17:24:
From 2026-10-08 to 2026-10-10 eleven landed cards failed Post-merge Verification every hour within about 16 seconds with the bare detail
"Post-merge verification failed before producing a verdict: failed" while the Anthropic account answered 429.
Every review gate that dies on that exact payload must keep the provider text on its step result and freeze in place on the
external-block schedule, so the operator sees the rate limit and the hourly recheck stops spending reviewer sessions.
*/
describe("an Anthropic 429 at any review gate keeps the provider error and freezes in place", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    projectAdmissionCoordinator.clearReservationsForTests();
  });
  afterEach(() => {
    projectAdmissionCoordinator.clearReservationsForTests();
    vi.useRealTimers();
  });

  it.each([
    { label: "Plan Review", gate: { id: "plan-review", kind: "prompt", column: "planning", config: { name: "Plan Review", prompt: "plan", reviewKind: "plan" } } as WorkflowIrNode, card: { column: "planning" } },
    { label: "Code Review", gate: reviewGroupNode("code-review", "Code Review"), card: {} },
    { label: "Browser Verification", gate: reviewGroupNode("browser-verification", "Browser Verification"), card: {} },
    { label: "Post-merge verification", gate: postMergeVerificationOptionalGroupNode("review"), card: { mergeDetails: { mergeConfirmed: true, commitSha: "8ae7ec0a2099b707f6bb5d689b748f8c14987548" } } },
  ])("$label", async ({ gate, card }) => {
    const env = createRateLimitStore([reviewCard("KB-083", { ...card, enabledWorkflowSteps: [gate.id] } as Partial<Task>)], { ir: singleGateIr(gate) });
    const graph = new WorkflowGraphExecutor({
      handlers: { prompt: failingStep({ success: false, error: ANTHROPIC_RATE_LIMIT_429 }) },
      recordWorkflowStepResult: async (_taskId, result) => {
        const row = env.rows.get("KB-083")!;
        row.workflowStepResults = [...(row.workflowStepResults ?? []).filter((entry) => entry.workflowStepId !== result.workflowStepId), structuredClone(result)];
      },
    });
    const run = await graph.run({ ...env.rows.get("KB-083")! } as TaskDetail, settingsOn(), singleGateIr(gate));
    expect(run.outcome).toBe("failure");

    await handleGraphFailure(graphFailureDeps(env), env.rows.get("KB-083")!, { disposition: "failed", outcome: run.outcome, visitedNodeIds: run.visitedNodeIds, context: run.context } as WorkflowGraphTaskRunResult);

    const row = env.rows.get("KB-083")!;
    const result = row.workflowStepResults?.find((entry) => entry.workflowStepId === gate.id);
    expect(result?.output).toContain(ANTHROPIC_RATE_LIMIT_429);
    expect(result?.output).not.toMatch(/failed before producing a verdict: failed$/);
    expect(result?.providerFailure).toEqual({ origin: "model-provider", code: "RATE_LIMIT" });
    expect(row.status).toBe("blocked");
    expect(row.error ?? "").not.toMatch(/^Review recovery stopped/);
    expect(row.externalBlock).toMatchObject({ origin: "model-provider", code: "RATE_LIMIT", resume: { nodeId: gate.id } });
    expect(row.externalBlock?.autoResume?.resumeAt).toBe(new Date(T0 + 5 * MINUTE).toISOString());
  });
});

describe("KB-077 self-healing and operator retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  it("the self-healing no-verdict sweep freezes a rate-limited unpaused review card instead of re-seeding it", async () => {
    const env = createRateLimitStore([reviewCard("KB-066", { workflowStepResults: [rateLimitedResult("code-review")] })]);
    const rerouteFailedNoVerdictPreMergeReview = vi.fn(async () => "rerouted");
    const recoverFailedPreMergeStep = vi.fn(async () => true);
    Object.assign(env.store, { isMergeLaneOwned: vi.fn(async () => false) });
    await new SelfHealingManager(env.store as never, {
      rootDir: env.store.getRootDir(),
      recoverFailedPreMergeStep,
      rerouteFailedNoVerdictPreMergeReview,
      getExecutingTaskIds: () => new Set<string>(),
    } as never).recoverReviewTasksWithFailedPreMergeSteps();

    const row = env.rows.get("KB-066")!;
    expect(row.status).toBe("blocked");
    expect(row.externalBlock?.resume.nodeId).toBe("code-review");
    expect(rerouteFailedNoVerdictPreMergeReview).not.toHaveBeenCalled();
    expect(recoverFailedPreMergeStep).not.toHaveBeenCalled();
  });

  it("the operator retry path (the shared re-seed primitive) still re-seeds a rate-limited review immediately", async () => {
    const env = createRateLimitStore([reviewCard("KB-066", { workflowStepResults: [rateLimitedResult("code-review")] })]);
    const reroute = await rerouteFailedNoVerdictPreMergeGateToReview(env.store as never, env.rows.get("KB-066")!, {
      requiredPreMergeStepIds: new Set(["code-review"]),
      mergeContent: { kind: "singular" } as never,
    });
    expect(reroute).toMatchObject({ rerouted: true, nodeId: "code-review" });
    expect(env.rows.get("KB-066")!.externalBlock).toBeUndefined();
  });
});
