/**
 * FNXC:CheckoutLease 2026-10-07-21:40:
 * The PostgreSQL renewal ran an UPDATE without RETURNING and read the empty result as "no row matched", so every successful
 * renewal threw "Task not found" after its timestamp had committed and skipped the task.json, cache and event updates.
 * Renewal must report success, must reject missing and deleted tasks, and must touch only its own project's row.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import * as schema from "../../postgres/schema/index.js";
import { TaskStore } from "../../store.js";

pgDescribe("TaskStore.renewCheckoutLease (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_lease_renewal" });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);

  it("returns the renewed task and emits task:updated", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "renewal target" });
    const events: string[] = [];
    store.on("task:updated", (updated) => events.push(updated.id));

    const renewed = await store.renewCheckoutLease(task.id, { checkoutRunId: "run-1", checkoutLeaseRenewedAt: "2026-10-07T21:40:00.000Z" });

    expect(renewed.checkoutRunId).toBe("run-1");
    expect(renewed.checkoutLeaseRenewedAt).toBe("2026-10-07T21:40:00.000Z");
    expect((await store.getTask(task.id)).checkoutLeaseRenewedAt).toBe("2026-10-07T21:40:00.000Z");
    expect(events).toContain(task.id);
  });

  it("rejects a missing task and a deleted task", async () => {
    const store = h.store();
    await expect(store.renewCheckoutLease("FN-404", { checkoutRunId: null, checkoutLeaseRenewedAt: "2026-10-07T21:40:00.000Z" }))
      .rejects.toThrow("Task FN-404 not found");

    const task = await store.createTask({ description: "deleted renewal target" });
    await store.deleteTask(task.id);
    await expect(store.renewCheckoutLease(task.id, { checkoutRunId: null, checkoutLeaseRenewedAt: "2026-10-07T21:40:00.000Z" }))
      .rejects.toThrow();
  });

  it("renews only the bound project's row when another project has the same task id", async () => {
    const bind = (projectId: string): AsyncDataLayer => ({ ...h.layer(), projectId });
    const storeA = new TaskStore(h.rootDir(), undefined, { asyncLayer: bind("lease-project-a") });
    const storeB = new TaskStore(h.rootDir(), undefined, { asyncLayer: bind("lease-project-b") });
    const taskA = await storeA.createTask({ description: "project A task" });
    const sharedId = taskA.id;
    const rowFor = async (projectId: string) => (await h.adminDb()
      .select({ renewedAt: schema.project.tasks.checkoutLeaseRenewedAt })
      .from(schema.project.tasks)
      .where(and(eq(schema.project.tasks.id, sharedId), eq(schema.project.tasks.projectId, projectId))))[0];

    await expect(storeB.renewCheckoutLease(sharedId, { checkoutRunId: "run-b", checkoutLeaseRenewedAt: "2026-10-07T21:41:00.000Z" }))
      .rejects.toThrow(`Task ${sharedId} not found`);
    expect((await rowFor("lease-project-a"))?.renewedAt ?? null).toBeNull();

    await storeA.renewCheckoutLease(sharedId, { checkoutRunId: "run-a", checkoutLeaseRenewedAt: "2026-10-07T21:42:00.000Z" });
    expect((await rowFor("lease-project-a"))?.renewedAt).toBe("2026-10-07T21:42:00.000Z");
  });
});
