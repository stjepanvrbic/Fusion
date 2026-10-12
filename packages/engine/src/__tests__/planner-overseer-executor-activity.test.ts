/*
 * FNXC:PlannerOversight 2026-10-12-00:50:
 * Drives ProjectEngine's real planner-overseer poll with a real monitor and a real recovery controller wired to the real recovery handlers, over an in-memory store whose writes behave like production: the overseer's feed line and steering comment land in the task log and bump updatedAt.
 *
 * THE INVARIANT: a card is nudged only after a full threshold with no execution activity.
 * A card that keeps working past the threshold is never reported stuck and receives no steering comment.
 * A card that is truly silent is still reported stuck, is nudged exactly the bounded number of times, and the overseer's own writes do not restart its stall clock.
 * A card that recovers and later stalls again gets a fresh budget and a fresh escalation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PLANNER_OVERSEER_EXECUTOR_STUCK_AFTER_MS,
  PLANNER_RECOVERY_MAX_ATTEMPTS,
  formatStepTransitionLogAction,
  type RunAuditEventInput,
  type StepStatus,
  type Task,
} from "@fusion/core";
import { ProjectEngine } from "../project-engine.js";
import { PlannerOverseerMonitor } from "../overseer/planner-overseer.js";
import { PlannerRecoveryController } from "../overseer/planner-recovery-controller.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const THRESHOLD_MS = DEFAULT_PLANNER_OVERSEER_EXECUTOR_STUCK_AFTER_MS;
const POLL_INTERVAL_MS = 45 * SECOND;
const START = Date.UTC(2026, 9, 12, 0, 12, 30);
const TASK_ID = "FN-2000";

function isoMsAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeStore(task: Task) {
  const store = {
    task,
    agentLog: [] as Array<{ timestamp: string }>,
    auditEvents: [] as RunAuditEventInput[],
    getAgentLogs: vi.fn(async (_taskId: string, options?: { limit?: number }) =>
      options?.limit == null ? store.agentLog : store.agentLog.slice(-options.limit),
    ),
    addSteeringComment: vi.fn(async (_taskId: string, text: string, author: string) => {
      store.task.log.push({ timestamp: nowIso(), action: `Comment added by ${author}` });
      store.task.log.push({ timestamp: nowIso(), action: `Comment received mid-execution: ${text}` });
      store.task.updatedAt = nowIso();
      return store.task;
    }),
    async logEntry(_taskId: string, action: string) {
      store.task.log.push({ timestamp: nowIso(), action });
      store.task.updatedAt = nowIso();
      return store.task;
    },
    async recordRunAuditEvent(event: RunAuditEventInput) {
      store.auditEvents.push(event);
    },
    getRunAuditEvents() {
      return [];
    },
    async listTasks({ column }: { column: string }) {
      return store.task.column === column ? [store.task] : [];
    },
    async getSettings() {
      return { autoMerge: true };
    },
    getTaskWorkflowSelection() {
      return { workflowId: "builtin:coding", stepIds: [] };
    },
    async getWorkflowDefinition() {
      return undefined;
    },
    getWorkflowSettingsProjectId() {
      return "planner-overseer-executor-activity";
    },
    getWorkflowSettingValues() {
      return { plannerOversightLevel: "autonomous", plannerOverseerExecutorStuckAfterMs: THRESHOLD_MS };
    },
  };
  return store;
}

type PollStore = ReturnType<typeof makeStore>;

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: TASK_ID,
    title: "Long-running execution",
    description: "Planner overseer executor-activity fixture",
    column: "in-progress",
    status: null,
    priority: "normal",
    dependencies: [],
    steps: [],
    log: [],
    createdAt: isoMsAgo(6 * HOUR),
    updatedAt: isoMsAgo(6 * HOUR),
    ...overrides,
  } as Task;
}

function stepTransition(msAgo: number, stepIndex: number, status: StepStatus) {
  return { timestamp: isoMsAgo(msAgo), action: formatStepTransitionLogAction(stepIndex, "Implementation", status) };
}

function makeEngine(store: PollStore) {
  const engine = Object.create(ProjectEngine.prototype) as any;
  const monitor = new PlannerOverseerMonitor({ store });
  const controller = new PlannerRecoveryController({
    snapshotProvider: monitor,
    handlers: engine.buildPlannerRecoveryHandlers(store),
  });
  engine.plannerOverseer = monitor;
  engine.plannerRecoveryController = controller;
  engine.shuttingDown = false;
  engine.sessionAdvisor = undefined;
  engine.sessionAdvisorLogCursor = new Map();
  engine.plannerObservationEmitDedup = new Map();
  engine.plannerEscalationEmitDedup = new Set();
  engine.plannerLiveRetrySkipLogDedup = new Set();
  return { engine, monitor, controller };
}

/** Runs `count` polls. The first runs at the current clock; each later one runs one poll interval after the previous. */
async function poll(engine: any, store: PollStore, count: number, afterPoll?: () => void): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    if (index > 0) vi.setSystemTime(Date.now() + POLL_INTERVAL_MS);
    await engine.pollPlannerOverseer(store);
    afterPoll?.();
  }
}

function latestSignal(monitor: PlannerOverseerMonitor): string | undefined {
  return monitor.getObservations(TASK_ID).at(-1)?.signal;
}

function stuckFeedLines(store: PollStore): string[] {
  return store.task.log.map((entry) => entry.action).filter((action) => action.includes("signal=stuck"));
}

function escalations(store: PollStore): RunAuditEventInput[] {
  return store.auditEvents.filter(
    (event) => event.mutationType === "overseer:intervention" && event.metadata?.action === "escalate",
  );
}

describe("planner overseer poll — executor stall follows execution activity", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not report or nudge a card that entered the lane over two hours ago and changed step status seconds ago", async () => {
    const store = makeStore(
      makeTask({
        columnMovedAt: isoMsAgo(THRESHOLD_MS + 8 * SECOND),
        updatedAt: isoMsAgo(24 * SECOND),
        log: [stepTransition(24 * SECOND, 4, "done"), stepTransition(24 * SECOND, 5, "in-progress")],
      }),
    );
    const { engine, monitor, controller } = makeEngine(store);

    await poll(engine, store, 3, () => expect(latestSignal(monitor)).toBe("progressing"));

    expect(monitor.getObservations(TASK_ID)).toHaveLength(3);
    expect(store.addSteeringComment).not.toHaveBeenCalled();
    expect(stuckFeedLines(store)).toEqual([]);
    expect(controller.getAttemptCount(TASK_ID, "executor")).toBe(0);
    expect(escalations(store)).toEqual([]);
    expect(store.getAgentLogs).not.toHaveBeenCalled();
  });

  it("does not report or nudge a card whose only recent activity is in the agent log", async () => {
    const store = makeStore(makeTask({ columnMovedAt: isoMsAgo(3 * HOUR), log: [stepTransition(2.5 * HOUR, 3, "in-progress")] }));
    store.agentLog.push({ timestamp: isoMsAgo(2.5 * HOUR) }, { timestamp: isoMsAgo(2 * MINUTE) });
    const { engine, monitor, controller } = makeEngine(store);

    await poll(engine, store, 3, () => expect(latestSignal(monitor)).toBe("progressing"));

    expect(store.getAgentLogs).toHaveBeenCalledWith(TASK_ID, { limit: 1 });
    expect(store.addSteeringComment).not.toHaveBeenCalled();
    expect(stuckFeedLines(store)).toEqual([]);
    expect(controller.getAttemptCount(TASK_ID, "executor")).toBe(0);
  });

  it("keeps reporting a truly idle card as stuck through its own interventions, then gives a recovered card a fresh budget and a fresh escalation", async () => {
    const store = makeStore(makeTask({ columnMovedAt: isoMsAgo(3 * HOUR), log: [stepTransition(2.5 * HOUR, 3, "in-progress")] }));
    store.agentLog.push({ timestamp: isoMsAgo(2.5 * HOUR) });
    const { engine, monitor, controller } = makeEngine(store);

    // The store bumps updatedAt and appends overseer-authored log lines on every intervention; none of that is activity.
    await poll(engine, store, 6, () => expect(latestSignal(monitor)).toBe("stuck"));

    expect(store.addSteeringComment).toHaveBeenCalledTimes(PLANNER_RECOVERY_MAX_ATTEMPTS);
    expect(store.addSteeringComment).toHaveBeenLastCalledWith(
      TASK_ID,
      expect.stringContaining('[planner-oversight] Stage "executor" signal "stuck"'),
      "agent",
    );
    expect(Date.parse(store.task.updatedAt)).toBeGreaterThan(START);
    expect(controller.getAttemptCount(TASK_ID, "executor")).toBe(PLANNER_RECOVERY_MAX_ATTEMPTS);
    expect(escalations(store)).toHaveLength(1);

    // Real forward progress: the stall clock restarts and the budget is restored.
    vi.setSystemTime(Date.now() + POLL_INTERVAL_MS);
    store.task.log.push(stepTransition(0, 3, "done"));
    await poll(engine, store, 1);
    expect(latestSignal(monitor)).toBe("progressing");
    expect(controller.getAttemptCount(TASK_ID, "executor")).toBe(0);

    // A second real stall, a full threshold of silence later.
    vi.setSystemTime(Date.now() + THRESHOLD_MS + MINUTE);
    await poll(engine, store, 5, () => expect(latestSignal(monitor)).toBe("stuck"));

    expect(store.addSteeringComment).toHaveBeenCalledTimes(2 * PLANNER_RECOVERY_MAX_ATTEMPTS);
    expect(escalations(store)).toHaveLength(2);
  });
});
