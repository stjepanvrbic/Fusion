/*
FNXC:ConfigVersioning 2026-10-07-21:40:
A project-settings rollback reads the current settings for its revision's `before` snapshot and then replaces them in the
same transaction. That read took no row lock, so a concurrent settings write could commit in between and the rollback
recorded, and merged against, a snapshot that was already stale. The read now holds the config row lock, so a concurrent
writer waits for the rollback to commit.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { createProjectSettingsRollbackSnapshotOps } from "../../task-store/task-mutation-ops.js";

pgDescribe("project-settings rollback holds the config row lock (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_config_rollback_lock" });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);

  async function lockWaiters(): Promise<number> {
    const rows = await h.adminSql()`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`;
    return Number(rows[0]?.waiting ?? 0);
  }

  it("a concurrent settings write waits until the rollback's read-replace transaction commits", async () => {
    const store = h.store();
    await store.updateSettings({ autoMerge: true });
    const layer = h.layer();
    let signalRead!: () => void;
    const readDone = new Promise<void>((resolve) => { signalRead = resolve; });
    let releaseRollback!: () => void;
    const released = new Promise<void>((resolve) => { releaseRollback = resolve; });

    const rollback = layer.transactionImmediate(async (tx) => {
      const ops = createProjectSettingsRollbackSnapshotOps(layer, tx);
      await ops.readCurrent();
      signalRead();
      await released;
    });
    await readDone;

    let settled = false;
    const write = store.updateSettings({ autoMerge: false }).then(() => { settled = true; });
    let waiting = 0;
    try {
      for (let attempt = 0; attempt < 5_000 && !settled && waiting === 0; attempt++) waiting = await lockWaiters();
      expect(settled).toBe(false);
      expect(waiting).toBeGreaterThan(0);
    } finally {
      releaseRollback();
      await rollback;
      await write;
    }
    expect((await store.getSettings()).autoMerge).toBe(false);
  });
});
