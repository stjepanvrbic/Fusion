import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { computeRecoveryDecision, MAX_RECOVERY_RETRIES, type RecoveryEscalationDecision } from "../healing/recovery-policy.js";
import {
  escalateExhaustedExecutionRecovery,
  retryPlanningLifecycleLockTransportFailure,
} from "../executor/run-implementation.js";
import { handleNonContinuableSessionRetry } from "../executor/non-continuable-session.js";
import { reseedExhaustedBranchConflict } from "../executor/worktree-branch-conflict-handle.js";
import { recoverMissingRequiredArtifacts } from "../executor/required-artifact-recovery.js";
import {
  IN_PLACE_RESUME_CLAIM_POLL_MS,
  requeueExecutionInPlace,
  scheduleInPlaceExecutionResume,
} from "../executor/in-place-execution-requeue.js";
import { dispatchUnpauseResume } from "../executor/unpause-resume.js";
import { clearResumeFailureState } from "../executor/clear-resume-failure-state.js";
import { createRecoveryFakeStore } from "./_recovery-fake-store.js";

/*
 * FNXC:RecoveryOwnership 2026-10-07-18:04:
 * Executor recovery owners must (a) stay in the card's lifecycle role, never moving it back to the
 * hold lane, and (b) spend at most one fresh-session reseed per episode before parking visibly.
 * FN-9512 reset the counter on every escalation, so a deterministic failure cycled forever.
 */

function executorDeps(fake: ReturnType<typeof createRecoveryFakeStore>) {
  return {
    store: fake.store,
    getRunContextFor: () => undefined,
    markGraphExecuteSelfRequeued: vi.fn(),
    scheduleInPlaceExecutionResume: vi.fn(),
  };
}

function escalation(count: number): RecoveryEscalationDecision {
  const decision = computeRecoveryDecision({ recoveryRetryCount: count });
  if (decision.disposition !== "escalate") throw new Error(`count ${count} does not escalate`);
  return decision;
}

describe("executor recovery episode bound", () => {
  it("drives one owner through a full episode: ladder, one reseed, ladder, visible park, then stays parked", async () => {
    const fake = createRecoveryFakeStore({ id: "FN-EP", column: "in-progress" });
    const deps = executorDeps(fake);
    const outcomes: string[] = [];
    for (let failure = 0; failure < 12; failure++) {
      const live = fake.task;
      if (live.status === "failed") { outcomes.push("parked"); break; }
      const decision = computeRecoveryDecision({ recoveryRetryCount: live.recoveryRetryCount });
      if (decision.disposition === "retry") {
        await requeueExecutionInPlace(deps, live.id, {
          updates: { recoveryRetryCount: decision.nextState.recoveryRetryCount },
          notBefore: decision.nextState.nextRecoveryAt,
        });
        outcomes.push("retry");
        continue;
      }
      await escalateExhaustedExecutionRecovery(deps, live, decision, { owner: "executor-transient", detail: "socket hang up" });
      outcomes.push(decision.escalation);
    }

    expect(outcomes).toEqual(["retry", "retry", "retry", "reseed", "retry", "retry", "retry", "park", "parked"]);
    expect(fake.task).toMatchObject({ status: "failed", column: "in-progress" });
    expect(fake.task.error).toContain("socket hang up");
    expect(fake.moves).toEqual([]);
    expect(fake.audits.map((row) => row.metadata?.outcome)).toEqual(["reseeded", "parked"]);
    expect(fake.audits.every((row) => row.mutationType === "auto-recovery:retry-budget-escalated")).toBe(true);
  });

  it("keeps the counter through a reseed instead of resetting it", async () => {
    const fake = createRecoveryFakeStore({ id: "FN-RS", recoveryRetryCount: MAX_RECOVERY_RETRIES, worktree: "/wt", branch: "fusion/fn-rs" });
    const deps = executorDeps(fake);
    await escalateExhaustedExecutionRecovery(deps, fake.task, escalation(MAX_RECOVERY_RETRIES), { owner: "executor-transient", detail: "x" });

    expect(fake.task.recoveryRetryCount).toBe(MAX_RECOVERY_RETRIES + 1);
    expect(fake.task.recoveryDisposition).toBe("escalated-reseed");
    expect(fake.task.worktree).toBeUndefined();
    expect(deps.scheduleInPlaceExecutionResume).toHaveBeenCalledWith("FN-RS");
    expect(fake.moves).toEqual([]);
  });

  it("lets an operator pause win over both the reseed and the park", async () => {
    for (const count of [MAX_RECOVERY_RETRIES, 2 * MAX_RECOVERY_RETRIES + 1]) {
      const fake = createRecoveryFakeStore({ id: `FN-PAUSE-${count}`, recoveryRetryCount: count });
      const snapshot = fake.task;
      fake.task = { ...snapshot, userPaused: true };
      const handled = await escalateExhaustedExecutionRecovery(executorDeps(fake), snapshot, escalation(count), { owner: "executor-transient", detail: "x" });
      expect(handled).toBe(false);
      expect(fake.task.status).toBeUndefined();
      expect(fake.task.recoveryRetryCount).toBe(count);
    }
  });

  it("planning-lock transport retries in place and escalates through the shared bound", async () => {
    const fake = createRecoveryFakeStore({ id: "FN-LOCK" });
    const deps = executorDeps(fake);
    expect(await retryPlanningLifecycleLockTransportFailure(deps, fake.task, "lock endpoint unreachable")).toBe(true);
    expect(fake.task.recoveryRetryCount).toBe(1);
    expect(fake.task.nextRecoveryAt).toBeDefined();
    expect(deps.scheduleInPlaceExecutionResume).toHaveBeenCalledWith("FN-LOCK");

    fake.task = { ...fake.task, recoveryRetryCount: 2 * MAX_RECOVERY_RETRIES + 1 };
    expect(await retryPlanningLifecycleLockTransportFailure(deps, fake.task, "lock endpoint unreachable")).toBe(true);
    expect(fake.task.status).toBe("failed");
    expect(fake.moves).toEqual([]);
  });

  it("non-continuable sessions retry in place, reseed once, then park", async () => {
    const fake = createRecoveryFakeStore({ id: "FN-NC", sessionFile: "/s.jsonl" });
    const deps = {
      ...executorDeps(fake),
      resolveResumeLanes: async () => ({ hold: "todo", wip: "in-progress", review: "in-review", wipDeclared: true }),
      persistTokenUsage: async () => undefined,
      clearCompletedTaskWatchdog: () => undefined,
      signalTaskComplete: () => undefined,
      handoffTaskToReview: async () => undefined,
    };
    const error = "Cannot continue from message role: assistant";
    expect(await handleNonContinuableSessionRetry(deps, fake.task, error)).toBe(true);
    expect(fake.task).toMatchObject({ recoveryRetryCount: 1 });
    expect(fake.task.sessionFile).toBeUndefined();

    fake.task = { ...fake.task, recoveryRetryCount: MAX_RECOVERY_RETRIES };
    await handleNonContinuableSessionRetry(deps, fake.task, error);
    expect(fake.task).toMatchObject({ recoveryRetryCount: MAX_RECOVERY_RETRIES + 1, recoveryDisposition: "escalated-reseed" });

    fake.task = { ...fake.task, recoveryRetryCount: 2 * MAX_RECOVERY_RETRIES + 1 };
    await handleNonContinuableSessionRetry(deps, fake.task, error);
    expect(fake.task.status).toBe("failed");
    expect(fake.moves).toEqual([]);
  });

  it("branch-conflict escalation reseeds once, then parks instead of resetting the dispatcher budget", async () => {
    const fake = createRecoveryFakeStore({ id: "FN-BC", recoveryRetryCount: 3, branch: "fusion/fn-bc", worktree: "/wt" });
    const deps = executorDeps(fake);
    expect(await reseedExhaustedBranchConflict(deps, fake.task, { maxRetries: 3, detail: "branch checked out elsewhere" })).toBe(true);
    expect(fake.task.recoveryRetryCount).toBe(4);
    expect(deps.scheduleInPlaceExecutionResume).toHaveBeenCalledWith("FN-BC");

    expect(await reseedExhaustedBranchConflict(deps, fake.task, { maxRetries: 3, detail: "branch checked out elsewhere" })).toBe(true);
    expect(fake.task.status).toBe("failed");
    expect(fake.task.error).toContain("branch checked out elsewhere");
  });

  it("required-artifact recovery arms a deadline retry and parks after its ladder without resetting", async () => {
    const fake = createRecoveryFakeStore({ id: "FN-ART" });
    const deps = {
      store: fake.store,
      getRunContextFor: () => undefined,
      isRequiredArtifactRecoveryProtected: async (task: Task) => Boolean(task.paused || task.userPaused),
      workflowLifecycleMovesInFlight: new Set<string>(),
      scheduleInPlaceExecutionResume: vi.fn(),
    };
    for (let i = 0; i < MAX_RECOVERY_RETRIES; i++) {
      await recoverMissingRequiredArtifacts(deps, fake.task, ["PROMPT.md"], { source: "graph-entry" });
    }
    expect(fake.task.recoveryRetryCount).toBe(MAX_RECOVERY_RETRIES);
    expect(deps.scheduleInPlaceExecutionResume).toHaveBeenCalledTimes(MAX_RECOVERY_RETRIES);

    await recoverMissingRequiredArtifacts(deps, fake.task, ["PROMPT.md"], { source: "graph-entry" });
    expect(fake.task.status).toBe("failed");
    expect(fake.task.recoveryRetryCount).toBe(MAX_RECOVERY_RETRIES);
    // A later graph entry with the same missing artifact cannot restart the ladder.
    await recoverMissingRequiredArtifacts(deps, fake.task, ["PROMPT.md"], { source: "graph-entry" });
    expect(fake.task.recoveryRetryCount).toBe(MAX_RECOVERY_RETRIES);
    expect(deps.scheduleInPlaceExecutionResume).toHaveBeenCalledTimes(MAX_RECOVERY_RETRIES);
  });
});

describe("in-place execution re-dispatch", () => {
  afterEach(() => vi.useRealTimers());

  function resumeDeps(fake: ReturnType<typeof createRecoveryFakeStore>, claim: { held: boolean }) {
    return {
      store: fake.store,
      resolveResumeLanes: async () => ({ wip: "in-progress" }),
      dispatchUnpauseResume: vi.fn(async () => true),
      hasExecutionClaim: () => claim.held,
      timers: new Map<string, ReturnType<typeof setTimeout>>(),
    };
  }

  it("never moves the card and re-dispatches the same lane once the deadline passes", async () => {
    vi.useFakeTimers();
    const fake = createRecoveryFakeStore({ id: "FN-IP" });
    const claim = { held: false };
    const deps = resumeDeps(fake, claim);
    await requeueExecutionInPlace({
      store: fake.store,
      getRunContextFor: () => undefined,
      markGraphExecuteSelfRequeued: vi.fn(),
      scheduleInPlaceExecutionResume: (id) => scheduleInPlaceExecutionResume(deps, id),
    }, "FN-IP", { notBefore: new Date(Date.now() + 60_000).toISOString() });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(deps.dispatchUnpauseResume).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(deps.dispatchUnpauseResume).toHaveBeenCalledOnce();
    expect(fake.moves).toEqual([]);
  });

  it("waits for the previous run to release its claim before dispatching", async () => {
    vi.useFakeTimers();
    const fake = createRecoveryFakeStore({ id: "FN-CLAIM" });
    const claim = { held: true };
    const deps = resumeDeps(fake, claim);
    scheduleInPlaceExecutionResume(deps, "FN-CLAIM");
    await vi.advanceTimersByTimeAsync(IN_PLACE_RESUME_CLAIM_POLL_MS * 3);
    expect(deps.dispatchUnpauseResume).not.toHaveBeenCalled();
    claim.held = false;
    await vi.advanceTimersByTimeAsync(IN_PLACE_RESUME_CLAIM_POLL_MS);
    expect(deps.dispatchUnpauseResume).toHaveBeenCalledOnce();
  });

  it.each([
    ["paused", { paused: true }],
    ["user-paused", { userPaused: true }],
    ["deleted", { deletedAt: "2026-10-07T00:00:00.000Z" }],
    ["moved out of WIP", { column: "in-review" }],
    ["parked by a newer owner", { status: "failed", error: "newer failure" }],
    ["held for contention", { status: "contention-hold" }],
  ])("cancels the retry when the card was %s before the timer fired", async (_label, patch) => {
    vi.useFakeTimers();
    const fake = createRecoveryFakeStore({ id: "FN-GUARD" });
    const deps = resumeDeps(fake, { held: false });
    scheduleInPlaceExecutionResume(deps, "FN-GUARD");
    fake.task = { ...fake.task, ...(patch as Partial<Task>) };
    await vi.runAllTimersAsync();
    expect(deps.dispatchUnpauseResume).not.toHaveBeenCalled();
  });
});

describe("automatic re-entry honors the recovery deadline", () => {
  const baseDeps = () => ({
    getRunContextFor: () => undefined,
    executing: new Set<string>(),
    resumingUnpaused: new Set<string>(),
    recoveringCompleted: new Set<string>(),
    activeSessions: new Set<string>(),
    activeStepExecutors: new Set<string>(),
    activeWorkflowStepSessions: new Set<string>(),
    graphRouting: new Set<string>(),
    approvalSuspended: new Set<string>(),
    getExecutionPauseLabel: async () => null,
    clearResumeFailureState: async () => undefined,
    recoverApprovedStepsOnResume: async () => undefined,
    recoverCompletedTask: async () => false,
    execute: vi.fn(async () => undefined),
  });

  it("an unrelated task:updated cannot resume a card before its nextRecoveryAt", async () => {
    const fake = createRecoveryFakeStore({ id: "FN-DL", nextRecoveryAt: new Date(Date.now() + 120_000).toISOString() });
    const deps = { ...baseDeps(), store: fake.store };
    expect(await dispatchUnpauseResume(deps, fake.task)).toBe(false);
    expect(deps.execute).not.toHaveBeenCalled();

    const due = { ...fake.task, nextRecoveryAt: new Date(Date.now() - 1_000).toISOString() };
    expect(await dispatchUnpauseResume(deps, due)).toBe(true);
    expect(deps.execute).toHaveBeenCalledOnce();
  });

  it("clears a stuck-killed marker before a resumed run starts", async () => {
    const fake = createRecoveryFakeStore({ id: "FN-SK", status: "stuck-killed" });
    await clearResumeFailureState({ store: fake.store }, fake.task);
    expect(fake.task.status).toBeUndefined();
  });
});
