/*
FNXC:AgentHeartbeat 2026-10-08-02:00:
KB-015 regression suite. `startRun` flips an agent `active -> running` before governance runs, and every
`skipStateTransition` exit (budget, global/engine pause, Memory Keeper, `invalid_state`, worktree, error parks)
used to close the run row while leaving the agent `running` until the hourly orphan reconcile. The invariant
under test: agent state `running` implies an active heartbeat run row, without relying on the reconciler.
The restore is a compare-and-set, so parks and operator pauses written during the run must survive.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_VALID_TRANSITIONS,
  type Agent,
  type AgentHeartbeatRun,
  type AgentState,
  type AgentStore,
  type TaskStore,
} from "@fusion/core";
import {
  HEARTBEAT_ERROR_RECOVERY_METADATA_KEY,
  HEARTBEAT_ERROR_RETRY_EXHAUSTED_PAUSE_REASON,
  HEARTBEAT_ERROR_UNRECOVERABLE_PAUSE_REASON,
} from "../agents/agent-heartbeat-error-recovery.js";

const memory = vi.hoisted(() => ({ resolve: vi.fn(), run: vi.fn(), ensure: vi.fn() }));
vi.mock("../memory/index.js", () => ({
  resolveMemoryConsolidationPorts: memory.resolve,
  MemoryConsolidationService: class { runConsolidationTick = memory.run; },
  MemoryConsolidationError: class MemoryConsolidationError extends Error {
    constructor(readonly stage: "graph" | "recall" | "cross-reference", message: string) { super(message); }
  },
}));
vi.mock("../agents/agent-instructions.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/agent-instructions.js")>("../agents/agent-instructions.js");
  return { ...actual, ensureDefaultHeartbeatProcedureFile: memory.ensure };
});
vi.mock("../logger.js", async () => {
  const { createMockLogger, formatMockError } = await import("./heartbeat-test-helpers.js");
  return {
    createLogger: vi.fn(() => createMockLogger()),
    heartbeatLog: createMockLogger(),
    formatError: formatMockError,
  };
});
vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn(),
  describeModel: vi.fn().mockReturnValue("mock-provider/mock-model"),
  promptWithFallback: vi.fn(),
}));

import { HeartbeatMonitor } from "../agent-heartbeat.js";
import { createFnAgent } from "../pi.js";

const AGENT_ID = "agent-skip";

function assertTransition(from: AgentState, to: AgentState): void {
  if (from === to) return;
  if (!AGENT_VALID_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid state transition: ${from} -> ${to}`);
  }
}

/** Stateful in-memory AgentStore fake that enforces AGENT_VALID_TRANSITIONS and tracks run rows. */
function createStatefulStore(initial: Partial<Agent> = {}) {
  let agent: Agent = {
    id: AGENT_ID,
    name: "Skip Agent",
    role: "engineer",
    state: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    metadata: {},
    runtimeConfig: { enabled: true },
    ...initial,
  } as Agent;
  const runs = new Map<string, AgentHeartbeatRun>();
  let sequence = 0;
  const budget = { isOverBudget: false, isOverThreshold: false, usagePercent: 0 };

  const store = {
    getAgent: vi.fn(async (id: string) => (id === agent.id ? structuredClone(agent) : null)),
    getCachedAgent: vi.fn(() => structuredClone(agent)),
    listAgents: vi.fn(async () => [structuredClone(agent)]),
    on: vi.fn(),
    off: vi.fn(),
    updateAgentState: vi.fn(async (id: string, next: AgentState) => {
      if (id !== agent.id) throw new Error(`Agent ${id} not found`);
      assertTransition(agent.state, next);
      agent = { ...agent, state: next };
      return structuredClone(agent);
    }),
    updateAgentStateIfCurrent: vi.fn(async (id: string, expected: AgentState, next: AgentState) => {
      if (id !== agent.id || agent.state !== expected) return null;
      assertTransition(agent.state, next);
      agent = { ...agent, state: next };
      return structuredClone(agent);
    }),
    updateAgent: vi.fn(async (_id: string, patch: Partial<Agent>) => {
      agent = { ...agent, ...patch };
      return structuredClone(agent);
    }),
    startHeartbeatRun: vi.fn(async (agentId: string) => {
      const run = {
        id: `run-${++sequence}`,
        agentId,
        startedAt: new Date().toISOString(),
        endedAt: null,
        status: "active",
      } as AgentHeartbeatRun;
      runs.set(run.id, run);
      return { ...run };
    }),
    saveRun: vi.fn(async (run: AgentHeartbeatRun) => { runs.set(run.id, { ...run }); }),
    getRunDetail: vi.fn(async (_agentId: string, runId: string) => runs.get(runId) ?? null),
    endHeartbeatRun: vi.fn(async (runId: string, status: AgentHeartbeatRun["status"]) => {
      const run = runs.get(runId);
      if (run) runs.set(runId, { ...run, status, endedAt: run.endedAt ?? new Date().toISOString() });
    }),
    getActiveHeartbeatRun: vi.fn(async (agentId: string) =>
      [...runs.values()].find((run) => run.agentId === agentId && run.status === "active") ?? null),
    appendRunLog: vi.fn(async () => undefined),
    recordHeartbeat: vi.fn(async () => undefined),
    getBudgetStatus: vi.fn(async () => ({ ...budget })),
    getAgentsByReportsTo: vi.fn(async () => []),
  } as unknown as AgentStore;

  return {
    store,
    budget,
    current: () => agent,
    seedActiveRun: () => {
      const run = { id: `run-${++sequence}`, agentId: AGENT_ID, startedAt: new Date().toISOString(), endedAt: null, status: "active" } as AgentHeartbeatRun;
      runs.set(run.id, run);
    },
  };
}

function createTaskStore(settings: Record<string, unknown> = {}, memoryEnabled: unknown = true): TaskStore {
  return {
    getSettings: vi.fn(async () => ({ ...settings })),
    getWorkflowSettingsProjectId: () => "project",
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getWorkflowDefinition: vi.fn(async () => undefined),
    getWorkflowSettingValues: vi.fn(() => ({ memoryConsolidationEnabled: memoryEnabled })),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getAsyncLayer: vi.fn(() => ({ projectId: "project" })),
  } as unknown as TaskStore;
}

/** The KB-015 invariant: a `running` agent always has an active run row. */
async function expectRunningImpliesActiveRun(store: AgentStore): Promise<void> {
  const agent = await store.getAgent(AGENT_ID);
  const activeRun = await store.getActiveHeartbeatRun(AGENT_ID);
  if (agent?.state === "running") {
    expect(activeRun).not.toBeNull();
  }
}

function consolidationOutcome() {
  return { graphChanged: false, graphRecoveryReason: null, parsedFiles: 0, reusedFiles: 1, prunedFiles: 0, nodeCount: 1, edgeCount: 0, recallCandidates: 1, recallCreated: 0, recallDuplicate: 1, crossRefUpdated: 0, crossRefUnchanged: 1, crossRefMissing: 0, semanticsWritten: 0, semanticsDeduped: 0, semanticsDroppedUnresolved: 0, durationMs: 1, changed: false };
}

beforeEach(() => {
  vi.clearAllMocks();
  memory.resolve.mockReset();
  memory.run.mockReset();
  memory.ensure.mockResolvedValue(undefined);
});

describe("heartbeat skip paths restore running -> active (KB-015)", () => {
  it.each([
    { name: "budget_exhausted (timer)", source: "timer" as const, overBudget: true, overThreshold: true, settings: {} },
    { name: "budget_exhausted (assignment)", source: "assignment" as const, overBudget: true, overThreshold: true, settings: {} },
    { name: "budget_exhausted (on_demand)", source: "on_demand" as const, overBudget: true, overThreshold: true, settings: {} },
    { name: "budget_threshold_exceeded (timer)", source: "timer" as const, overBudget: false, overThreshold: true, settings: {} },
    { name: "global_pause (timer)", source: "timer" as const, overBudget: false, overThreshold: false, settings: { globalPause: true } },
    { name: "global_pause (assignment)", source: "assignment" as const, overBudget: false, overThreshold: false, settings: { globalPause: true } },
    { name: "engine_paused (timer)", source: "timer" as const, overBudget: false, overThreshold: false, settings: { enginePaused: true } },
  ])("$name leaves an active agent active with no active run", async ({ source, overBudget, overThreshold, settings }) => {
    const f = createStatefulStore();
    f.budget.isOverBudget = overBudget;
    f.budget.isOverThreshold = overThreshold;
    const monitor = new HeartbeatMonitor({ store: f.store, taskStore: createTaskStore(settings), rootDir: process.cwd() });

    const run = await monitor.executeHeartbeat({ agentId: AGENT_ID, source });

    expect(run.status).toBe("completed");
    expect(vi.mocked(createFnAgent)).not.toHaveBeenCalled();
    expect(f.current().state).toBe("active");
    await expect(f.store.getActiveHeartbeatRun(AGENT_ID)).resolves.toBeNull();
    await expectRunningImpliesActiveRun(f.store);
  });

  it("restores a stale running agent to active after a governance skip", async () => {
    const f = createStatefulStore({ state: "running" });
    f.seedActiveRun();
    f.budget.isOverBudget = true;
    const monitor = new HeartbeatMonitor({ store: f.store, taskStore: createTaskStore(), rootDir: process.cwd() });

    await monitor.executeHeartbeat({ agentId: AGENT_ID, source: "timer" });

    expect(f.current().state).toBe("active");
    await expect(f.store.getActiveHeartbeatRun(AGENT_ID)).resolves.toBeNull();
    await expectRunningImpliesActiveRun(f.store);
  });

  describe("Memory Keeper skips", () => {
    const memoryAgent = { metadata: { builtInMemoryAgent: true } } as Partial<Agent>;

    it("disabled consolidation ends active", async () => {
      const f = createStatefulStore(memoryAgent);
      const monitor = new HeartbeatMonitor({ store: f.store, taskStore: createTaskStore({}, false), rootDir: process.cwd() });

      const run = await monitor.executeHeartbeat({ agentId: AGENT_ID, source: "timer" });

      expect(run.resultJson).toMatchObject({ reason: "memory_consolidation_disabled" });
      expect(memory.run).not.toHaveBeenCalled();
      expect(f.current().state).toBe("active");
      await expect(f.store.getActiveHeartbeatRun(AGENT_ID)).resolves.toBeNull();
      await expectRunningImpliesActiveRun(f.store);
    });

    it("unavailable consolidation ends active", async () => {
      memory.resolve.mockResolvedValue({ status: "unavailable", reason: "no-data-layer" });
      const f = createStatefulStore(memoryAgent);
      const monitor = new HeartbeatMonitor({ store: f.store, taskStore: createTaskStore(), rootDir: process.cwd() });

      const run = await monitor.executeHeartbeat({ agentId: AGENT_ID, source: "timer" });

      expect(run.resultJson).toMatchObject({ reason: "memory_consolidation_unavailable" });
      expect(f.current().state).toBe("active");
      await expect(f.store.getActiveHeartbeatRun(AGENT_ID)).resolves.toBeNull();
      await expectRunningImpliesActiveRun(f.store);
    });

    it("a successful consolidation tick ends active", async () => {
      memory.resolve.mockResolvedValue({ status: "ready", projectId: "project", ports: {} });
      memory.run.mockResolvedValue(consolidationOutcome());
      const f = createStatefulStore(memoryAgent);
      const monitor = new HeartbeatMonitor({ store: f.store, taskStore: createTaskStore(), rootDir: process.cwd() });

      const run = await monitor.executeHeartbeat({ agentId: AGENT_ID, source: "timer" });

      expect(run.resultJson).toMatchObject({ reason: "memory_consolidation" });
      expect(memory.run).toHaveBeenCalledOnce();
      expect(f.current().state).toBe("active");
      await expect(f.store.getActiveHeartbeatRun(AGENT_ID)).resolves.toBeNull();
      await expectRunningImpliesActiveRun(f.store);
    });
  });

  describe("restore is a no-op when the run parked or paused the agent", () => {
    it("error-recovery exhaustion stays paused with its pause reason", async () => {
      const f = createStatefulStore({
        state: "error",
        lastError: "session stream ended unexpectedly",
        metadata: { [HEARTBEAT_ERROR_RECOVERY_METADATA_KEY]: { consecutiveAttempts: 5 } },
      });
      const monitor = new HeartbeatMonitor({ store: f.store, taskStore: createTaskStore(), rootDir: process.cwd() });

      await monitor.executeHeartbeat({ agentId: AGENT_ID, source: "timer" });

      expect(f.current()).toMatchObject({ state: "paused", pauseReason: HEARTBEAT_ERROR_RETRY_EXHAUSTED_PAUSE_REASON });
      await expect(f.store.getActiveHeartbeatRun(AGENT_ID)).resolves.toBeNull();
      await expectRunningImpliesActiveRun(f.store);
    });

    it("an unrecoverable error park stays paused with its pause reason", async () => {
      const f = createStatefulStore({ state: "error", lastError: "Invalid API key for provider" });
      const monitor = new HeartbeatMonitor({ store: f.store, taskStore: createTaskStore(), rootDir: process.cwd() });

      await monitor.executeHeartbeat({ agentId: AGENT_ID, source: "timer" });

      expect(f.current()).toMatchObject({ state: "paused", pauseReason: HEARTBEAT_ERROR_UNRECOVERABLE_PAUSE_REASON });
      await expect(f.store.getActiveHeartbeatRun(AGENT_ID)).resolves.toBeNull();
      await expectRunningImpliesActiveRun(f.store);
    });

    it("a paused agent that hits a governance skip stays paused", async () => {
      const f = createStatefulStore({ state: "paused", pauseReason: "user-requested" });
      f.budget.isOverBudget = true;
      const monitor = new HeartbeatMonitor({ store: f.store, taskStore: createTaskStore(), rootDir: process.cwd() });

      await monitor.executeHeartbeat({ agentId: AGENT_ID, source: "assignment" });

      expect(f.current()).toMatchObject({ state: "paused", pauseReason: "user-requested" });
      await expect(f.store.getActiveHeartbeatRun(AGENT_ID)).resolves.toBeNull();
      await expectRunningImpliesActiveRun(f.store);
    });

    it("an operator pause written during the run survives the skip completion", async () => {
      const f = createStatefulStore();
      const monitor = new HeartbeatMonitor({ store: f.store, taskStore: createTaskStore(), rootDir: process.cwd() });

      const run = await monitor.startRun(AGENT_ID, { source: "timer" });
      expect(f.current().state).toBe("running");
      await f.store.updateAgentState(AGENT_ID, "paused");
      await monitor.completeRun(AGENT_ID, run.id, { status: "completed", resultJson: { reason: "global_pause" }, skipStateTransition: true });

      expect(f.current().state).toBe("paused");
      await expect(f.store.getActiveHeartbeatRun(AGENT_ID)).resolves.toBeNull();
      await expectRunningImpliesActiveRun(f.store);
    });
  });

  it("a worktree acquisition skip completion ends active", async () => {
    const f = createStatefulStore();
    const monitor = new HeartbeatMonitor({ store: f.store, taskStore: createTaskStore(), rootDir: process.cwd() });

    const run = await monitor.startRun(AGENT_ID, { source: "assignment" });
    expect(f.current().state).toBe("running");
    await expectRunningImpliesActiveRun(f.store);
    await monitor.completeRun(AGENT_ID, run.id, {
      status: "completed",
      resultJson: { reason: "worktree_acquisition_failed" },
      skipStateTransition: true,
    });

    expect(f.current().state).toBe("active");
    await expect(f.store.getActiveHeartbeatRun(AGENT_ID)).resolves.toBeNull();
    await expectRunningImpliesActiveRun(f.store);
  });
});
