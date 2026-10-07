import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WEDGE_RENOTIFY_COOLDOWN_MS, type NotificationPayload, type Settings, type Task } from "@fusion/core";

const push = vi.hoisted(() => ({ impl: async (_payload: unknown): Promise<{ success: boolean; providerId: string }> => ({ success: true, providerId: "ntfy" }) }));

vi.mock("../ntfy-provider.js", () => ({
  NtfyNotificationProvider: class {
    getProviderId() { return "ntfy"; }
    isEventSupported() { return true; }
    async initialize() {}
    async shutdown() {}
    sendNotification(_event: string, payload: NotificationPayload) { return push.impl(payload); }
  },
}));

import { NotificationService } from "../notification-service.js";
import { describeTaskWedge } from "../task-wedge-notification.js";

/*
FNXC:TaskWedgeNotifications 2026-10-07-21:03:
A failed wedge delivery must never be durably recorded as delivered. The episode stays owed until a push provider or the mailbox confirms it; a failure re-arms a durable retry that reuses the same episode id (so the same mailbox idempotency key), and only an acknowledged delivery starts the cooldown.
Covers rejecting and hanging mailbox stores, failed and disabled push, late success, restart after claim, and both the immediate and deferred wedge paths.
*/

const LEASE_MS = 60_000;
const SETTLE_MS = 1_000;

type Wedge = NonNullable<Task["wedgeNotification"]>;

/** Store fake with the production claim/acknowledge/pending contract from TaskStore. */
function createWedgeStore(options: { pushEnabled: boolean }) {
  let wedge: Wedge | undefined;
  let liveTask: Task = {
    id: "FN-9700", title: "Wedged", description: "", column: "in-review", status: "failed",
    error: "merge verification failed: check:changeset-format", dependencies: [], steps: [], currentStep: 0, log: [],
    createdAt: "2026-10-07T12:00:00.000Z", updatedAt: "2026-10-07T12:00:00.000Z",
  } as Task;
  const withWedge = (): Task => ({ ...liveTask, wedgeNotification: wedge });
  const store = {
    getSettings: async () => ({ ntfyEnabled: options.pushEnabled, ntfyTopic: "topic" }) as Settings,
    getTask: async () => withWedge(),
    on: () => undefined,
    off: () => undefined,
    claimTaskWedgeNotificationEpisode: vi.fn(async (_taskId: string, reasonKey: string | null) => {
      const now = Date.now();
      if (reasonKey === null) {
        if (wedge?.status === "active") wedge = { ...wedge, status: "resolved" };
        return { claimed: false };
      }
      if (wedge?.status === "active" && wedge.reasonKey === reasonKey) {
        const last = Date.parse(wedge.deliveryAttemptAt ?? "");
        if (wedge.deliveryOwed !== true || (Number.isFinite(last) && now - last < LEASE_MS)) return { claimed: false };
        wedge = { ...wedge, deliveryAttemptAt: new Date(now).toISOString() };
        return { claimed: true, episodeId: wedge.episodeId };
      }
      const stamps = Object.fromEntries(Object.entries(wedge?.lastNotifiedAtByReason ?? {}).filter(([, at]) => now - Date.parse(at) < WEDGE_RENOTIFY_COOLDOWN_MS));
      const suppressed = reasonKey in stamps;
      const episodeId = `episode-${now}`;
      wedge = {
        reasonKey, episodeId, status: "active", transitionedAt: new Date(now).toISOString(),
        ...(suppressed ? {} : { deliveryOwed: true, deliveryAttemptAt: new Date(now).toISOString() }),
        ...(Object.keys(stamps).length > 0 ? { lastNotifiedAtByReason: stamps } : {}),
      };
      return suppressed ? { claimed: false } : { claimed: true, episodeId };
    }),
    acknowledgeTaskWedgeNotificationDelivery: vi.fn(async (_taskId: string, episodeId: string) => {
      if (!wedge || wedge.episodeId !== episodeId || wedge.deliveryOwed !== true) return false;
      const { deliveryOwed: _owed, deliveryAttemptAt: _attempt, ...rest } = wedge;
      wedge = { ...rest, lastNotifiedAtByReason: { ...(wedge.lastNotifiedAtByReason ?? {}), [wedge.reasonKey]: new Date().toISOString() } };
      return true;
    }),
    markTaskWedgeNotificationPending: vi.fn(async (_taskId: string, descriptor: { reasonKey: string; source: "auto" | "supplied"; reason: string; action: string }, opts?: { staleAfterMs?: number }) => {
      const now = new Date().toISOString();
      const pending = wedge?.pending;
      if (wedge?.status === "active" && wedge.reasonKey === descriptor.reasonKey && wedge.deliveryOwed !== true) return { since: pending?.since ?? now, armed: false, restamped: false };
      const stale = pending?.reasonKey === descriptor.reasonKey && typeof opts?.staleAfterMs === "number" && Date.now() - Date.parse(pending.since) > opts.staleAfterMs;
      if (pending?.reasonKey === descriptor.reasonKey && !stale) return { since: pending.since, armed: false, restamped: false };
      wedge = wedge
        ? { ...wedge, pending: { since: now, ...descriptor } }
        : { reasonKey: descriptor.reasonKey, episodeId: "", status: "resolved", transitionedAt: now, pending: { since: now, ...descriptor } };
      return { since: now, armed: true, restamped: pending != null };
    }),
    clearTaskWedgeNotificationPending: vi.fn(async () => {
      if (!wedge?.pending) return false;
      const { pending: _pending, ...rest } = wedge;
      wedge = rest;
      return true;
    }),
    markTerminalFailureAutoRecoveryEscalationDelivered: vi.fn(async () => "stamped" as const),
  };
  return { store, task: () => withWedge(), wedge: () => wedge, setTask: (next: Partial<Task>) => { liveTask = { ...liveTask, ...next }; } };
}

function createMailbox(mode: "ok" | "reject" | "hang") {
  const keys: string[] = [];
  let current = mode;
  const sendMessageOnce = vi.fn(async (_input: unknown, key: string) => {
    keys.push(key);
    if (current === "reject") throw new Error("mailbox unavailable");
    if (current === "hang") return new Promise<never>(() => undefined);
    return { message: {} as never, inserted: keys.filter((seen) => seen === key).length === 1 };
  });
  return { messageStore: { on: () => undefined, sendMessageOnce }, sendMessageOnce, keys, set: (next: "ok" | "reject" | "hang") => { current = next; } };
}

async function startService(store: ReturnType<typeof createWedgeStore>["store"], messageStore: ReturnType<typeof createMailbox>["messageStore"], settleMs: number) {
  const service = new NotificationService(store as never, { messageStore: messageStore as never, wedgeNotificationSettleMs: settleMs });
  await service.start();
  return service;
}

describe("wedge delivery acknowledgement", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T12:00:00.000Z"));
    push.impl = async () => ({ success: true, providerId: "ntfy" });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a deferred episode owed when every channel fails and retries it with the same mailbox key", async () => {
    const fixture = createWedgeStore({ pushEnabled: true });
    const mailbox = createMailbox("reject");
    push.impl = async () => ({ success: false, providerId: "ntfy" });
    const service = await startService(fixture.store, mailbox.messageStore, SETTLE_MS);
    const descriptor = describeTaskWedge(fixture.task())!;

    await service.notifyTaskWedge(fixture.task(), descriptor);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 1);
    expect(mailbox.sendMessageOnce).toHaveBeenCalledTimes(1);
    expect(fixture.store.acknowledgeTaskWedgeNotificationDelivery).not.toHaveBeenCalled();
    expect(fixture.wedge()).toMatchObject({ status: "active", deliveryOwed: true });
    expect(fixture.wedge()?.pending).toBeDefined();
    expect(fixture.wedge()?.lastNotifiedAtByReason).toBeUndefined();

    // Inside the lease the re-armed hold waits instead of being discarded; once it lapses the timer retries on its own.
    mailbox.set("ok");
    await vi.advanceTimersByTimeAsync(LEASE_MS / 2);
    expect(mailbox.keys).toHaveLength(1);
    expect(fixture.wedge()?.pending).toBeDefined();
    await vi.advanceTimersByTimeAsync(LEASE_MS / 2 + SETTLE_MS);
    expect(mailbox.keys).toHaveLength(2);
    expect(mailbox.keys[1]).toBe(mailbox.keys[0]);
    expect(fixture.store.acknowledgeTaskWedgeNotificationDelivery).toHaveBeenCalledTimes(1);
    expect(fixture.wedge()?.deliveryOwed).toBeUndefined();
    await service.stop();
  });

  it("treats a hanging mailbox and a hanging push provider as undelivered, bounded in time", async () => {
    const fixture = createWedgeStore({ pushEnabled: true });
    const mailbox = createMailbox("hang");
    push.impl = () => new Promise(() => undefined);
    const service = await startService(fixture.store, mailbox.messageStore, SETTLE_MS);

    await service.notifyTaskWedge(fixture.task(), describeTaskWedge(fixture.task())!);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mailbox.sendMessageOnce).toHaveBeenCalledTimes(1);
    expect(fixture.store.acknowledgeTaskWedgeNotificationDelivery).not.toHaveBeenCalled();
    expect(fixture.wedge()).toMatchObject({ deliveryOwed: true });
    await service.stop();
  });

  it("acknowledges a mailbox delivery when push is disabled, and a push delivery when the mailbox fails", async () => {
    const mailboxOnly = createWedgeStore({ pushEnabled: false });
    const okMailbox = createMailbox("ok");
    const first = await startService(mailboxOnly.store, okMailbox.messageStore, SETTLE_MS);
    await first.notifyTaskWedge(mailboxOnly.task(), describeTaskWedge(mailboxOnly.task())!);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 1);
    expect(mailboxOnly.store.acknowledgeTaskWedgeNotificationDelivery).toHaveBeenCalledTimes(1);
    await first.stop();

    const pushOnly = createWedgeStore({ pushEnabled: true });
    const failingMailbox = createMailbox("reject");
    const second = await startService(pushOnly.store, failingMailbox.messageStore, SETTLE_MS);
    await second.notifyTaskWedge(pushOnly.task(), describeTaskWedge(pushOnly.task())!);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 1);
    expect(pushOnly.store.acknowledgeTaskWedgeNotificationDelivery).toHaveBeenCalledTimes(1);
    await second.stop();
  });

  it("counts a late mailbox success through the same idempotency key on retry", async () => {
    const fixture = createWedgeStore({ pushEnabled: false });
    const mailbox = createMailbox("hang");
    const service = await startService(fixture.store, mailbox.messageStore, SETTLE_MS);

    await service.notifyTaskWedge(fixture.task(), describeTaskWedge(fixture.task())!);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fixture.store.acknowledgeTaskWedgeNotificationDelivery).not.toHaveBeenCalled();

    // The original insert landed late; the retry with the same key is deduped by the store yet still confirms delivery.
    mailbox.set("ok");
    await vi.advanceTimersByTimeAsync(LEASE_MS + SETTLE_MS);
    expect(mailbox.keys.length).toBeGreaterThan(1);
    expect(new Set(mailbox.keys).size).toBe(1);
    expect(fixture.store.acknowledgeTaskWedgeNotificationDelivery).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  it("retries an owed episode through a fresh service after a restart", async () => {
    const fixture = createWedgeStore({ pushEnabled: false });
    const mailbox = createMailbox("reject");
    const before = await startService(fixture.store, mailbox.messageStore, SETTLE_MS);
    await before.notifyTaskWedge(fixture.task(), describeTaskWedge(fixture.task())!);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 1);
    await before.stop();
    const owedEpisode = fixture.wedge()?.episodeId;
    expect(fixture.wedge()).toMatchObject({ deliveryOwed: true });

    mailbox.set("ok");
    await vi.advanceTimersByTimeAsync(LEASE_MS);
    const after = await startService(fixture.store, mailbox.messageStore, SETTLE_MS);
    expect((await after.completePendingWedgeNotification(fixture.task().id)).outcome).toBe("delivered");
    expect(mailbox.keys.at(-1)).toBe(`task-wedge:${owedEpisode}`);
    expect(fixture.store.acknowledgeTaskWedgeNotificationDelivery).toHaveBeenCalledWith(fixture.task().id, owedEpisode);
    await after.stop();
  });

  it("reports an immediate-path failure as undelivered, never stamps it delivered, and retries once the lease lapses", async () => {
    const fixture = createWedgeStore({ pushEnabled: false });
    const mailbox = createMailbox("reject");
    const service = await startService(fixture.store, mailbox.messageStore, 0);
    const descriptor = describeTaskWedge(fixture.task())!;

    expect(await service.notifyTaskWedge(fixture.task(), descriptor)).toBe("unavailable");
    expect(fixture.store.markTerminalFailureAutoRecoveryEscalationDelivered).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ dispatchOutcome: "delivered" }));
    expect(fixture.wedge()).toMatchObject({ deliveryOwed: true });
    expect(await service.notifyTaskWedge(fixture.task(), descriptor)).toBe("suppressed");

    mailbox.set("ok");
    await vi.advanceTimersByTimeAsync(LEASE_MS);
    expect(await service.notifyTaskWedge(fixture.task(), descriptor)).toBe("delivered");
    expect(new Set(mailbox.keys).size).toBe(1);
    expect(fixture.store.acknowledgeTaskWedgeNotificationDelivery).toHaveBeenCalledTimes(1);
    await service.stop();
  });
});
