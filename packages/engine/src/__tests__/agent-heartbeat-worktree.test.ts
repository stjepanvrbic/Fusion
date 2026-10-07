import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Agent, AgentHeartbeatRun } from "@fusion/core";
import { HeartbeatMonitor } from "../agent-heartbeat.js";
import * as worktreeAcquisition from "../worktree/worktree-acquisition.js";
import * as piModule from "../pi.js";

/*
FNXC:WorktreeAcquisition 2026-10-07-18:02:
A heartbeat worktree-acquisition failure is worktree recovery, which lifecycle containment keeps in the card's current lifecycle role.
The card never moves: in-budget failures only bump recoveryRetryCount, base-refresh refusals only log, and exhaustion parks the card `failed` in place.
Every recovery write is decided against the live row, so a terminal card, a user or approval pause, and an autoMerge:false review card are never mutated.
*/
describe("heartbeat worktree cwd", () => {
  let store: any;
  let taskStore: any;
  let liveTask: Record<string, unknown>;
  const agent: Agent = { id: "a1", name: "A", role: "executor", state: "active", taskId: "FN-1", createdAt: "", updatedAt: "", metadata: {} } as any;
  const baseTask = (patch: Record<string, unknown> = {}) => ({ id: "FN-1", title: "t", description: "d", column: "todo", dependencies: [], steps: [], log: [], ...patch });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(piModule, "createFnAgent").mockResolvedValue({ session: { prompt: vi.fn(), dispose: vi.fn() } } as any);
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockResolvedValue({ worktreePath: "/tmp/wt", branch: "fusion/fn-1", source: "existing", hydrated: false, isResume: true });

    const run: AgentHeartbeatRun = { id: "r1", agentId: "a1", status: "active", startedAt: new Date().toISOString(), endedAt: null } as any;
    store = {
      startHeartbeatRun: vi.fn().mockResolvedValue(run),
      saveRun: vi.fn(),
      getRunDetail: vi.fn().mockResolvedValue(run),
      getAgent: vi.fn().mockResolvedValue(agent),
      updateAgentState: vi.fn(),
      updateAgent: vi.fn(),
      endHeartbeatRun: vi.fn(),
      assignTask: vi.fn(),
      getBudgetStatus: vi.fn().mockResolvedValue({ isOverBudget: false, isOverThreshold: false, usagePercent: 0 }),
      getCachedAgent: vi.fn().mockReturnValue(null),
      getLastBlockedState: vi.fn().mockResolvedValue(null),
      setLastBlockedState: vi.fn(),
      clearLastBlockedState: vi.fn(),
      appendRunLog: vi.fn(),
      getAgentsByReportsTo: vi.fn().mockResolvedValue([]),
      recordHeartbeat: vi.fn(),
    };
    liveTask = baseTask();
    taskStore = {
      getSettings: vi.fn().mockResolvedValue({}),
      getTask: vi.fn(async () => ({ ...liveTask })),
      moveTask: vi.fn(),
      updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
        liveTask = { ...liveTask, ...patch };
        return liveTask;
      }),
      updateTaskAtomic: vi.fn(async (_id: string, updater: (current: Record<string, unknown>) => unknown) => {
        const patch = await updater({ ...liveTask });
        if (patch) liveTask = { ...liveTask, ...(patch as Record<string, unknown>) };
        return liveTask;
      }),
      logEntry: vi.fn(),
      appendAgentLog: vi.fn(),
      listTasks: vi.fn().mockResolvedValue([]),
      selectNextTaskForAgent: vi.fn().mockResolvedValue(null),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refreshes acquired worktree before creating task-scoped session", async () => {
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });
    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    expect(worktreeAcquisition.acquireTaskWorktree).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({ id: "FN-1" }),
      refreshStaleBase: true,
    }));
    expect(piModule.createFnAgent).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/tmp/wt" }));
    expect(worktreeAcquisition.acquireTaskWorktree.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(piModule.createFnAgent).mock.invocationCallOrder[0],
    );
  });

  it("uses rootDir for no-task runs", async () => {
    store.getAgent.mockResolvedValue({ ...agent, taskId: undefined, soul: "x" });
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });
    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });
    expect(worktreeAcquisition.acquireTaskWorktree).not.toHaveBeenCalled();
    expect(piModule.createFnAgent).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo" }));
  });

  it.each(["todo", "in-progress", "in-review"])("keeps a %s card in place and bumps the retry counter on an in-budget failure", async (column) => {
    liveTask = baseTask({ column });
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockRejectedValueOnce(new Error("EBUSY: resource busy or locked"));
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });

    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    expect(piModule.createFnAgent).not.toHaveBeenCalled();
    expect(taskStore.moveTask).not.toHaveBeenCalled();
    expect(liveTask.column).toBe(column);
    expect(liveTask.recoveryRetryCount).toBe(1);
    expect(liveTask.status).toBeUndefined();
    expect(store.saveRun).toHaveBeenLastCalledWith(expect.objectContaining({
      resultJson: expect.objectContaining({ reason: "worktree_acquisition_failed", attempt: 1, retryCapExhausted: false }),
    }));
  });

  it("parks typed base-refresh refusals in place without consuming acquisition retries", async () => {
    /*
    FNXC:WorktreeBaseRefresh 2026-08-01-16:33:
    A stale checkout is a deliberate no-session outcome. It must retain the concrete reason for
    the next heartbeat rather than converting into the unrelated acquisition retry cap.
    */
    liveTask = baseTask({ column: "in-progress" });
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockRejectedValueOnce(
      new worktreeAcquisition.WorktreeBaseRefreshError({
        kind: "base-reconciliation-required",
        executionSafe: false,
        durableBaseSha: "c0",
        baseSha: "c1",
      }),
    );
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });

    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    expect(piModule.createFnAgent).not.toHaveBeenCalled();
    expect(liveTask.recoveryRetryCount).toBeUndefined();
    expect(taskStore.logEntry).toHaveBeenCalledWith(
      "FN-1",
      "Worktree base refresh blocked heartbeat execution (base-reconciliation-required)",
      expect.any(String),
    );
    expect(taskStore.moveTask).not.toHaveBeenCalled();
    expect(liveTask.column).toBe("in-progress");
  });

  // FN-7721 regression: reproduces the reported "worktree-setup loop" symptom
  // (identical `git worktree add -b <branch>` failure repeated indefinitely
  // across heartbeat cycles) and asserts the loop is bounded: after
  // MAX_HEARTBEAT_WORKTREE_ACQUISITION_RETRIES (3) consecutive cross-heartbeat
  // failures the task is terminally marked failed, in place.
  it("terminally fails the task in place after the bounded retry cap is hit (FN-7721)", async () => {
    liveTask = baseTask({ column: "in-progress" });
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockRejectedValue(
      new Error("fatal: a branch named 'fusion/fn-1' already exists"),
    );
    const onTaskAcquisitionExhausted = vi.fn();
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo", onTaskAcquisitionExhausted });

    for (let cycle = 0; cycle < 3; cycle++) {
      await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });
    }

    expect(worktreeAcquisition.acquireTaskWorktree).toHaveBeenCalledTimes(3);
    expect(liveTask).toMatchObject({ column: "in-progress", status: "failed", recoveryRetryCount: null });
    expect(String(liveTask.error)).toContain("Worktree acquisition failed after 3 heartbeat attempts");
    expect(taskStore.moveTask).not.toHaveBeenCalled();
    expect(onTaskAcquisitionExhausted).toHaveBeenCalledTimes(1);
    expect(onTaskAcquisitionExhausted.mock.calls[0][0]).toBe("FN-1");
  });

  it("never writes recovery state onto a terminal card", async () => {
    liveTask = baseTask({ column: "done", recoveryRetryCount: 2 });
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockRejectedValue(new Error("nope"));
    const onTaskAcquisitionExhausted = vi.fn();
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo", onTaskAcquisitionExhausted });

    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    expect(liveTask).toMatchObject({ column: "done", recoveryRetryCount: 2 });
    expect(liveTask.status).toBeUndefined();
    expect(taskStore.moveTask).not.toHaveBeenCalled();
    expect(onTaskAcquisitionExhausted).not.toHaveBeenCalled();
  });

  it.each([
    ["user pause", { userPaused: true }],
    ["pause without an engine reason", { paused: true }],
  ])("honors a %s that lands while acquisition is failing, including at the retry cap", async (_label, pausePatch) => {
    liveTask = baseTask({ column: "in-progress", recoveryRetryCount: 2 });
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockImplementation(async () => {
      liveTask = { ...liveTask, ...pausePatch };
      throw new Error("EBUSY: resource busy or locked");
    });
    const onTaskAcquisitionExhausted = vi.fn();
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo", onTaskAcquisitionExhausted });

    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    expect(liveTask).toMatchObject({ column: "in-progress", recoveryRetryCount: 2, ...pausePatch });
    expect(liveTask.status).toBeUndefined();
    expect(taskStore.moveTask).not.toHaveBeenCalled();
    expect(onTaskAcquisitionExhausted).not.toHaveBeenCalled();
  });

  it("leaves an autoMerge:false review card for the human merge owner", async () => {
    liveTask = baseTask({ column: "in-review", recoveryRetryCount: 2 });
    taskStore.getSettings.mockResolvedValue({ autoMerge: false });
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockRejectedValue(new Error("nope"));
    const onTaskAcquisitionExhausted = vi.fn();
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo", onTaskAcquisitionExhausted });

    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    expect(liveTask).toMatchObject({ column: "in-review", recoveryRetryCount: 2 });
    expect(liveTask.status).toBeUndefined();
    expect(taskStore.moveTask).not.toHaveBeenCalled();
    expect(onTaskAcquisitionExhausted).not.toHaveBeenCalled();
  });

  it("still records a retry for a WIP card while project auto-merge is off", async () => {
    liveTask = baseTask({ column: "in-progress" });
    taskStore.getSettings.mockResolvedValue({ autoMerge: false });
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockRejectedValueOnce(new Error("nope"));
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });

    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    expect(liveTask).toMatchObject({ column: "in-progress", recoveryRetryCount: 1 });
    expect(taskStore.moveTask).not.toHaveBeenCalled();
  });
});
