import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { AutoRecoveryDispatcher } from "../../healing/auto-recovery.js";

const baseTask = { id: "FN-1", column: "in-progress", recoveryRetryCount: 0 } as Task;

describe("reliability interaction: contamination auto-recovery precedence", () => {
  it("bootstrap/4428 deterministic fast paths bypass dispatcher retry handler", async () => {
    const issueRetry = vi.fn();
    const dispatcher = new AutoRecoveryDispatcher({
      taskStore: {} as never,
      auditEmitter: { database: vi.fn(async () => {}), git: vi.fn(), filesystem: vi.fn(), sandbox: vi.fn() },
      handlers: { issueRetry },
    });

    const bootstrapRecovered = true;
    if (!bootstrapRecovered) {
      await dispatcher.dispatch({ class: "branch-cross-contamination", taskId: "FN-1", pausedReason: "branch-cross-contamination" }, {
        task: baseTask,
        retryCount: 0,
        settings: { mode: "programmatic", maxRetries: 3 },
      });
    }

    const crossContaminationAutoRecovered = true;
    if (!crossContaminationAutoRecovered) {
      await dispatcher.dispatch({ class: "branch-cross-contamination", taskId: "FN-1", pausedReason: "branch-cross-contamination" }, {
        task: baseTask,
        retryCount: 0,
        settings: { mode: "programmatic", maxRetries: 3 },
      });
    }

    expect(issueRetry).not.toHaveBeenCalled();
  });

  it("dispatcher retry is last step before pause path", async () => {
    const issueRetry = vi.fn(async () => {});
    const dispatcher = new AutoRecoveryDispatcher({
      taskStore: {} as never,
      auditEmitter: { database: vi.fn(async () => {}), git: vi.fn(), filesystem: vi.fn(), sandbox: vi.fn() },
      handlers: { issueRetry },
    });

    const decision = await dispatcher.dispatch({
      class: "branch-cross-contamination",
      taskId: "FN-1",
      pausedReason: "branch-cross-contamination",
      evidence: { ownCommits: 0, foreignAttributedCommits: 2 },
    }, {
      task: baseTask,
      retryCount: 0,
      settings: { mode: "programmatic", maxRetries: 1 },
    });

    expect(decision.action).toBe("retry");
    expect(issueRetry).toHaveBeenCalledOnce();
  });

  it("foreign-only no-own-work routes to retry, not pause", async () => {
    const issueRetry = vi.fn(async () => {});
    const dispatcher = new AutoRecoveryDispatcher({
      taskStore: {} as never,
      auditEmitter: { database: vi.fn(async () => {}), git: vi.fn(), filesystem: vi.fn(), sandbox: vi.fn() },
      handlers: { issueRetry },
    });

    const decision = await dispatcher.dispatch({
      class: "branch-cross-contamination",
      taskId: "FN-1",
      pausedReason: "branch-cross-contamination",
      evidence: { ownCommits: 0, foreignAttributedCommits: 3, recoveryKind: "foreign-only" },
    }, {
      task: baseTask,
      retryCount: 0,
      settings: { mode: "programmatic", maxRetries: 2 },
    });

    expect(decision.action).toBe("retry");
    expect(issueRetry).toHaveBeenCalledOnce();
  });

  it("mode off and destructive ambiguity preserve pause", () => {
    const dispatcher = new AutoRecoveryDispatcher({
      taskStore: {} as never,
      auditEmitter: { database: vi.fn(async () => {}), git: vi.fn(), filesystem: vi.fn(), sandbox: vi.fn() },
      handlers: { issueRetry: vi.fn() },
    });

    const modeOff = dispatcher.classify({ class: "branch-cross-contamination", taskId: "FN-1", pausedReason: "branch-cross-contamination" }, {
      task: baseTask,
      retryCount: 0,
      settings: { mode: "off", maxRetries: 3 },
    });
    expect(modeOff.action).toBe("pause");
    expect(modeOff.legacyPausedReason).toBe("branch-cross-contamination");

    const destructive = dispatcher.classify({
      class: "branch-cross-contamination",
      taskId: "FN-1",
      pausedReason: "branch-cross-contamination",
      evidence: { ownCommits: 1, foreignAttributedCommits: 1 },
    }, {
      task: baseTask,
      retryCount: 0,
      settings: { mode: "programmatic", maxRetries: 3 },
    });
    expect(destructive.action).toBe("pause");
  });

  /*
  FNXC:RecoveryOwnership 2026-10-07-05:26:
  FN-9512 replaced the indistinguishable pause on retry-budget exhaustion with an explicit escalation that keeps the legacy paused reason for diagnosis.
  Mode off and destructive ambiguity still pause (asserted above); only budget exhaustion escalates, and it must never issue another retry.
  */
  it("retry budget exhaustion escalates on subsequent event instead of pausing", async () => {
    const issueRetry = vi.fn(async () => {});
    const database = vi.fn(async () => {});
    const dispatcher = new AutoRecoveryDispatcher({
      taskStore: {} as never,
      auditEmitter: { database, git: vi.fn(), filesystem: vi.fn(), sandbox: vi.fn() },
      handlers: { issueRetry },
    });
    const failure = { class: "branch-cross-contamination" as const, taskId: "FN-1", pausedReason: "branch-cross-contamination" };
    const context = {
      task: { ...baseTask, recoveryRetryCount: 1 } as Task,
      retryCount: 1,
      settings: { mode: "programmatic" as const, maxRetries: 1 },
    };

    const second = dispatcher.classify(failure, context);

    expect(second.action).toBe("escalate");
    expect(second.recoveryDisposition).toBe("escalate");
    expect(second.rationale).toBe("retry-budget-exhausted");
    expect(second.legacyPausedReason).toBe("branch-cross-contamination");
    expect(second.auditMetadata).toMatchObject({
      class: "branch-cross-contamination",
      retryCount: 1,
      maxRetries: 1,
      rationale: "retry-budget-exhausted",
    });

    const dispatched = await dispatcher.dispatch(failure, context);

    expect(dispatched.action).toBe("escalate");
    expect(issueRetry).not.toHaveBeenCalled();
    expect(database).toHaveBeenCalledWith(expect.objectContaining({
      type: "auto-recovery:retry-budget-escalated",
      target: "FN-1",
      metadata: expect.objectContaining({ rationale: "retry-budget-exhausted", retryCount: 1, maxRetries: 1 }),
    }));
  });
});
