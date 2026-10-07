import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, mockedCreateFnAgent, mockedExec, resetExecutorMocks } from "./executor-test-helpers.js";
import * as branchConflicts from "../execution/branch-conflicts.js";
import { resolveContaminationBaseRef } from "../executor/worktree-git-refs.js";

/**
 * FN-4417 regression: the contamination check must compute its own fresh
 * merge-base against the integration branch, not reuse `task.baseCommitSha`.
 *
 * FNXC:EngineTests 2026-08-23-18:30: `resolveContaminationBaseRef` is no longer a
 * TaskExecutor method — U4 Slice B peeled it into `executor/worktree-git-refs.ts`
 * as a free function taking only a worktree path. The contract is unchanged, so
 * these assertions target the module export directly instead of an instance.
 */
describe("resolveContaminationBaseRef (FN-4417)", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("returns the current merge-base with origin/main, ignoring task.baseCommitSha", async () => {
    const calls: string[] = [];
    mockedExec.mockImplementation(((cmd: any, _opts: any, cb: any) => {
      calls.push(String(cmd));
      if (String(cmd).includes("merge-base")) cb(null, "fresh_main_sha\n");
      else cb(null, "");
      return {} as any;
    }) as any);

    const result = await resolveContaminationBaseRef("/tmp/test/.worktrees/swift-delta");

    expect(result).toBe("fresh_main_sha");
    const mergeBaseCall = calls.find((c) => c.includes("merge-base"));
    expect(mergeBaseCall).toBeDefined();
    const localMainIdx = mergeBaseCall!.indexOf("merge-base HEAD main");
    const originMainIdx = mergeBaseCall!.indexOf("merge-base HEAD origin/main");
    expect(localMainIdx).toBeGreaterThanOrEqual(0);
    expect(localMainIdx).toBeLessThan(originMainIdx === -1 ? Number.MAX_SAFE_INTEGER : originMainIdx);
    expect(calls.some((c) => c.includes("HEAD~1"))).toBe(false);
  });

  it("returns undefined when neither origin/main nor main resolves", async () => {
    mockedExec.mockImplementation(((_cmd: any, _opts: any, cb: any) => {
      cb(new Error("fatal: no main"), "", "fatal: no main");
      return {} as any;
    }) as any);

    const result = await resolveContaminationBaseRef("/tmp/test/.worktrees/swift-delta");
    expect(result).toBeUndefined();
  });

  it("does NOT fall back to task.baseCommitSha (FN-4417 false-positive guard)", async () => {
    mockedExec.mockImplementation(((cmd: any, _opts: any, cb: any) => {
      cb(null, String(cmd).includes("merge-base") ? "currentMainSHA\n" : "");
      return {} as any;
    }) as any);

    const result = await resolveContaminationBaseRef("/tmp/test/.worktrees/swift-delta");

    expect(result).toBe("currentMainSHA");
    expect(resolveContaminationBaseRef.length).toBe(1);
  });
});

describe("branch cross-contamination recovery (FN-4428/FN-4499)", () => {
  beforeEach(() => {
    /* FNXC:EngineTests 2026-10-04-14:54: Each case owns branch-conflict decisions, so restore prior spy queues before configuring this case. */
    vi.restoreAllMocks();
    resetExecutorMocks();
    mockedExec.mockImplementation(((_cmd: any, _opts: any, cb: any) => {
      cb(null, "");
      return {} as any;
    }) as any);
    mockedCreateFnAgent.mockResolvedValue({ session: { prompt: vi.fn(), close: vi.fn(), dispose: vi.fn() }, sessionFile: null } as any);
  });

  /*
  FNXC:EngineTests 2026-07-19-13:20 (U10b):
  Contamination recovery reads the LIVE task row, not the literal handed to `execute()`: the graph
  re-fetches the task before running the implementation node, so `task.worktree` (which decides
  whether recovery runs inside the worktree — FN-4939) and `task.recoveryRetryCount` (which decides
  auto-recover vs. escalate) must be persisted state. Seeding the store row is the only way a test
  can state "this is what the executor will observe"; setting the same fields on the passed literal
  provably does nothing.
  */
  function seedTaskRow(store: ReturnType<typeof createMockStore>, task: any) {
    (store as any)._setRow(task.id, {
      worktree: task.worktree ?? null,
      branch: task.branch ?? null,
      recoveryRetryCount: task.recoveryRetryCount ?? null,
    });
  }

  function makeTask(recoveryRetryCount?: number) {
    return {
      id: "FN-4428",
      title: "Test",
      description: "Test",
      column: "in-progress",
      worktree: "/tmp/test/.worktrees/fn-4428",
      branch: "fusion/fn-4428",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      recoveryRetryCount,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any;
  }

  it("FN-4488 shape: reanchors bootstrap misbinding and retries in place", async () => {
    const store = createMockStore();
    const contamination = new branchConflicts.BranchCrossContaminationError({
      branchName: "fusion/fn-4488",
      baseSha: "abc123",
      taskId: "FN-4488",
      foreignCommits: [
        { sha: "1111111111111111111111111111111111111111", subject: "feat(FN-4367): dep 1", foreignTaskId: "FN-4367" },
        { sha: "2222222222222222222222222222222222222222", subject: "fix(FN-4367): dep 2", foreignTaskId: "FN-4367" },
      ],
    });

    mockedExec.mockImplementation(((cmd: any, _opts: any, cb: any) => {
      if (String(cmd).includes("merge-base")) {
        cb(null, "abc123\n");
      } else {
        cb(null, "");
      }
      return {} as any;
    }) as any);
    vi.spyOn(branchConflicts, "assertCleanBranchAtBase").mockRejectedValueOnce(contamination);
    // Not `mockResolvedValueOnce`: the acquireTaskWorktree resume-path
    // verifier (FN-5475 fix) also consults classifyBootstrapMisbinding
    // before the executor's primary contamination check runs, so a
    // once-spy is exhausted before the executor's call lands.
    vi.spyOn(branchConflicts, "classifyBootstrapMisbinding").mockResolvedValue({
      isBootstrapMisbinding: true,
      ownCommitCount: 0,
      foreignCommitCount: 1,
      nonAttributedCount: 0,
    });
    const reanchorSpy = vi.spyOn(branchConflicts, "reanchorBranchToBase").mockResolvedValue({
      previousTipSha: "3333333333333333333333333333333333333333",
      newTipSha: "4444444444444444444444444444444444444444",
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    const scheduleInPlaceExecutionResume = vi.spyOn(executor as any, "scheduleInPlaceExecutionResume").mockImplementation(() => undefined);
    const task = { ...makeTask(), id: "FN-4488", branch: "fusion/fn-4488" } as any;
    seedTaskRow(store, task);
    await executor.execute(task);

    /* FNXC:LifecycleContainment 2026-10-07-18:04: the re-anchored checkout is retried in its WIP lane; FN-207 forbids the former WIP-to-hold rebound. */
    expect(reanchorSpy).toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-4488", "todo", expect.anything());
    expect(scheduleInPlaceExecutionResume).toHaveBeenCalledWith("FN-4488");
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-4488", expect.objectContaining({ pausedReason: "branch-cross-contamination" }));
  });

  it("FN-4939: falls back to rootDir for recovery only when task has no worktree pointer", async () => {
    const store = createMockStore();
    const contamination = new branchConflicts.BranchCrossContaminationError({
      branchName: "fusion/fn-4428",
      baseSha: "abc123",
      taskId: "FN-4428",
      foreignCommits: [{ sha: "1111111111111111111111111111111111111111", subject: "feat(FN-4412): upstream", foreignTaskId: "FN-4412" }],
    });

    mockedCreateFnAgent.mockRejectedValueOnce(contamination);
    vi.spyOn(branchConflicts, "classifyBootstrapMisbinding").mockResolvedValueOnce({ isBootstrapMisbinding: false, ownCommitCount: 1, foreignCommitCount: 0, nonAttributedCount: 0 });
    vi.spyOn(branchConflicts, "classifyForeignCommits").mockResolvedValueOnce({ alreadyUpstream: contamination.foreignCommits, unique: [] });
    const recoverySpy = vi.spyOn(branchConflicts, "autoRecoverCrossContamination").mockResolvedValueOnce({
      newTipSha: "2222222222222222222222222222222222222222",
      droppedShas: ["1111111111111111111111111111111111111111"],
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({ ...makeTask(), worktree: undefined } as any);

    expect(recoverySpy).toHaveBeenCalledWith(expect.objectContaining({ repoDir: "/tmp/test" }));
  });

  it("auto-recovers obviously misrouted .changeset-only foreign commits and emits audit", async () => {
    const store = createMockStore();
    (store as any).recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const misroutedCommit = {
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      subject: "feat(FN-5000): changeset",
      foreignTaskId: "FN-5000",
    };
    const contamination = new branchConflicts.BranchCrossContaminationError({
      branchName: "fusion/fn-4428",
      baseSha: "abc123",
      taskId: "FN-4428",
      foreignCommits: [misroutedCommit],
    });

    mockedCreateFnAgent.mockRejectedValueOnce(contamination);
    vi.spyOn(branchConflicts, "classifyBootstrapMisbinding").mockResolvedValueOnce({ isBootstrapMisbinding: false, ownCommitCount: 1, foreignCommitCount: 0, nonAttributedCount: 0 });
    vi.spyOn(branchConflicts, "classifyForeignCommits").mockResolvedValueOnce({ alreadyUpstream: [], unique: [misroutedCommit] });
    vi.spyOn(branchConflicts, "classifyMisroutedForeignCommit").mockResolvedValueOnce({
      misrouted: true,
      foreignTaskId: "FN-5000",
      paths: [".changeset/fn-5000-fix.md"],
    });
    const recoverySpy = vi.spyOn(branchConflicts, "autoRecoverCrossContamination").mockResolvedValueOnce({
      newTipSha: "2222222222222222222222222222222222222222",
      droppedShas: [misroutedCommit.sha],
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    const scheduleInPlaceExecutionResume = vi.spyOn(executor as any, "scheduleInPlaceExecutionResume").mockImplementation(() => undefined);
    await executor.execute(makeTask());

    expect(recoverySpy).toHaveBeenCalledWith(expect.objectContaining({ shasToDrop: [misroutedCommit.sha] }));
    // FNXC:LifecycleContainment 2026-10-07-18:04: the repaired branch is retried in place with its worktree kept.
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-4428", "todo", expect.anything());
    expect(scheduleInPlaceExecutionResume).toHaveBeenCalledWith("FN-4428");
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-4428", expect.objectContaining({ worktree: null }));
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "task:auto-recover-misrouted-foreign-commit" }));
  });

  it("keeps escalation path for foreign commits that touch shared paths", async () => {
    const store = createMockStore();
    const foreignCommit = {
      sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      subject: "fix(FN-5001): mixed paths",
      foreignTaskId: "FN-5001",
    };
    const contamination = new branchConflicts.BranchCrossContaminationError({
      branchName: "fusion/fn-4428",
      baseSha: "abc123",
      taskId: "FN-4428",
      foreignCommits: [foreignCommit],
    });

    mockedCreateFnAgent.mockRejectedValueOnce(contamination);
    vi.spyOn(branchConflicts, "classifyBootstrapMisbinding").mockResolvedValueOnce({ isBootstrapMisbinding: false, ownCommitCount: 1, foreignCommitCount: 0, nonAttributedCount: 0 });
    vi.spyOn(branchConflicts, "classifyForeignCommits").mockResolvedValueOnce({ alreadyUpstream: [], unique: [foreignCommit] });
    vi.spyOn(branchConflicts, "classifyMisroutedForeignCommit").mockResolvedValueOnce({
      misrouted: false,
      foreignTaskId: "FN-5001",
      paths: [".changeset/fn-5001-fix.md", "packages/engine/src/executor.ts"],
    });
    const recoverySpy = vi.spyOn(branchConflicts, "autoRecoverCrossContamination").mockResolvedValueOnce({
      newTipSha: "2222222222222222222222222222222222222222",
      droppedShas: [],
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    expect(recoverySpy).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith("FN-4428", expect.objectContaining({ status: "failed", paused: true, pausedReason: "branch-cross-contamination" }));
  });

  it("falls back to terminal contamination failure when bootstrap reanchor throws", async () => {
    const store = createMockStore();
    const contamination = new branchConflicts.BranchCrossContaminationError({
      branchName: "fusion/fn-4488",
      baseSha: "abc123",
      taskId: "FN-4488",
      foreignCommits: [{ sha: "1111111111111111111111111111111111111111", subject: "feat(FN-4367): dep", foreignTaskId: "FN-4367" }],
    });

    mockedCreateFnAgent.mockRejectedValueOnce(contamination);
    vi.spyOn(branchConflicts, "classifyBootstrapMisbinding").mockResolvedValueOnce({ isBootstrapMisbinding: true, ownCommitCount: 0, foreignCommitCount: 1, nonAttributedCount: 0 });
    vi.spyOn(branchConflicts, "reanchorBranchToBase").mockRejectedValueOnce(new Error("reanchor failed"));
    vi.spyOn(branchConflicts, "classifyForeignCommits").mockResolvedValueOnce({ alreadyUpstream: [], unique: contamination.foreignCommits });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({ ...makeTask(), id: "FN-4488", branch: "fusion/fn-4488" } as any);

    expect(store.updateTask).toHaveBeenCalledWith("FN-4488", expect.objectContaining({ status: "failed", paused: true, pausedReason: "branch-cross-contamination" }));
  });
});
