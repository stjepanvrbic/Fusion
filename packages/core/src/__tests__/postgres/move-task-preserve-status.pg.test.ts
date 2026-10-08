/**
 * FNXC:SqliteFinalRemoval 2026-06-25-00:00:
 * PostgreSQL-backed counterpart of move-task-preserve-status.test.ts.
 *
 * Migrated from `createSharedTaskStoreTestHarness` (SQLite) to
 * `createSharedPgTaskStoreTestHarness`. Validates that moveTask preserveStatus
 * semantics work identically against PostgreSQL backend mode.
 *
 * FNXC:LifecycleContainment 2026-10-08-06:02:
 * KB-045 judges an absent move source as an automatic engine move, so the backward
 * reopens under test name the `operator` source, which keeps the legacy absent-route
 * semantics (recorded as engine, guards kept) while staying exempt from FN-207 containment.
 */
import { afterEach, beforeEach, describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("TaskStore moveTask preserveStatus (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_move_preserve",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("clears status/error by default when moving in-progress to todo", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "preserveStatus default clear" });
    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");
    await store.updateTask(task.id, {
      status: "failed",
      error: "boom",
    });

    const moved = await store.moveTask(task.id, "todo", { moveSource: "operator" });
    expect(moved.status).toBeUndefined();
    expect(moved.error).toBeUndefined();
  });

  it("preserves status/error when preserveStatus is true on in-progress to todo", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "preserveStatus true in-progress" });
    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");
    await store.updateTask(task.id, {
      status: "failed",
      error: "branch conflict",
    });

    const moved = await store.moveTask(task.id, "todo", { preserveStatus: true, moveSource: "operator" });
    expect(moved.status).toBe("failed");
    expect(moved.error).toBe("branch conflict");
  });

  it("preserves status/error on in-review to todo when preserveStatus is true", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "preserveStatus true in-review" });
    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "in-review");
    await store.updateTask(task.id, {
      status: "failed",
      error: "recovery exhausted",
    });

    const moved = await store.moveTask(task.id, "todo", { preserveStatus: true, moveSource: "operator" });
    expect(moved.status).toBe("failed");
    expect(moved.error).toBe("recovery exhausted");
  });
});
