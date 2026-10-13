import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WEDGE_RENOTIFY_COOLDOWN_MS, type Settings, type Task, type TaskExternalBlock, type TaskExternalBlockOrigin } from "@fusion/core";
import { NotificationService } from "../notification-service.js";
import { classifyExternalBlockFreeze, describeTaskWedge, hasWedgeSubjectMovedOn } from "../task-wedge-notification.js";

/*
FNXC:TaskWedgeNotifications 2026-10-13-10:32:
A card frozen as external-block keeps its column, so a WIP or review lane is no evidence that it moved on.
Wedge handling for a frozen card must reach a fixed point: a pass that changes nothing writes nothing, a freeze waiting for an operator is announced once after the settle window, and a freeze whose next step Fusion owns (scheduled automatic resume or published resume request) never opens an episode.
The store fake mirrors the production TaskStore contract: every state-changing wedge write re-emits task:updated with the new row, and a no-op writes and emits nothing.
*/

const SETTLE_MS = 1_000;
const LEASE_MS = 60_000;
/** A regression loops forever; stop emitting here so it fails an assertion instead of hanging. */
const WRITE_CAP = 200;
const NOW = "2026-10-13T10:30:00.000Z";
const TASK_ID = "FN-9175";

type Wedge = NonNullable<Task["wedgeNotification"]>;
type Moved = { task: Task; from: string; to: string };
type PendingDescriptor = { reasonKey: string; source: "auto" | "supplied"; reason: string; action: string; gate?: string };

/* A board whose lanes carry no legacy id: hold `drafting`, wip `building`, review `checking`, complete `shipped`. */
const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "drafting", name: "Drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "checking", name: "Checking", traits: [{ trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
};

function frozenTask(
  origin: TaskExternalBlockOrigin,
  code: string,
  column: string,
  block: Partial<TaskExternalBlock> = {},
  overrides: Partial<Task> = {},
): Task {
  return {
    id: TASK_ID, title: "Frozen card", description: "", column, status: "blocked",
    paused: true, pausedReason: "external-block", error: `BLOCKED: ${origin}/${code}: raw obstacle`,
    externalBlock: {
      origin, code, message: "raw obstacle", source: "agent-declaration", blockedAt: "2026-10-13T09:00:00.000Z",
      resume: { column, currentStep: 1 },
      report: {
        verifiedCondition: "The obstacle was verified outside the worktree.",
        stopReason: "Work stopped to preserve the task state.",
        unimplementedWork: "Steps 2-4 were not performed.",
        unblockCondition: "Repair the obstacle, then retry.",
        ...(origin === "human-decision" ? { question: "Which option should this task implement?" } : {}),
      },
      ...block,
    },
    dependencies: [], steps: [], currentStep: 1, log: [],
    createdAt: "2026-10-13T08:00:00.000Z", updatedAt: "2026-10-13T09:00:00.000Z",
    ...overrides,
  } as Task;
}

/** Store fake holding one live row, with the production wedge-state contract from TaskStore. */
function createFrozenStore(initial: Task, options: { workflowIr?: unknown; pendingApi?: boolean } = {}) {
  let row = initial;
  let writes = 0;
  const updated = new Set<(task: Task) => void>();
  const moved = new Set<(data: Moved) => void>();
  const commit = (wedge: Wedge | undefined): void => {
    writes += 1;
    row = { ...row, wedgeNotification: wedge, updatedAt: new Date().toISOString() };
    if (writes > WRITE_CAP) return;
    const snapshot = row;
    queueMicrotask(() => updated.forEach((listener) => listener(snapshot)));
  };
  const pendingApi = options.pendingApi === false ? {} : {
    markTaskWedgeNotificationPending: vi.fn(async (_taskId: string, descriptor: PendingDescriptor, opts?: { staleAfterMs?: number }) => {
      const now = new Date().toISOString();
      const prior = row.wedgeNotification;
      const pending = prior?.pending;
      if (prior?.status === "active" && prior.reasonKey === descriptor.reasonKey && prior.deliveryOwed !== true) {
        return { since: now, armed: false, restamped: false };
      }
      const pendingSince = pending ? Date.parse(pending.since) : Number.NaN;
      const stale = pending?.reasonKey === descriptor.reasonKey
        && typeof opts?.staleAfterMs === "number"
        && Number.isFinite(pendingSince)
        && Date.now() - pendingSince > opts.staleAfterMs;
      if (pending?.reasonKey === descriptor.reasonKey && !stale) return { since: pending.since, armed: false, restamped: false };
      const nextPending = { since: now, ...descriptor };
      commit(prior
        ? { ...prior, pending: nextPending }
        : { reasonKey: descriptor.reasonKey, episodeId: "", status: "resolved", transitionedAt: now, pending: nextPending });
      return { since: now, armed: true, restamped: pending != null };
    }),
    clearTaskWedgeNotificationPending: vi.fn(async () => {
      const prior = row.wedgeNotification;
      if (!prior?.pending) return false;
      const { pending: _pending, ...rest } = prior;
      commit(rest);
      return true;
    }),
  };
  const store = {
    getSettings: async () => ({ ntfyEnabled: true, ntfyTopic: "test" }) as Settings,
    getTask: async () => row,
    on: (event: string, listener: unknown) => {
      if (event === "task:updated") updated.add(listener as (task: Task) => void);
      if (event === "task:moved") moved.add(listener as (data: Moved) => void);
    },
    off: (event: string, listener: unknown) => {
      if (event === "task:updated") updated.delete(listener as (task: Task) => void);
      if (event === "task:moved") moved.delete(listener as (data: Moved) => void);
    },
    claimTaskWedgeNotificationEpisode: vi.fn(async (_taskId: string, reasonKey: string | null) => {
      const prior = row.wedgeNotification;
      if (reasonKey === null) {
        if (!prior || prior.status === "resolved") return { claimed: false };
        commit({ ...prior, status: "resolved", transitionedAt: new Date().toISOString() });
        return { claimed: false };
      }
      const now = Date.now();
      if (prior?.status === "active" && prior.reasonKey === reasonKey) {
        const lastAttempt = Date.parse(prior.deliveryAttemptAt ?? "");
        const leaseLapsed = !Number.isFinite(lastAttempt) || lastAttempt > now || now - lastAttempt >= LEASE_MS;
        if (prior.deliveryOwed !== true || !prior.episodeId || !leaseLapsed) return { claimed: false };
        commit({ ...prior, deliveryAttemptAt: new Date(now).toISOString() });
        return { claimed: true, episodeId: prior.episodeId };
      }
      const lastNotifiedAtByReason = Object.fromEntries(Object.entries(prior?.lastNotifiedAtByReason ?? {}).filter(([, at]) => {
        const notifiedAt = Date.parse(at);
        return Number.isFinite(notifiedAt) && notifiedAt <= now && now - notifiedAt < WEDGE_RENOTIFY_COOLDOWN_MS;
      }));
      const episodeId = `episode-${now}`;
      const suppressed = reasonKey in lastNotifiedAtByReason;
      commit({
        reasonKey, episodeId, status: "active", transitionedAt: new Date(now).toISOString(),
        ...(suppressed ? {} : { deliveryOwed: true, deliveryAttemptAt: new Date(now).toISOString() }),
        ...(Object.keys(lastNotifiedAtByReason).length > 0 ? { lastNotifiedAtByReason } : {}),
      });
      return suppressed ? { claimed: false } : { claimed: true, episodeId };
    }),
    acknowledgeTaskWedgeNotificationDelivery: vi.fn(async (_taskId: string, episodeId: string) => {
      const prior = row.wedgeNotification;
      if (!prior || prior.episodeId !== episodeId || prior.deliveryOwed !== true) return false;
      const { deliveryOwed: _owed, deliveryAttemptAt: _attempt, ...rest } = prior;
      commit({ ...rest, lastNotifiedAtByReason: { ...(prior.lastNotifiedAtByReason ?? {}), [prior.reasonKey]: new Date().toISOString() } });
      return true;
    }),
    ...pendingApi,
    ...(options.workflowIr ? { listWorkflowDefinitions: async () => [{ ir: options.workflowIr }] } : {}),
  };
  return {
    store,
    row: () => row,
    writes: () => writes,
    emitUpdated: () => updated.forEach((listener) => listener(row)),
    emitMoved: (from: string, to: string) => moved.forEach((listener) => listener({ task: row, from, to })),
  };
}

async function startFixture(initial: Task, options: { workflowIr?: unknown; pendingApi?: boolean; settleMs?: number } = {}) {
  const fixture = createFrozenStore(initial, options);
  const sendMessageOnce = vi.fn(async (_input: unknown, _key: string) => ({ message: {} as never, inserted: true }));
  const service = new NotificationService(fixture.store as never, {
    messageStore: { on: () => undefined, sendMessageOnce } as never,
    wedgeNotificationSettleMs: options.settleMs ?? SETTLE_MS,
  });
  service.registerProvider({ getProviderId: () => "test", isEventSupported: () => true, sendNotification: vi.fn(async () => ({ success: true, providerId: "test" })) });
  await service.start();
  return { ...fixture, service, sendMessageOnce };
}

type Fixture = Awaited<ReturnType<typeof startFixture>>;

/** Drains wedge handling without real time: stops when a pass produces no write, or at the safety cap. */
async function drain(fixture: Fixture): Promise<void> {
  let quiet = 0;
  for (let index = 0; index < 2_000 && quiet < 3 && fixture.writes() < WRITE_CAP; index += 1) {
    const before = fixture.writes();
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    quiet = fixture.writes() === before ? quiet + 1 : 0;
  }
}

async function repeatUpdates(fixture: Fixture, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    fixture.emitUpdated();
    await drain(fixture);
  }
}

/**
 * The fixed-point contract for a freeze waiting for an operator: one pending write before the settle
 * window ends, an unchanged hold across repeats, one message after the window, then nothing more.
 */
async function expectAnnouncedOnce(fixture: Fixture, reasonKey: string): Promise<void> {
  fixture.emitUpdated();
  await drain(fixture);
  expect(fixture.writes()).toBe(1);
  const since = fixture.row().wedgeNotification?.pending?.since;
  expect(fixture.row().wedgeNotification?.pending?.reasonKey).toBe(reasonKey);

  await repeatUpdates(fixture, 5);
  expect(fixture.writes()).toBe(1);
  expect(fixture.row().wedgeNotification?.pending?.since).toBe(since);
  expect(fixture.sendMessageOnce).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(SETTLE_MS + 1);
  await drain(fixture);
  expect(fixture.sendMessageOnce).toHaveBeenCalledTimes(1);
  expect((fixture.sendMessageOnce.mock.calls[0]?.[0] as { metadata: Record<string, unknown> }).metadata.wedgeReason).toBe(reasonKey);
  const settled = fixture.row().wedgeNotification;
  expect(settled).toMatchObject({ status: "active", reasonKey });
  expect(settled?.pending).toBeUndefined();
  expect(settled?.deliveryOwed).toBeUndefined();

  const settledWrites = fixture.writes();
  const settledWedge = structuredClone(settled);
  await repeatUpdates(fixture, 5);
  await vi.advanceTimersByTimeAsync(2 * SETTLE_MS + 1);
  await drain(fixture);
  expect(fixture.writes()).toBe(settledWrites);
  expect(fixture.sendMessageOnce).toHaveBeenCalledTimes(1);
  expect(fixture.row().wedgeNotification).toEqual(settledWedge);
  expect(fixture.writes()).toBeLessThan(WRITE_CAP);
}

/** Asserts that wedge handling settles within `maxWrites` and then stays quiet without sending anything. */
async function expectQuiet(fixture: Fixture, maxWrites: number): Promise<void> {
  fixture.emitUpdated();
  await drain(fixture);
  const settledWrites = fixture.writes();
  expect(settledWrites).toBeLessThanOrEqual(maxWrites);
  const settledWedge = structuredClone(fixture.row().wedgeNotification);
  await repeatUpdates(fixture, 5);
  await vi.advanceTimersByTimeAsync(2 * SETTLE_MS + 1);
  await drain(fixture);
  expect(fixture.writes()).toBe(settledWrites);
  expect(fixture.row().wedgeNotification).toEqual(settledWedge);
  expect(fixture.sendMessageOnce).not.toHaveBeenCalled();
}

function pendingWedge(reasonKey: string, sinceMsAgo: number): Wedge {
  const at = new Date(Date.now() - sinceMsAgo).toISOString();
  return {
    reasonKey, episodeId: "", status: "resolved", transitionedAt: at,
    pending: { since: at, reasonKey, source: "auto", reason: "Work stopped to preserve the task state.", action: "Repair the obstacle, then retry." },
  };
}

function activeWedge(reasonKey: string): Wedge {
  return { reasonKey, episodeId: "episode-prior", status: "active", transitionedAt: new Date(Date.now() - 60_000).toISOString() };
}

const AWAITING_OPERATOR: Array<[TaskExternalBlockOrigin, string]> = [
  ["human-decision", "DECISION_REQUIRED"],
  ["credentials", "CREDENTIALS"],
  ["model-provider", "RATE_LIMIT"],
  ["host-environment", "ENOSPC"],
  ["network", "ECONNREFUSED"],
  ["model-provider", "USAGE_LIMIT"],
];

const LANES: Array<[string, string, unknown]> = [
  ["legacy WIP", "in-progress", undefined],
  ["legacy review", "in-review", undefined],
  ["legacy hold", "todo", undefined],
  ["renamed WIP", "building", RENAMED_IR],
  ["renamed review", "checking", RENAMED_IR],
  ["renamed hold", "drafting", RENAMED_IR],
];

const RECOVERY_OWNED: Array<[string, TaskExternalBlockOrigin, string, Partial<TaskExternalBlock>]> = [
  ["a rate limit with a scheduled automatic resume", "model-provider", "RATE_LIMIT", { autoResume: { attempt: 2, budget: 6, resumeAt: "2026-10-13T10:45:00.000Z" } }],
  ["an operator resume request", "credentials", "CREDENTIALS", { resumeRequest: { requestedAt: "2026-10-13T10:29:00.000Z", trigger: "operator" } }],
  ["an automatic resume request", "model-provider", "RATE_LIMIT", { resumeRequest: { requestedAt: "2026-10-13T10:29:00.000Z", trigger: "automatic" } }],
];

describe("the shared external-block freeze rule", () => {
  const LEGACY_LANES = { progressed: new Set(["todo", "in-progress", "done", "archived"]), terminal: new Set(["done", "archived"]) };
  const RENAMED_LANES = { progressed: new Set(["drafting", "building", "shipped"]), terminal: new Set(["shipped"]) };
  const lanesFor = (workflowIr: unknown) => (workflowIr ? RENAMED_LANES : LEGACY_LANES);

  it.each(LANES)("the classifier and the moved-on check agree for every freeze in the %s lane (%s)", (_label, column, workflowIr) => {
    const lanes = lanesFor(workflowIr);
    for (const [origin, code] of AWAITING_OPERATOR) {
      const task = frozenTask(origin, code, column);
      expect(classifyExternalBlockFreeze(task)).toBe("awaiting-operator");
      expect(describeTaskWedge(task)?.reasonKey).toBe(`external-block:${origin}:${code}`);
      expect(hasWedgeSubjectMovedOn(task, lanes)).toBe(false);
    }
    for (const [, origin, code, block] of RECOVERY_OWNED) {
      const task = frozenTask(origin, code, column, block);
      expect(classifyExternalBlockFreeze(task)).toBe("recovery-owned");
      expect(describeTaskWedge(task)).toBeNull();
      expect(hasWedgeSubjectMovedOn(task, lanes)).toBe(true);
    }
  });

  it("treats a rate-limit freeze whose automatic-resume budget is spent as waiting for an operator", () => {
    expect(describeTaskWedge(frozenTask("model-provider", "RATE_LIMIT", "in-progress"))?.reasonKey).toBe("external-block:model-provider:RATE_LIMIT");
  });

  it.each([
    ["user-paused", { userPaused: true }],
    ["auto-merge off", { autoMerge: false }],
  ] as Array<[string, Partial<Task>]>)("does not classify a %s freeze as notifiable", (_label, hold) => {
    const task = frozenTask("credentials", "CREDENTIALS", "in-progress", {}, hold);
    expect(classifyExternalBlockFreeze(task)).toBeNull();
    expect(describeTaskWedge(task)).toBeNull();
    expect(hasWedgeSubjectMovedOn(task, LEGACY_LANES)).toBe(true);
  });

  it("counts a freeze waiting for an operator as moved on only once it is deleted or in a terminal lane", () => {
    expect(hasWedgeSubjectMovedOn(frozenTask("credentials", "CREDENTIALS", "archived"), LEGACY_LANES)).toBe(true);
    expect(hasWedgeSubjectMovedOn(frozenTask("credentials", "CREDENTIALS", "shipped"), RENAMED_LANES)).toBe(true);
    expect(hasWedgeSubjectMovedOn(frozenTask("credentials", "CREDENTIALS", "in-progress", {}, { deletedAt: NOW }), LEGACY_LANES)).toBe(true);
  });
});

describe("external-block wedge handling reaches a fixed point", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles a credentials freeze in the WIP lane that carries a stale pending hold (the observed row)", async () => {
    const reasonKey = "external-block:credentials:CREDENTIALS";
    const fixture = await startFixture(frozenTask("credentials", "CREDENTIALS", "in-progress", {}, { wedgeNotification: pendingWedge(reasonKey, 60 * 60_000) }));
    await expectAnnouncedOnce(fixture, reasonKey);
    await fixture.service.stop();
  });

  describe.each(LANES)("in the %s lane (%s)", (_label, column, workflowIr) => {
    it.each(AWAITING_OPERATOR)("announces a %s/%s freeze once and then writes nothing", async (origin, code) => {
      const fixture = await startFixture(frozenTask(origin, code, column), { workflowIr });
      await expectAnnouncedOnce(fixture, `external-block:${origin}:${code}`);
      await fixture.service.stop();
    });
  });

  describe.each([["in-progress"], ["in-review"]])("recovery-owned freezes in %s", (column) => {
    it.each(RECOVERY_OWNED)("never announces %s", async (_label, origin, code, block) => {
      const reasonKey = `external-block:${origin}:${code}`;
      const clean = await startFixture(frozenTask(origin, code, column, block));
      await expectQuiet(clean, 0);
      await clean.service.stop();

      const stalePending = await startFixture(frozenTask(origin, code, column, block, { wedgeNotification: pendingWedge(reasonKey, 60 * 60_000) }));
      await expectQuiet(stalePending, 1);
      expect(stalePending.row().wedgeNotification?.pending).toBeUndefined();
      await stalePending.service.stop();

      const openEpisode = await startFixture(frozenTask(origin, code, column, block, { wedgeNotification: activeWedge(reasonKey) }));
      await expectQuiet(openEpisode, 1);
      expect(openEpisode.row().wedgeNotification?.status).toBe("resolved");
      await openEpisode.service.stop();
    });
  });

  it.each([
    ["user-paused", { userPaused: true }],
    ["auto-merge off", { autoMerge: false }],
  ] as Array<[string, Partial<Task>]>)("settles a held %s freeze with at most one write from any starting state", async (_label, hold) => {
    const reasonKey = "external-block:credentials:CREDENTIALS";
    for (const wedgeNotification of [undefined, pendingWedge(reasonKey, 60 * 60_000), activeWedge(reasonKey)]) {
      const fixture = await startFixture(frozenTask("credentials", "CREDENTIALS", "in-progress", {}, { ...hold, wedgeNotification }));
      await expectQuiet(fixture, 1);
      await fixture.service.stop();
    }
  });

  it("delivers an aged hold through the restart-sweep entry for a freeze waiting for an operator", async () => {
    const reasonKey = "external-block:credentials:CREDENTIALS";
    const fixture = await startFixture(frozenTask("credentials", "CREDENTIALS", "in-progress", {}, { wedgeNotification: pendingWedge(reasonKey, 2 * SETTLE_MS) }));
    await expect(fixture.service.completePendingWedgeNotification(TASK_ID)).resolves.toMatchObject({ outcome: "delivered" });
    await drain(fixture);
    expect(fixture.sendMessageOnce).toHaveBeenCalledTimes(1);
    await fixture.service.stop();
  });

  it("clears an aged hold through the restart-sweep entry for a recovery-owned freeze", async () => {
    const reasonKey = "external-block:model-provider:RATE_LIMIT";
    const [, origin, code, block] = RECOVERY_OWNED[0]!;
    const fixture = await startFixture(frozenTask(origin, code, "in-progress", block, { wedgeNotification: pendingWedge(reasonKey, 2 * SETTLE_MS) }));
    await expect(fixture.service.completePendingWedgeNotification(TASK_ID)).resolves.toEqual({ outcome: "cleared" });
    await drain(fixture);
    expect(fixture.sendMessageOnce).not.toHaveBeenCalled();
    await fixture.service.stop();
  });

  it.each([["in-progress"], ["in-review"]])("keeps the pending hold when a freeze waiting for an operator is moved into %s", async (to) => {
    const reasonKey = "external-block:credentials:CREDENTIALS";
    const fixture = await startFixture(frozenTask("credentials", "CREDENTIALS", to, {}, { wedgeNotification: pendingWedge(reasonKey, 100) }));
    fixture.emitMoved("todo", to);
    await drain(fixture);
    expect(fixture.writes()).toBe(0);
    expect(fixture.row().wedgeNotification?.pending?.reasonKey).toBe(reasonKey);
    await fixture.service.stop();
  });

  it("announces once through the in-memory hold when the store has no pending API", async () => {
    const fixture = await startFixture(frozenTask("credentials", "CREDENTIALS", "in-progress"), { pendingApi: false });
    fixture.emitUpdated();
    await drain(fixture);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 1);
    await drain(fixture);
    expect(fixture.sendMessageOnce).toHaveBeenCalledTimes(1);
    const settledWrites = fixture.writes();
    await repeatUpdates(fixture, 5);
    await vi.advanceTimersByTimeAsync(2 * SETTLE_MS + 1);
    await drain(fixture);
    expect(fixture.sendMessageOnce).toHaveBeenCalledTimes(1);
    expect(fixture.writes()).toBe(settledWrites);
    await fixture.service.stop();
  });

  it("announces once on the immediate path when the settle window is zero", async () => {
    const fixture = await startFixture(frozenTask("credentials", "CREDENTIALS", "in-review"), { settleMs: 0 });
    fixture.emitUpdated();
    await drain(fixture);
    expect(fixture.sendMessageOnce).toHaveBeenCalledTimes(1);
    const settledWrites = fixture.writes();
    await repeatUpdates(fixture, 5);
    expect(fixture.writes()).toBe(settledWrites);
    expect(fixture.sendMessageOnce).toHaveBeenCalledTimes(1);
    await fixture.service.stop();
  });
});
