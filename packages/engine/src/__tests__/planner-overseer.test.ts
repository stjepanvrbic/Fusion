import { describe, expect, it, vi } from "vitest";
import { formatStepTransitionLogAction, type StepStatus, type Task, type TaskLogEntry } from "@fusion/core";
import {
  OVERSEER_WATCHED_STAGES,
  PlannerOverseerMonitor,
  resolveWatchedStage,
  type OverseerTaskRef,
} from "../overseer/planner-overseer.js";

function taskFixture(overrides: Partial<Task> = {}): OverseerTaskRef {
  return {
    id: "FN-1000",
    column: "in-progress",
    prInfo: undefined,
    reviewState: undefined,
    paused: false,
    pausedReason: undefined,
    workflowTransitionNotification: undefined,
    ...overrides,
  } as OverseerTaskRef;
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-00:20:

THE INVARIANT: the watched stage comes from the column's ROLE, not from its id.

Keyed on the id, `resolveWatchedStage` returned null for every card on a renamed board — and
`observeTask` returns early on a null stage, so no observation was recorded, no
`overseer:intervention` was emitted, and `PlannerRecoveryController` had nothing to steer, retry or
targeted-fix. The whole oversight loop went inert and said nothing about it, which is why this is
worth a parameter rather than a fallback.

THE REVIEW TEST IS THE THREE-TRAIT UNION. `isReviewColumnRole` checks only `mergeBlocker ||
humanReview`, so a board whose review lane carries `merge` (mergeOrchestration) — the default's own
shape — would classify as not-in-review and be skipped. That case is asserted below precisely because
reaching for the obvious helper would have reintroduced the bug this change removes.

REVERT PROOF, measured: drop the `columnFlags` branch and the three renamed-lane cases fail with
`expected null to be "executor" / "merger"`.
*/
describe("resolveWatchedStage keys on the column role", () => {
  const wip = { countsTowardWip: true } as never;
  const mergeLane = { mergeOrchestration: true } as never;
  const humanReviewLane = { humanReview: true } as never;

  it("classifies a RENAMED wip lane as the executor stage", () => {
    expect(resolveWatchedStage(taskFixture({ column: "building" }), wip)).toBe("executor");
  });

  it("classifies a review lane that carries only mergeOrchestration", () => {
    // The union matters: `isReviewColumnRole` would answer false here and the card would be skipped.
    expect(resolveWatchedStage(taskFixture({ column: "signoff" }), mergeLane)).toBe("merger");
  });

  it("classifies a review lane that carries humanReview", () => {
    expect(resolveWatchedStage(taskFixture({ column: "waiting" }), humanReviewLane)).toBe("merger");
  });

  it("still returns null for a lane carrying neither role", () => {
    // The gate must still gate — watching every column would be its own defect.
    expect(resolveWatchedStage(taskFixture({ column: "shipped" }), { complete: true } as never)).toBeNull();
  });

  it("falls back to the legacy ids when no flags are supplied", () => {
    expect(resolveWatchedStage(taskFixture({ column: "in-progress" }))).toBe("executor");
    expect(resolveWatchedStage(taskFixture({ column: "todo" }))).toBeNull();
  });
});

describe("resolveWatchedStage", () => {
  it("resolves an active in-progress task to executor", () => {
    expect(resolveWatchedStage(taskFixture({ column: "in-progress" }))).toBe("executor");
  });

  it("resolves in-review with a pending reviewState to reviewer", () => {
    expect(
      resolveWatchedStage(
        taskFixture({
          column: "in-review",
          reviewState: {
            source: "reviewer-agent",
            items: [],
            addressing: [],
          } as unknown as OverseerTaskRef["reviewState"],
        }),
      ),
    ).toBe("reviewer");
  });

  it("resolves in-review with no reviewState/PR/gate marker to merger (awaiting integration)", () => {
    expect(resolveWatchedStage(taskFixture({ column: "in-review" }))).toBe("merger");
  });

  it("resolves in-review with an explicit manual-merge-hold marker to merger", () => {
    expect(
      resolveWatchedStage(
        taskFixture({
          column: "in-review",
          reviewState: {
            source: "reviewer-agent",
            items: [],
            addressing: [],
          } as unknown as OverseerTaskRef["reviewState"],
          workflowTransitionNotification: {
            kind: "manual-merge-hold",
            column: "in-review",
            transitionId: "t-1",
          } as unknown as OverseerTaskRef["workflowTransitionNotification"],
        }),
      ),
    ).toBe("merger");
  });

  it("resolves in-review with an active (open) PR to pull-request", () => {
    expect(
      resolveWatchedStage(
        taskFixture({
          column: "in-review",
          prInfo: {
            url: "https://github.com/o/r/pull/1",
            number: 1,
            status: "open",
            title: "t",
            headBranch: "h",
            baseBranch: "b",
            commentCount: 0,
          } as unknown as OverseerTaskRef["prInfo"],
        }),
      ),
    ).toBe("pull-request");
  });

  it("resolves a paused workflow-cli-approval gate to workflow-gate regardless of column", () => {
    expect(
      resolveWatchedStage(
        taskFixture({
          column: "in-progress",
          paused: true,
          pausedReason: "workflow-cli-approval:build: npm run build",
        }),
      ),
    ).toBe("workflow-gate");
  });

  it("resolves a paused workflow-input gate to workflow-gate", () => {
    expect(
      resolveWatchedStage(
        taskFixture({
          column: "in-review",
          paused: true,
          pausedReason: "workflow-input:ask: What environment?",
        }),
      ),
    ).toBe("workflow-gate");
  });

  it("returns null for non-monitorable columns (todo/done/archived/triage)", () => {
    for (const column of ["todo", "done", "archived", "triage"] as const) {
      expect(resolveWatchedStage(taskFixture({ column }))).toBeNull();
    }
  });

  it("deterministic precedence: workflow-gate wins over an active PR and reviewState in a compound state", () => {
    const compound = taskFixture({
      column: "in-review",
      paused: true,
      pausedReason: "workflow-cli-approval:deploy: run deploy",
      prInfo: {
        url: "https://github.com/o/r/pull/2",
        number: 2,
        status: "open",
        title: "t",
        headBranch: "h",
        baseBranch: "b",
        commentCount: 0,
      } as unknown as OverseerTaskRef["prInfo"],
      reviewState: {
        source: "reviewer-agent",
        items: [],
        addressing: [],
      } as unknown as OverseerTaskRef["reviewState"],
    });
    expect(resolveWatchedStage(compound)).toBe("workflow-gate");
  });

  it("deterministic precedence: an active PR wins over reviewState when no gate is paused", () => {
    const compound = taskFixture({
      column: "in-review",
      prInfo: {
        url: "https://github.com/o/r/pull/3",
        number: 3,
        status: "open",
        title: "t",
        headBranch: "h",
        baseBranch: "b",
        commentCount: 0,
      } as unknown as OverseerTaskRef["prInfo"],
      reviewState: {
        source: "reviewer-agent",
        items: [],
        addressing: [],
      } as unknown as OverseerTaskRef["reviewState"],
    });
    expect(resolveWatchedStage(compound)).toBe("pull-request");
  });

  it("never throws on a malformed/partial task (missing column/optional fields)", () => {
    expect(resolveWatchedStage({} as OverseerTaskRef)).toBeNull();
    expect(resolveWatchedStage(null)).toBeNull();
    expect(resolveWatchedStage(undefined)).toBeNull();
    expect(resolveWatchedStage({ id: "FN-1" } as OverseerTaskRef)).toBeNull();
  });
});

describe("PlannerOverseerMonitor.observeTask", () => {
  const stageFixtures: Array<{ stage: (typeof OVERSEER_WATCHED_STAGES)[number]; task: OverseerTaskRef }> = [
    { stage: "executor", task: taskFixture({ column: "in-progress" }) },
    {
      stage: "reviewer",
      task: taskFixture({
        column: "in-review",
        reviewState: { source: "reviewer-agent", items: [], addressing: [] } as unknown as OverseerTaskRef["reviewState"],
      }),
    },
    { stage: "merger", task: taskFixture({ column: "in-review" }) },
    {
      stage: "pull-request",
      task: taskFixture({
        column: "in-review",
        prInfo: {
          url: "https://github.com/o/r/pull/9",
          number: 9,
          status: "open",
          title: "t",
          headBranch: "h",
          baseBranch: "b",
          commentCount: 0,
        } as unknown as OverseerTaskRef["prInfo"],
      }),
    },
    {
      stage: "workflow-gate",
      task: taskFixture({ column: "in-progress", paused: true, pausedReason: "workflow-input:ask: env?" }),
    },
  ];

  it.each(stageFixtures)(
    "records exactly one observation for the $stage stage when level is not off",
    async ({ stage, task }) => {
      for (const level of ["observe", "steer", "autonomous"] as const) {
        const monitor = new PlannerOverseerMonitor();
        const observation = await monitor.observeTask(task, level);
        expect(observation).not.toBeNull();
        expect(observation?.stage).toBe(stage);
        expect(observation?.oversightLevel).toBe(level);
        expect(observation?.taskId).toBe(task.id);
        expect(observation?.sources.length).toBeGreaterThan(0);
        expect(monitor.getObservations(task.id)).toHaveLength(1);
      }
    },
  );

  it.each(stageFixtures)("records nothing and returns null for the $stage stage when level is off", async ({ task }) => {
    const monitor = new PlannerOverseerMonitor();
    const observation = await monitor.observeTask(task, "off");
    expect(observation).toBeNull();
    expect(monitor.getObservations(task.id)).toHaveLength(0);
  });

  it("returns null and records nothing when no stage is monitorable", async () => {
    const monitor = new PlannerOverseerMonitor();
    const observation = await monitor.observeTask(taskFixture({ column: "todo" }), "autonomous");
    expect(observation).toBeNull();
    expect(monitor.getObservations("FN-1000")).toHaveLength(0);
  });

  it("invokes the onObservation callback when provided", async () => {
    const onObservation = vi.fn().mockResolvedValue(undefined);
    const monitor = new PlannerOverseerMonitor({ onObservation });
    const task = taskFixture({ column: "in-progress" });
    const observation = await monitor.observeTask(task, "observe");
    expect(onObservation).toHaveBeenCalledTimes(1);
    expect(onObservation).toHaveBeenCalledWith(observation);
  });

  it("still resolves when the onObservation callback throws (best-effort)", async () => {
    const onObservation = vi.fn().mockRejectedValue(new Error("callback exploded"));
    const monitor = new PlannerOverseerMonitor({ onObservation });
    const task = taskFixture({ column: "in-progress" });
    await expect(monitor.observeTask(task, "observe")).resolves.not.toBeNull();
    expect(monitor.getObservations(task.id)).toHaveLength(1);
  });

  it("records into the store best-effort and swallows logEntry failures", async () => {
    const store = { logEntry: vi.fn().mockRejectedValue(new Error("log failed")) };
    const monitor = new PlannerOverseerMonitor({ store });
    const task = taskFixture({ column: "in-progress" });
    await expect(monitor.observeTask(task, "observe")).resolves.not.toBeNull();
    expect(store.logEntry).toHaveBeenCalledTimes(1);
  });

  // FN-7577: an unchanged heartbeat (same stage/signal/reason) must not re-write
  // the activity feed on every poll tick — only a CHANGE re-logs; clear() resets
  // the dedup so a re-run re-logs its first observation.
  it("dedupes consecutive identical feed entries, re-logs on signal change, resets on clear", async () => {
    const store = { logEntry: vi.fn().mockResolvedValue(undefined) };
    const monitor = new PlannerOverseerMonitor({ store });
    const task = taskFixture({ column: "in-progress" });

    // Three identical healthy ticks → a single feed entry.
    await monitor.observeTask(task, "observe");
    await monitor.observeTask(task, "observe");
    await monitor.observeTask(task, "observe");
    expect(store.logEntry).toHaveBeenCalledTimes(1);

    // Signal flips (executor paused → "blocked") → re-logs once.
    const paused = { ...task, paused: true, pausedReason: "gate" };
    await monitor.observeTask(paused, "observe");
    await monitor.observeTask(paused, "observe");
    expect(store.logEntry).toHaveBeenCalledTimes(2);

    // clear() drops the dedup key so the next identical observation re-logs.
    monitor.clear(task.id);
    await monitor.observeTask(paused, "observe");
    expect(store.logEntry).toHaveBeenCalledTimes(3);
  });

  it("bounds the per-task ring buffer to the configured cap, keeping the most recent N", async () => {
    const monitor = new PlannerOverseerMonitor({ maxObservationsPerTask: 3 });
    const task = taskFixture({ column: "in-progress" });
    const observations = [];
    for (let i = 0; i < 5; i++) {
      const obs = await monitor.observeTask(task, "observe");
      observations.push(obs);
    }
    const retained = monitor.getObservations(task.id);
    expect(retained).toHaveLength(3);
    // The three retained entries should be the last three recorded (index 2,3,4).
    expect(retained.map((o) => o.observedAt)).toEqual(
      [observations[2], observations[3], observations[4]].map((o) => o!.observedAt),
    );
  });

  it("defaults the ring buffer cap to 20 entries per task", async () => {
    const monitor = new PlannerOverseerMonitor();
    const task = taskFixture({ column: "in-progress" });
    for (let i = 0; i < 25; i++) {
      await monitor.observeTask(task, "observe");
    }
    expect(monitor.getObservations(task.id)).toHaveLength(20);
  });

  it("clear() removes retained observations for a task", async () => {
    const monitor = new PlannerOverseerMonitor();
    const task = taskFixture({ column: "in-progress" });
    await monitor.observeTask(task, "observe");
    expect(monitor.getObservations(task.id)).toHaveLength(1);
    monitor.clear(task.id);
    expect(monitor.getObservations(task.id)).toHaveLength(0);
    expect(monitor.getObservedTaskIds()).not.toContain(task.id);
  });

  it("never throws on a malformed/partial task passed to observeTask (degrades to no-op)", async () => {
    const monitor = new PlannerOverseerMonitor();
    await expect(monitor.observeTask({} as OverseerTaskRef, "autonomous")).resolves.toBeNull();
    await expect(monitor.observeTask(undefined as unknown as OverseerTaskRef, "autonomous")).resolves.toBeNull();
  });
});

/*
FNXC:PlannerOversight 2026-10-12-00:50:

THE INVARIANT: the executor stage is "stuck" only after a full threshold with no execution activity.

Activity is a step status transition recorded in the task log, or any agent-log entry, and never earlier than the lane entry. Time spent in the lane is not silence: a card whose agent keeps working past the threshold is healthy.
The overseer's own writes (its feed line, its steering comment, the executor's relay of that comment, and the `updatedAt` bumps they cause) are never activity, so the overseer cannot restart its own stall clock.
Unknown is never a stall: missing or malformed timestamps and a failed agent-log read report "progressing".
The agent log is a whole-file read, so it is consulted only when row evidence is already silent for the threshold.
*/
describe("PlannerOverseerMonitor.observeTask — executor stall detection", () => {
  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const THRESHOLD_MS = 2 * HOUR; // mirrors the declared setting default
  const NOW = Date.UTC(2026, 6, 9, 12, 0, 0);
  const observeOptions = { now: () => NOW, executorStuckAfterMs: THRESHOLD_MS };

  function isoMsAgo(ms: number): string {
    return new Date(NOW - ms).toISOString();
  }

  function stepTransition(msAgo: number, status: StepStatus = "done"): TaskLogEntry {
    return { timestamp: isoMsAgo(msAgo), action: formatStepTransitionLogAction(4, "Implementation", status) };
  }

  function logLine(msAgo: number, action: string): TaskLogEntry {
    return { timestamp: isoMsAgo(msAgo), action };
  }

  function agentLogEntry(msAgo: number, agent?: string) {
    return { timestamp: isoMsAgo(msAgo), taskId: "FN-1000", text: "bash", type: "tool", ...(agent ? { agent } : {}) };
  }

  function agentLogStore(entries: Array<{ timestamp: string }>) {
    return { getAgentLogs: vi.fn().mockResolvedValue(entries) };
  }

  /** Lane entry 3h old, newest step transition 2.5h old: row evidence is silent for the threshold. */
  function silentRow(overrides: Partial<Task> = {}): OverseerTaskRef {
    return taskFixture({ columnMovedAt: isoMsAgo(3 * HOUR), log: [stepTransition(2.5 * HOUR)], ...overrides });
  }

  it("reports progressing, without reading the agent log, when a step changed status seconds ago on a card long past the threshold in the lane", async () => {
    const store = agentLogStore([]);
    const monitor = new PlannerOverseerMonitor({ store });
    const task = taskFixture({
      columnMovedAt: isoMsAgo(THRESHOLD_MS + 8 * 1000),
      log: [stepTransition(24 * 1000, "done"), stepTransition(24 * 1000, "in-progress")],
    });

    const observation = await monitor.observeTask(task, "autonomous", observeOptions);

    expect(observation?.stage).toBe("executor");
    expect(observation?.signal).toBe("progressing");
    expect(store.getAgentLogs).not.toHaveBeenCalled();
  });

  it.each(["pending", "in-progress", "done", "skipped"] as const)("counts a recent step transition to %s as activity", async (status) => {
    const monitor = new PlannerOverseerMonitor();
    const task = taskFixture({ columnMovedAt: isoMsAgo(3 * HOUR), log: [stepTransition(MINUTE, status)] });

    expect((await monitor.observeTask(task, "autonomous", observeOptions))?.signal).toBe("progressing");
  });

  it("reports stuck from row evidence alone when the monitor has no agent-log seam, measured from the newest evidence", async () => {
    const monitor = new PlannerOverseerMonitor();

    const observation = await monitor.observeTask(silentRow(), "autonomous", observeOptions);

    expect(observation?.signal).toBe("stuck");
    expect(observation?.stage).toBe("executor");
    // 2.5h since the newest step transition, not 3h since the lane entry.
    expect(observation?.reason).toBe("Executor stage inactive for over 2h with no execution activity");
  });

  it.each([
    ["tagged with the executor role", "executor"],
    ["carrying no agent role", undefined],
  ])("reports progressing when the row is silent but the newest agent-log entry (%s) is recent", async (_label, agent) => {
    const store = agentLogStore([agentLogEntry(3 * MINUTE, agent)]);
    const monitor = new PlannerOverseerMonitor({ store });

    const observation = await monitor.observeTask(silentRow(), "autonomous", observeOptions);

    expect(observation?.signal).toBe("progressing");
    expect(store.getAgentLogs).toHaveBeenCalledTimes(1);
    expect(store.getAgentLogs).toHaveBeenCalledWith("FN-1000", { limit: 1 });
  });

  it("reports stuck when the row is silent and the agent log is empty", async () => {
    const monitor = new PlannerOverseerMonitor({ store: agentLogStore([]) });

    expect((await monitor.observeTask(silentRow(), "autonomous", observeOptions))?.signal).toBe("stuck");
  });

  it("reports stuck when the row is silent and the newest agent-log entry is also older than the threshold", async () => {
    const monitor = new PlannerOverseerMonitor({ store: agentLogStore([agentLogEntry(2.5 * HOUR)]) });

    expect((await monitor.observeTask(silentRow(), "autonomous", observeOptions))?.signal).toBe("stuck");
  });

  it("measures the stuck duration from the agent log when it holds the newest evidence", async () => {
    const monitor = new PlannerOverseerMonitor({ store: agentLogStore([agentLogEntry(2 * HOUR + 10 * MINUTE)]) });
    const task = taskFixture({ columnMovedAt: isoMsAgo(5 * HOUR) });

    const observation = await monitor.observeTask(task, "autonomous", observeOptions);

    expect(observation?.reason).toBe("Executor stage inactive for over 2h with no execution activity");
  });

  it.each([
    ["rejects", () => Promise.reject(new Error("agent log unreadable"))],
    [
      "throws",
      () => {
        throw new Error("agent log unreadable");
      },
    ],
  ])("reports progressing and warns once per task when the agent-log read %s", async (_label, failingRead) => {
    const store = { getAgentLogs: vi.fn(failingRead as () => Promise<Array<{ timestamp: string }>>) };
    const logger = { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const monitor = new PlannerOverseerMonitor({ store, logger });

    for (let poll = 0; poll < 3; poll += 1) {
      const observation = await monitor.observeTask(silentRow(), "autonomous", observeOptions);
      expect(observation?.signal).toBe("progressing");
    }
    expect(store.getAgentLogs).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain("FN-1000");

    // A read that succeeds re-arms the warning for the next failure.
    store.getAgentLogs.mockResolvedValueOnce([]);
    expect((await monitor.observeTask(silentRow(), "autonomous", observeOptions))?.signal).toBe("stuck");
    expect(logger.warn).toHaveBeenCalledTimes(1);

    expect((await monitor.observeTask(silentRow(), "autonomous", observeOptions))?.signal).toBe("progressing");
    expect((await monitor.observeTask(silentRow(), "autonomous", observeOptions))?.signal).toBe("progressing");
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("warns separately for each task whose agent-log read fails", async () => {
    const store = { getAgentLogs: vi.fn().mockRejectedValue(new Error("agent log unreadable")) };
    const logger = { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const monitor = new PlannerOverseerMonitor({ store, logger });

    await monitor.observeTask(silentRow({ id: "FN-1001" }), "autonomous", observeOptions);
    await monitor.observeTask(silentRow({ id: "FN-1002" }), "autonomous", observeOptions);
    await monitor.observeTask(silentRow({ id: "FN-1001" }), "autonomous", observeOptions);

    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("reports progressing and warns when the newest agent-log entry has an unparseable timestamp", async () => {
    const logger = { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const monitor = new PlannerOverseerMonitor({ store: agentLogStore([{ timestamp: "not-a-real-date" }]), logger });

    expect((await monitor.observeTask(silentRow(), "autonomous", observeOptions))?.signal).toBe("progressing");
    expect((await monitor.observeTask(silentRow(), "autonomous", observeOptions))?.signal).toBe("progressing");
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("stays stuck after the overseer's own writes land in the task log and bump updatedAt", async () => {
    const monitor = new PlannerOverseerMonitor({ store: agentLogStore([]) });
    const task = silentRow({ updatedAt: isoMsAgo(2.5 * HOUR) });
    const first = await monitor.observeTask(task, "autonomous", observeOptions);
    expect(first?.signal).toBe("stuck");

    const afterIntervention = silentRow({
      updatedAt: isoMsAgo(0),
      log: [
        stepTransition(2.5 * HOUR),
        logLine(0, `[planner] stage=executor signal=stuck: ${first?.reason}`),
        logLine(0, "Comment added by agent"),
        logLine(0, `Comment received mid-execution: [planner-oversight] Stage "executor" signal "stuck" — injecting steering guidance`),
      ],
    });

    expect((await monitor.observeTask(afterIntervention, "autonomous", observeOptions))?.signal).toBe("stuck");
  });

  it("does not count task-log entries other than step transitions as activity", async () => {
    const monitor = new PlannerOverseerMonitor({ store: agentLogStore([]) });
    const task = silentRow({
      log: [
        stepTransition(2.5 * HOUR),
        logLine(MINUTE, "queued — concurrency limit reached: 3/3 agents running"),
        logLine(MINUTE, "Comment added by user"),
        logLine(MINUTE, "Reset stuck-kill streak (forward progress: step 4 (Implementation) → done)"),
      ],
    });

    expect((await monitor.observeTask(task, "autonomous", observeOptions))?.signal).toBe("stuck");
  });

  it("does not treat a fresh updatedAt as execution activity", async () => {
    const monitor = new PlannerOverseerMonitor();
    const task = taskFixture({ updatedAt: isoMsAgo(1000), columnMovedAt: isoMsAgo(3 * HOUR) });

    expect((await monitor.observeTask(task, "autonomous", observeOptions))?.signal).toBe("stuck");
  });

  describe("without a lane-entry timestamp", () => {
    it("reports progressing for a recent step transition", async () => {
      const monitor = new PlannerOverseerMonitor();
      const task = taskFixture({ columnMovedAt: undefined, log: [stepTransition(MINUTE)] });

      expect((await monitor.observeTask(task, "autonomous", observeOptions))?.signal).toBe("progressing");
    });

    it("reports stuck when the only evidence is a step transition older than the threshold", async () => {
      const monitor = new PlannerOverseerMonitor();
      const task = taskFixture({ columnMovedAt: undefined, log: [stepTransition(3 * HOUR)] });

      const observation = await monitor.observeTask(task, "autonomous", observeOptions);

      expect(observation?.signal).toBe("stuck");
      expect(observation?.reason).toMatch(/inactive for over 3h/);
    });

    it("never produces a stall from a stale updatedAt alone", async () => {
      const store = agentLogStore([]);
      const monitor = new PlannerOverseerMonitor({ store });
      const task = taskFixture({ columnMovedAt: undefined, updatedAt: isoMsAgo(3 * HOUR), log: [] });

      expect((await monitor.observeTask(task, "autonomous", observeOptions))?.signal).toBe("progressing");
      expect(store.getAgentLogs).not.toHaveBeenCalled();
    });

    it("fails safe to progressing when there is no lane entry and no step transition at all", async () => {
      const monitor = new PlannerOverseerMonitor();
      const task = taskFixture({ columnMovedAt: undefined, updatedAt: undefined, log: undefined });

      expect((await monitor.observeTask(task, "autonomous", observeOptions))?.signal).toBe("progressing");
    });
  });

  it("fails safe to progressing when the lane-entry timestamp is malformed and nothing else is known", async () => {
    const monitor = new PlannerOverseerMonitor();
    const task = taskFixture({ columnMovedAt: "not-a-real-date", updatedAt: isoMsAgo(3 * HOUR) });

    expect((await monitor.observeTask(task, "autonomous", observeOptions))?.signal).toBe("progressing");
  });

  it("ignores a step transition whose timestamp is malformed", async () => {
    const monitor = new PlannerOverseerMonitor();
    const malformed = { ...stepTransition(MINUTE), timestamp: "not-a-real-date" };

    const withoutLaneEntry = taskFixture({ columnMovedAt: undefined, log: [malformed] });
    expect((await monitor.observeTask(withoutLaneEntry, "autonomous", observeOptions))?.signal).toBe("progressing");

    const withStaleLaneEntry = taskFixture({ columnMovedAt: isoMsAgo(3 * HOUR), log: [malformed] });
    expect((await monitor.observeTask(withStaleLaneEntry, "autonomous", observeOptions))?.signal).toBe("stuck");
  });

  it("treats an undefined task log as empty", async () => {
    const monitor = new PlannerOverseerMonitor();
    const task = taskFixture({ columnMovedAt: isoMsAgo(3 * HOUR), log: undefined });

    expect((await monitor.observeTask(task, "autonomous", observeOptions))?.signal).toBe("stuck");
  });

  it("uses the lane entry as a floor when the newest step transition predates it", async () => {
    const store = agentLogStore([]);
    const monitor = new PlannerOverseerMonitor({ store });
    const task = taskFixture({ columnMovedAt: isoMsAgo(5 * MINUTE), log: [stepTransition(6 * HOUR)] });

    expect((await monitor.observeTask(task, "autonomous", observeOptions))?.signal).toBe("progressing");
    expect(store.getAgentLogs).not.toHaveBeenCalled();
  });

  it.each([
    ["the lane entry", (msAgo: number) => taskFixture({ columnMovedAt: isoMsAgo(msAgo) })],
    ["a step transition", (msAgo: number) => taskFixture({ columnMovedAt: isoMsAgo(6 * HOUR), log: [stepTransition(msAgo)] })],
  ])("stays progressing one millisecond under the threshold and flips to stuck exactly at it, measured from %s", async (_label, build) => {
    const monitor = new PlannerOverseerMonitor();

    expect((await monitor.observeTask(build(THRESHOLD_MS - 1), "autonomous", observeOptions))?.signal).toBe("progressing");
    expect((await monitor.observeTask(build(THRESHOLD_MS), "autonomous", observeOptions))?.signal).toBe("stuck");
  });

  it("applies the same boundary to agent-log evidence", async () => {
    const underStore = agentLogStore([agentLogEntry(THRESHOLD_MS - 1)]);
    const atStore = agentLogStore([agentLogEntry(THRESHOLD_MS)]);

    const under = await new PlannerOverseerMonitor({ store: underStore }).observeTask(silentRow(), "autonomous", observeOptions);
    const at = await new PlannerOverseerMonitor({ store: atStore }).observeTask(silentRow(), "autonomous", observeOptions);

    expect(under?.signal).toBe("progressing");
    expect(at?.signal).toBe("stuck");
  });

  it("samples the clock once, so a card crossing the threshold mid-observation is never reported stuck without its agent log being read", async () => {
    const store = agentLogStore([agentLogEntry(MINUTE)]);
    const monitor = new PlannerOverseerMonitor({ store });
    const task = taskFixture({ columnMovedAt: isoMsAgo(THRESHOLD_MS - 1) });
    let samples = 0;
    const advancingClock = () => NOW + samples++ * 10;

    const observation = await monitor.observeTask(task, "autonomous", { now: advancingClock, executorStuckAfterMs: THRESHOLD_MS });

    expect(observation?.signal).toBe("progressing");
    expect(observation?.observedAt).toBe(NOW);
  });

  it("still reports blocked for a paused card with stale evidence, without reading the agent log", async () => {
    const store = agentLogStore([]);
    const monitor = new PlannerOverseerMonitor({ store });
    const task = silentRow({ paused: true, pausedReason: "some-engine-park-reason" });

    expect((await monitor.observeTask(task, "autonomous", observeOptions))?.signal).toBe("blocked");
    expect(store.getAgentLogs).not.toHaveBeenCalled();
  });

  it("still reports failed for a failed card with stale evidence, without reading the agent log", async () => {
    const store = agentLogStore([]);
    const monitor = new PlannerOverseerMonitor({ store });
    const task = silentRow({ status: "failed" });

    expect((await monitor.observeTask(task, "autonomous", observeOptions))?.signal).toBe("failed");
    expect(store.getAgentLogs).not.toHaveBeenCalled();
  });

  it.each([
    ["merger", {}],
    ["reviewer", { reviewState: { items: [], summary: {} } }],
  ])("never reads the agent log for the in-review %s stage", async (stage, overrides) => {
    const store = agentLogStore([]);
    const monitor = new PlannerOverseerMonitor({ store });
    const task = silentRow({ column: "in-review", ...(overrides as Partial<Task>) });

    const observation = await monitor.observeTask(task, "autonomous", observeOptions);

    expect(observation?.stage).toBe(stage);
    expect(observation?.signal).toBe("progressing");
    expect(store.getAgentLogs).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("runs no stall check when the threshold is %s", async (executorStuckAfterMs) => {
    const store = agentLogStore([]);
    const monitor = new PlannerOverseerMonitor({ store });

    const observation = await monitor.observeTask(silentRow(), "autonomous", { now: () => NOW, executorStuckAfterMs });

    expect(observation?.signal).toBe("progressing");
    expect(store.getAgentLogs).not.toHaveBeenCalled();
  });

  it("defaults the threshold to the declared 2h default when options omit it", async () => {
    const monitor = new PlannerOverseerMonitor();
    const staleTask = taskFixture({ columnMovedAt: isoMsAgo(4 * HOUR), log: [stepTransition(3 * HOUR)] });
    const freshTask = taskFixture({ columnMovedAt: isoMsAgo(4 * HOUR), log: [stepTransition(MINUTE)] });

    const staleObs = await monitor.observeTask(staleTask, "autonomous", { now: () => NOW });
    const freshObs = await monitor.observeTask(freshTask, "autonomous", { now: () => NOW });

    expect(staleObs?.signal).toBe("stuck");
    expect(freshObs?.signal).toBe("progressing");
  });

  // The feed dedup key must stay stable within an hour bucket so an ever-changing
  // millisecond-precise duration in the reason does not defeat dedup.
  it("keeps the stuck reason stable within the same inactivity-hour bucket for feed dedup", async () => {
    const store = { logEntry: vi.fn().mockResolvedValue(undefined) };
    const monitor = new PlannerOverseerMonitor({ store });
    const task = taskFixture({
      columnMovedAt: isoMsAgo(6 * HOUR),
      log: [stepTransition(THRESHOLD_MS + 5 * MINUTE)],
    });

    // Two polls a few seconds apart within the same inactivity-hour bucket.
    await monitor.observeTask(task, "observe", { now: () => NOW, executorStuckAfterMs: THRESHOLD_MS });
    await monitor.observeTask(task, "observe", { now: () => NOW + 5000, executorStuckAfterMs: THRESHOLD_MS });
    expect(store.logEntry).toHaveBeenCalledTimes(1);

    // An hour-boundary crossing is a real state change and re-logs once.
    await monitor.observeTask(task, "observe", { now: () => NOW + HOUR, executorStuckAfterMs: THRESHOLD_MS });
    expect(store.logEntry).toHaveBeenCalledTimes(2);
  });
});

// FNXC:PlannerOversight 2026-07-15-17:05:
// FN-7965: a task parked `status: "failed"` at the executor stage reported
// `progressing` ("Task is actively executing in-progress work") because the
// derivation never read `status` — so the overseer treated a dead task as healthy
// and only reacted once the FN-7743 stall proxy fired hours later. `failed` had
// been derived for the merger/pull-request stages only. These tests lock the
// invariant across the enumerated surfaces: failed (failed), failed-but-paused
// (blocked — a human owns it), healthy (progressing, unchanged), and the
// terminal columns that must stay unmonitored.
describe("PlannerOverseerMonitor.observeTask — FN-7965 executor failure detection", () => {
  it("reports failed for a non-paused in-progress task parked status=failed", async () => {
    const monitor = new PlannerOverseerMonitor();
    const task = taskFixture({
      column: "in-progress",
      status: "failed",
      updatedAt: new Date().toISOString(),
      columnMovedAt: new Date().toISOString(),
    });

    const observation = await monitor.observeTask(task, "autonomous");

    // Must NOT wait for the 2h stall proxy: the failure is visible immediately.
    expect(observation?.stage).toBe("executor");
    expect(observation?.signal).toBe("failed");
  });

  it("keeps paused precedence: a paused failed task is blocked, not failed", async () => {
    // A human owns an operator/user-paused row — it must never be routed into
    // autonomous bounded recovery just because status is failed.
    const monitor = new PlannerOverseerMonitor();
    const task = taskFixture({
      column: "in-progress",
      status: "failed",
      paused: true,
      pausedReason: "error-unrecoverable",
    });

    const observation = await monitor.observeTask(task, "autonomous");

    expect(observation?.signal).toBe("blocked");
  });

  it.each([undefined, null, "queued"])("still reports progressing for a healthy in-progress task (status=%s)", async (status) => {
    // Negative control: FN-7577 — a healthy card must never flip to a problem
    // signal, or every in-progress task shows the "recovering" badge.
    const monitor = new PlannerOverseerMonitor();
    const task = taskFixture({
      column: "in-progress",
      status: status as never,
      updatedAt: new Date().toISOString(),
      columnMovedAt: new Date().toISOString(),
    });

    const observation = await monitor.observeTask(task, "autonomous");

    expect(observation?.signal).toBe("progressing");
  });

  it("keeps the failed reason constant so the FN-7577 feed dedup holds", async () => {
    // The reason must not interpolate task.error/status, or an observation would
    // be re-emitted every poll for the same unchanged failure.
    const monitor = new PlannerOverseerMonitor();
    const a = await monitor.observeTask(taskFixture({ id: "FN-1000", status: "failed" }), "autonomous");
    const b = await monitor.observeTask(taskFixture({ id: "FN-1000", status: "failed" }), "autonomous");

    expect(a?.reason).toBe(b?.reason);
    expect(a?.reason).not.toMatch(/failed:|error/i);
  });
});

/*
FNXC:WorkflowReviewGates 2026-07-26-16:45:
Before the pre-merge review gates moved into `in-review`, a hung Code Review sat in `in-progress`
and the FN-7743 executor stall check caught it. After the move it maps to the `reviewer` stage,
which returned `progressing` unconditionally with no time-based check — so a gate that never posted
a verdict produced no stall signal at all, however long it hung.

These cases pin the replacement, and specifically pin the thing that makes it safe: the anchor is
the GATE's own `startedAt` lease, not `columnMovedAt`. Anchoring on the column would fire during a
legitimate human merge-wait, which is exactly the false positive that would make operators distrust
the signal — so "settled gates + old card = progressing" is asserted alongside the positive case.
*/
describe("PlannerOverseerMonitor.observeTask — review-gate stall detection (in-review gates)", () => {
  const THRESHOLD_MS = 2 * 60 * 60 * 1000;
  const NOW = Date.UTC(2026, 6, 26, 12, 0, 0);
  const isoMsAgo = (ms: number) => new Date(NOW - ms).toISOString();

  const gate = (overrides: Record<string, unknown>) => ({
    workflowStepId: "code-review",
    workflowStepName: "Code Review",
    phase: "pre-merge",
    ...overrides,
  });

  it("reports stuck when a pre-merge gate has been pending past the threshold", async () => {
    const monitor = new PlannerOverseerMonitor();
    const task = taskFixture({
      column: "in-review",
      columnMovedAt: isoMsAgo(THRESHOLD_MS + 60 * 60 * 1000),
      workflowStepResults: [gate({ status: "pending", startedAt: isoMsAgo(THRESHOLD_MS + 60 * 60 * 1000) })],
    } as never);

    const observation = await monitor.observeTask(task, "autonomous", { now: () => NOW, executorStuckAfterMs: THRESHOLD_MS });

    // A plain in-review card with no reviewState resolves to the `merger` stage,
    // not `reviewer` — which is exactly why the check lives on both in-review stages.
    expect(observation?.signal).toBe("stuck");
    expect(observation?.stage).toBe("merger");
    expect(observation?.reason).toMatch(/Review gate running for over \d+h/);
  });

  it("also reports stuck on the reviewer stage when reviewState is present", async () => {
    const monitor = new PlannerOverseerMonitor();
    const task = taskFixture({
      column: "in-review",
      reviewState: { items: [], summary: {} },
      workflowStepResults: [gate({ status: "pending", startedAt: isoMsAgo(THRESHOLD_MS + 60 * 60 * 1000) })],
    } as never);

    const observation = await monitor.observeTask(task, "autonomous", { now: () => NOW, executorStuckAfterMs: THRESHOLD_MS });

    expect(observation?.stage).toBe("reviewer");
    expect(observation?.signal).toBe("stuck");
    expect(observation?.reason).toMatch(/Review gate running for over \d+h/);
  });

  it("stays progressing while the gate is pending but still within the threshold", async () => {
    const monitor = new PlannerOverseerMonitor();
    const task = taskFixture({
      column: "in-review",
      workflowStepResults: [gate({ status: "pending", startedAt: isoMsAgo(60 * 1000) })],
    } as never);

    const observation = await monitor.observeTask(task, "autonomous", { now: () => NOW, executorStuckAfterMs: THRESHOLD_MS });

    expect(observation?.signal).toBe("progressing");
  });

  it("stays progressing for a long human merge-wait once the gates have settled", async () => {
    const monitor = new PlannerOverseerMonitor();
    const task = taskFixture({
      column: "in-review",
      // The card has sat in review for days, but no gate is running — a human owes a merge.
      columnMovedAt: isoMsAgo(72 * 60 * 60 * 1000),
      updatedAt: isoMsAgo(72 * 60 * 60 * 1000),
      workflowStepResults: [gate({ status: "passed", completedAt: isoMsAgo(71 * 60 * 60 * 1000) })],
    } as never);

    const observation = await monitor.observeTask(task, "autonomous", { now: () => NOW, executorStuckAfterMs: THRESHOLD_MS });

    expect(observation?.signal).toBe("progressing");
  });

  it("degrades to progressing when the pending gate has no usable startedAt", async () => {
    const monitor = new PlannerOverseerMonitor();
    const task = taskFixture({
      column: "in-review",
      workflowStepResults: [gate({ status: "pending", startedAt: "not-a-date" })],
    } as never);

    const observation = await monitor.observeTask(task, "autonomous", { now: () => NOW, executorStuckAfterMs: THRESHOLD_MS });

    expect(observation?.signal).toBe("progressing");
  });
});
