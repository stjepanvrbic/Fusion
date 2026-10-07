/*
FNXC:WorktreeAcquisition 2026-10-07-18:20:
Heartbeat worktree-acquisition recovery stays in the card's current lifecycle role on every board shape.
It used to requeue the card through the rebound target (hold, else intake, else first column), which moved WIP cards backward and, on a board without a hold lane, into intake where they were re-triaged as new work.
These cases pin containment on renamed lanes and on a board that declares no hold lane at all, so the intake fallthrough can never return.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Agent, AgentHeartbeatRun, WorkflowIr } from "@fusion/core";
import { HeartbeatMonitor } from "../agent-heartbeat.js";
import * as worktreeAcquisition from "../worktree/worktree-acquisition.js";
import * as piModule from "../pi.js";

const WF = "custom:wf";

/** A workflow whose hold column is `drafting`; it declares no `todo` column. */
function renamedIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "inbox", name: "inbox", traits: [{ trait: "intake" }] },
      { id: "drafting", name: "drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "building", name: "building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "shipped", name: "shipped", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

/** A workflow with no hold lane, where the old rebound target fell through to intake. */
function noHoldIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "inbox", name: "inbox", traits: [{ trait: "intake" }] },
      { id: "building", name: "building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "shipped", name: "shipped", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

describe("heartbeat worktree-acquisition containment on custom boards", () => {
  let store: any;
  let taskStore: any;
  let liveTask: Record<string, unknown>;
  let ir: WorkflowIr;
  const agent: Agent = {
    id: "a1", name: "A", role: "executor", state: "active", taskId: "FN-1",
    createdAt: "", updatedAt: "", metadata: {},
  } as any;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(piModule, "createFnAgent").mockResolvedValue({ session: { prompt: vi.fn(), dispose: vi.fn() } } as any);

    const run: AgentHeartbeatRun = {
      id: "r1", agentId: "a1", status: "active", startedAt: new Date().toISOString(), endedAt: null,
    } as any;
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
    const selection = { workflowId: WF, stepIds: [] };
    ir = renamedIr();
    liveTask = { id: "FN-1", title: "t", description: "d", column: "building", dependencies: [], steps: [], log: [] };
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
      getTaskWorkflowSelection: vi.fn(() => selection),
      getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
      getWorkflowDefinition: vi.fn(async () => ({ ir })),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["renamed lanes", "building"],
    ["renamed lanes", "drafting"],
    ["no hold lane", "building"],
  ] as const)("keeps the card in place on %s (column %s) for in-budget and exhausted failures", async (board, column) => {
    ir = board === "no hold lane" ? noHoldIr() : renamedIr();
    liveTask = { ...liveTask, column };
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockRejectedValue(new Error("branch exists"));
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });

    for (let cycle = 0; cycle < 3; cycle++) {
      await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });
    }

    expect(taskStore.moveTask).not.toHaveBeenCalled();
    expect(liveTask).toMatchObject({ column, status: "failed", recoveryRetryCount: null });
  });

  it("treats the board's renamed complete lane as terminal", async () => {
    liveTask = { ...liveTask, column: "shipped", recoveryRetryCount: 1 };
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockRejectedValue(new Error("nope"));
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });

    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    expect(taskStore.moveTask).not.toHaveBeenCalled();
    expect(liveTask).toMatchObject({ column: "shipped", recoveryRetryCount: 1 });
    expect(liveTask.status).toBeUndefined();
  });
});
