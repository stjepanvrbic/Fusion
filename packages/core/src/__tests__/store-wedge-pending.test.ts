import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../__test-utils__/pg-test-harness.js";

/*
FNXC:TaskWedgeNotifications 2026-08-11-18:57:
The durable marker is deliberately separate from episode state and cooldown history. These store
assertions pin the CAS boundary so engine timers can defer an alert without a restart dropping it
or a claim/resolve accidentally being treated as a pending-marker clear.
*/
pgDescribe("TaskStore deferred wedge marker", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_wedge_pending" });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function seed(id: string) {
    const store = h.store();
    await store.createTaskWithReservedId({ description: "deferred wedge", column: "in-review" }, { taskId: id, applyDefaultWorkflowSteps: false });
    return store;
  }

  const descriptor = { reasonKey: "terminal-failed", source: "auto" as const, reason: "terminal", action: "repair" };

  it("arms once, restamps stale evidence, and clears without changing episode state", async () => {
    const store = await seed("FN-WEDGE-001");
    const first = await store.markTaskWedgeNotificationPending("FN-WEDGE-001", descriptor);
    const second = await store.markTaskWedgeNotificationPending("FN-WEDGE-001", descriptor);
    expect(second).toMatchObject({ since: first.since, armed: false, restamped: false });

    const stale = await store.markTaskWedgeNotificationPending("FN-WEDGE-001", descriptor, { staleAfterMs: -1 });
    expect(stale).toMatchObject({ armed: true, restamped: true });
    expect(await store.clearTaskWedgeNotificationPending("FN-WEDGE-001", "other")).toBe(false);
    expect(await store.clearTaskWedgeNotificationPending("FN-WEDGE-001")).toBe(true);
    const task = await store.getTask("FN-WEDGE-001");
    expect(task.wedgeNotification).toMatchObject({ reasonKey: "terminal-failed", status: "resolved", episodeId: "" });
    expect(task.wedgeNotification?.pending).toBeUndefined();
  });

  it("drops pending evidence on delivered and cooldown-suppressed claims but not resolve", async () => {
    const store = await seed("FN-WEDGE-002");
    await store.markTaskWedgeNotificationPending("FN-WEDGE-002", descriptor);
    const delivered = await store.claimTaskWedgeNotificationEpisode("FN-WEDGE-002", "terminal-failed");
    expect(delivered).toMatchObject({ claimed: true });
    expect((await store.getTask("FN-WEDGE-002")).wedgeNotification?.pending).toBeUndefined();
    // Only an acknowledged delivery starts the cooldown that suppresses the re-wedge below.
    expect(await store.acknowledgeTaskWedgeNotificationDelivery("FN-WEDGE-002", delivered.episodeId!)).toBe(true);

    await store.claimTaskWedgeNotificationEpisode("FN-WEDGE-002", null);
    await store.markTaskWedgeNotificationPending("FN-WEDGE-002", descriptor);
    expect(await store.claimTaskWedgeNotificationEpisode("FN-WEDGE-002", "terminal-failed")).toMatchObject({ claimed: false });
    expect((await store.getTask("FN-WEDGE-002")).wedgeNotification?.pending).toBeUndefined();

    await store.markTaskWedgeNotificationPending("FN-WEDGE-002", { ...descriptor, reasonKey: "tool-failure" });
    await store.claimTaskWedgeNotificationEpisode("FN-WEDGE-002", null);
    expect((await store.getTask("FN-WEDGE-002")).wedgeNotification?.pending).toBeDefined();
  });

  /*
  FNXC:TaskWedgeNotifications 2026-10-07-21:02:
  Allocating an episode is not delivering it. A claimed episode stays owed until acknowledged; while owed it is re-claimable with the same id once the retry lease lapses, and an unacknowledged episode never starts the cooldown.
  */
  it("keeps a claimed episode owed and re-claimable with its own id until a delivery is acknowledged", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-07T12:00:00.000Z"));
      const store = await seed("FN-WEDGE-003");
      const first = await store.claimTaskWedgeNotificationEpisode("FN-WEDGE-003", "terminal-failed");
      expect(first).toMatchObject({ claimed: true });
      expect((await store.getTask("FN-WEDGE-003")).wedgeNotification).toMatchObject({ deliveryOwed: true, status: "active" });
      expect((await store.getTask("FN-WEDGE-003")).wedgeNotification?.lastNotifiedAtByReason?.["terminal-failed"]).toBeUndefined();

      expect(await store.claimTaskWedgeNotificationEpisode("FN-WEDGE-003", "terminal-failed")).toEqual({ claimed: false });
      const retryHold = await store.markTaskWedgeNotificationPending("FN-WEDGE-003", descriptor);
      expect(retryHold.armed).toBe(true);

      vi.setSystemTime(new Date("2026-10-07T12:01:01.000Z"));
      const retry = await store.claimTaskWedgeNotificationEpisode("FN-WEDGE-003", "terminal-failed");
      expect(retry).toEqual({ claimed: true, episodeId: first.episodeId });

      expect(await store.acknowledgeTaskWedgeNotificationDelivery("FN-WEDGE-003", "some-other-episode")).toBe(false);
      expect(await store.acknowledgeTaskWedgeNotificationDelivery("FN-WEDGE-003", first.episodeId!)).toBe(true);
      expect(await store.acknowledgeTaskWedgeNotificationDelivery("FN-WEDGE-003", first.episodeId!)).toBe(false);
      const acknowledged = (await store.getTask("FN-WEDGE-003")).wedgeNotification;
      expect(acknowledged?.deliveryOwed).toBeUndefined();
      expect(acknowledged?.lastNotifiedAtByReason?.["terminal-failed"]).toBe("2026-10-07T12:01:01.000Z");

      vi.setSystemTime(new Date("2026-10-07T12:05:00.000Z"));
      expect(await store.claimTaskWedgeNotificationEpisode("FN-WEDGE-003", "terminal-failed")).toEqual({ claimed: false });
      await store.claimTaskWedgeNotificationEpisode("FN-WEDGE-003", null);
      expect(await store.claimTaskWedgeNotificationEpisode("FN-WEDGE-003", "terminal-failed")).toEqual({ claimed: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let an unacknowledged episode suppress a later re-wedge", async () => {
    const store = await seed("FN-WEDGE-004");
    const undelivered = await store.claimTaskWedgeNotificationEpisode("FN-WEDGE-004", "terminal-failed");
    expect(undelivered.claimed).toBe(true);
    await store.claimTaskWedgeNotificationEpisode("FN-WEDGE-004", null);
    const rewedge = await store.claimTaskWedgeNotificationEpisode("FN-WEDGE-004", "terminal-failed");
    expect(rewedge.claimed).toBe(true);
    expect(rewedge.episodeId).not.toBe(undelivered.episodeId);
  });
});
