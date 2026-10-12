/*
FNXC:MergeLandingCommitPoint 2026-10-12-11:10:
KB-146: an abort that reached the merge body seconds after main fast-forwarded made the merge pump log "Auto-recovered: cleared stale 'landing' status", leaving a card that had landed looking unmerged.
The merge body now records the landing proof on the card as soon as the integration ref moves, before anything that can be interrupted.
This file drives the real pump claim, abort and settle methods with a body that has reached that point, for the abort sources that do not go through the graph bound: a requester that abandons its request and `abortActiveMerge` (task paused).
The confirmed row keeps its merge-active stamp for the confirmed-landing owners (finalizer, merge-confirmed fast path, self-healing), and no stale-stamp clear is written.
The bound itself is covered in merge-queue-wait-timeout.test.ts and project-engine.test.ts; the body's proof write in merger-ai.test.ts.

FNXC:MergeLandingCommitPoint 2026-10-12-12:20:
The merge sweep's gate probe (`resolveMergeGateBlocker`, also the pump's pre-dispatch probe) seeded KB-146's Code Review while its own merge was landing.
It never reroutes the active merge's card, still reroutes a queued or idle stale card as before, and a `landed` refusal leaves no log line or audit row.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedMergeLaneState } from "./_project-engine-merge-lane-fixture.js";

const mocks = vi.hoisted(() => ({ runAiMerge: vi.fn() }));
const probe = vi.hoisted(() => ({
  reroute: undefined as unknown as ReturnType<typeof vi.fn>,
  capture: undefined as unknown as ReturnType<typeof vi.fn>,
  blocker: undefined as unknown as ReturnType<typeof vi.fn>,
  gate: undefined as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  probe.blocker = vi.fn(actual.getTaskMergeBlocker);
  probe.gate = vi.fn(actual.resolvePreMergeGateForTask);
  return { ...actual, getTaskMergeBlocker: probe.blocker, resolvePreMergeGateForTask: probe.gate };
});
vi.mock("../merge/merge-content-capture.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../merge/merge-content-capture.js")>();
  probe.capture = vi.fn(actual.captureMergeContentDescriptor);
  return { ...actual, captureMergeContentDescriptor: probe.capture };
});
vi.mock("../merge/stale-content-review-reroute.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../merge/stale-content-review-reroute.js")>();
  probe.reroute = vi.fn(actual.rerouteSingularStaleContentToReview);
  return { ...actual, rerouteSingularStaleContentToReview: probe.reroute };
});

vi.mock("../merge/merger-ai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../merge/merger-ai.js")>();
  return { ...actual, runAiMerge: mocks.runAiMerge };
});

import { writeTransientMergeStatus } from "../merge/merger-ai.js";
import { createMergeAbortedError } from "../merge/merge-write-fence.js";
import { ProjectEngine } from "../project-engine.js";
import { STALE_CONTENT_APPROVAL_BLOCKER } from "@fusion/core";

const LANDED_SHA = "a".repeat(40);
const BRANCH_TIP_SHA = "b".repeat(40);

function harness() {
  const task: Record<string, unknown> = {
    id: "KB-159",
    column: "in-review",
    status: null,
    paused: false,
    userPaused: false,
    branch: "fusion/kb-159",
    priority: "normal",
    mergeRetries: 0,
    steps: [],
    workflowStepResults: [],
    createdAt: "2026-10-12T00:00:00.000Z",
  };
  const store = {
    getTask: vi.fn(async () => task),
    getSettings: vi.fn(async () => ({ autoMerge: true, globalPause: false, enginePaused: false })),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => Object.assign(task, patch)),
    updateTaskAtomic: vi.fn(async (_id: string, updater: (live: typeof task) => Record<string, unknown> | null) => {
      const patch = updater(task);
      return patch ? Object.assign(task, patch) : null;
    }),
    logEntry: vi.fn(async () => undefined),
    getRootDir: vi.fn(() => "/tmp/kb-159"),
    listTasks: vi.fn(async () => []),
    getActiveMergingTask: vi.fn(async () => null),
    emit: vi.fn(),
  };
  const engine = seedMergeLaneState(Object.create(ProjectEngine.prototype) as any);
  engine.mergeBodySettleTimeoutMs = 1;
  engine.config = { workingDirectory: "/tmp/kb-159" };
  engine.options = {};
  engine.runtime = { getTaskStore: () => store, getPluginRunner: () => undefined };

  let landed = false;
  mocks.runAiMerge.mockReset();
  mocks.runAiMerge.mockImplementationOnce(async (_store: unknown, _cwd: string, taskId: string, options: { signal?: AbortSignal; onMergeLandingStarted?: () => void }) => {
    await writeTransientMergeStatus(store as never, taskId, options.signal, "landing");
    options.onMergeLandingStarted?.();
    // The body has advanced the integration ref and written the unfenced landing proof, as runAiMerge's recordLanding does.
    await store.updateTaskAtomic(taskId, (live) => ({
      mergeDetails: { ...(live.mergeDetails as object | undefined), mergeConfirmed: true, commitSha: LANDED_SHA, landedBranchTipSha: BRANCH_TIP_SHA, mergeTargetBranch: "main" },
    }));
    landed = true;
    await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
    throw createMergeAbortedError(taskId);
  });
  return { engine, store, task, isLanded: () => landed };
}

function expectLandingKeptForConfirmedOwners(task: Record<string, unknown>, store: { logEntry: ReturnType<typeof vi.fn> }): void {
  expect(task.mergeDetails).toMatchObject({ mergeConfirmed: true, commitSha: LANDED_SHA, landedBranchTipSha: BRANCH_TIP_SHA });
  expect(task.status).toBe("landing");
  const messages = store.logEntry.mock.calls.map((call: unknown[]) => String(call[1]));
  expect(messages.some((message) => message.includes("cleared stale"))).toBe(false);
}

describe("merge pump abort after the integration ref advanced", () => {
  it("keeps the landing of a merge whose requester abandoned it", async () => {
    const { engine, store, task, isLanded } = harness();
    const requester = new AbortController();
    const request = ProjectEngine.prototype.onMerge.call(engine, "KB-159", { signal: requester.signal }).then(
      () => undefined,
      (error: Error) => error,
    );
    await vi.waitFor(() => expect(isLanded()).toBe(true));

    requester.abort();

    expect((await request)?.message).toContain("Merge request for KB-159 aborted");
    await vi.waitFor(() => expect(engine.mergeRunning).toBe(false));
    expectLandingKeptForConfirmedOwners(task, store);
  });

  it("keeps the landing of a merge aborted because its task was paused", async () => {
    const { engine, store, task, isLanded } = harness();
    const request = ProjectEngine.prototype.onMerge.call(engine, "KB-159").then(
      () => undefined,
      (error: Error) => error,
    );
    await vi.waitFor(() => expect(isLanded()).toBe(true));

    expect(ProjectEngine.prototype.abortActiveMerge.call(engine, "KB-159", "task-paused")).toBe(true);

    expect(await request).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(engine.mergeRunning).toBe(false));
    expectLandingKeptForConfirmedOwners(task, store);
  });
});

describe("merge sweep gate probe for a card with a stale approval", () => {
  function probeHarness() {
    const task = { id: "KB-159", column: "in-review", status: null, steps: [], workflowStepResults: [], autoMerge: true } as Record<string, unknown>;
    const store = {
      getTask: vi.fn(async () => task),
      logEntry: vi.fn(async () => undefined),
      recordRunAuditEvent: vi.fn(async () => undefined),
      getStaleReviewCallbackWaiverReceipts: vi.fn(async () => []),
      getProjectId: vi.fn(() => "kb-159"),
      getRootDir: vi.fn(() => "/tmp/kb-159"),
    };
    const engine = seedMergeLaneState(Object.create(ProjectEngine.prototype) as any);
    engine.config = { workingDirectory: "/tmp/kb-159" };
    engine.options = {};
    engine.runtime = { getTaskStore: () => store, getPluginRunner: () => undefined };
    engine.staleContentRerouteAuditKeys = new Set<string>();
    engine.rerouteFailedNoVerdictPreMergeReview = vi.fn(async () => "not-applicable");
    const resolve = () => (engine as any).resolveMergeGateBlocker(store, task, { autoMerge: true });
    const messages = () => store.logEntry.mock.calls.map((call: unknown[]) => String(call[1]));
    const staleAuditRows = () => store.recordRunAuditEvent.mock.calls.filter((call: unknown[]) => (call[0] as { mutationType?: string }).mutationType === "task:merge-stale-content-review-rerouted");
    return { engine, store, task, resolve, messages, staleAuditRows };
  }

  beforeEach(() => {
    probe.gate.mockResolvedValue({ provenance: "task", selectionAbsent: false, reviewColumns: new Set(["in-review"]), requiredPreMergeStepIds: new Set(["code-review"]) });
    probe.capture.mockResolvedValue({ kind: "singular", diff: { state: "fingerprint", fingerprint: "current" } });
    probe.blocker.mockReturnValue(STALE_CONTENT_APPROVAL_BLOCKER);
    probe.reroute.mockResolvedValue({ rerouted: true, reason: "seeded", nodeId: "code-review", workflowStepId: "code-review" });
  });

  afterEach(() => {
    for (const fn of [probe.gate, probe.capture, probe.blocker, probe.reroute]) fn.mockReset();
  });

  it("does not reroute the card whose own merge is active", async () => {
    const run = probeHarness();
    run.engine.activeMergeTaskId = "KB-159";

    await expect(run.resolve()).resolves.toBe(STALE_CONTENT_APPROVAL_BLOCKER);

    expect(probe.reroute).not.toHaveBeenCalled();
    expect(run.messages().some((message) => message.includes("approved older content"))).toBe(false);
    expect(run.staleAuditRows()).toHaveLength(0);
  });

  it("still reroutes a queued card at pump pre-dispatch", async () => {
    const run = probeHarness();
    run.engine.activeMergeTaskId = "KB-OTHER";
    run.engine.mergeQueue = ["KB-159"];

    await expect(run.resolve()).resolves.toBe(STALE_CONTENT_APPROVAL_BLOCKER);

    expect(probe.reroute).toHaveBeenCalledOnce();
    expect(run.messages().some((message) => message.includes("approved older content"))).toBe(true);
  });

  it("still reroutes, logs and audits an idle unlanded card", async () => {
    const run = probeHarness();

    await expect(run.resolve()).resolves.toBe(STALE_CONTENT_APPROVAL_BLOCKER);

    expect(probe.reroute).toHaveBeenCalledWith(run.store, run.task, expect.objectContaining({ projectRootDir: "/tmp/kb-159" }));
    expect(run.messages().some((message) => message.includes("approved older content"))).toBe(true);
    expect(run.staleAuditRows()).toHaveLength(1);
  });

  it("writes no log line and no audit row for a landed refusal", async () => {
    const run = probeHarness();
    probe.reroute.mockResolvedValue({ rerouted: false, reason: "landed" });

    await expect(run.resolve()).resolves.toBe(STALE_CONTENT_APPROVAL_BLOCKER);

    expect(probe.reroute).toHaveBeenCalledOnce();
    expect(run.messages()).toEqual([]);
    expect(run.staleAuditRows()).toHaveLength(0);
  });
});
