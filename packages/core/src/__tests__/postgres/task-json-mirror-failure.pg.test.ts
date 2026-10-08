/*
FNXC:WindowsAtomicWrites 2026-10-07-21:40:
task.json is a mirror of a PostgreSQL row that has already committed when it is written. A mirror write that still fails
after the Windows rename retry must not turn a landed mutation into a reported failure, and must not swallow the cache
refresh or the lifecycle event. Every post-commit publisher on the generic write paths is covered.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { TaskStore } from "../../store.js";

pgDescribe("a failed task.json mirror write after commit is non-fatal (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_task_json_mirror" });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);

  function failMirror(store: TaskStore): void {
    (store as unknown as Record<string, unknown>).writeTaskJsonFile = async () => {
      throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
    };
  }

  const reader = () => new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() });

  it.each([
    ["updateTask", (store: TaskStore, id: string) => store.updateTask(id, { summary: "landed" }), (task: { summary?: string }) => task.summary === "landed"],
    ["updateTask with runContext", (store: TaskStore, id: string) => store.updateTask(id, { summary: "landed" }, { agentId: "agent", runId: "run" }), (task: { summary?: string }) => task.summary === "landed"],
    ["pauseTask", (store: TaskStore, id: string) => store.pauseTask(id, true), (task: { paused?: boolean }) => task.paused === true],
    ["logEntry", (store: TaskStore, id: string) => store.logEntry(id, "landed entry"), (task: { log: Array<{ action: string }> }) => task.log.some((entry) => entry.action === "landed entry")],
    ["renewCheckoutLease", (store: TaskStore, id: string) => store.renewCheckoutLease(id, { checkoutRunId: "run-1", checkoutLeaseRenewedAt: "2026-10-07T21:40:00.000Z" }), (task: { checkoutRunId?: string }) => task.checkoutRunId === "run-1"],
  ] as const)("%s resolves, emits task:updated and leaves the committed row", async (_label, mutate, landed) => {
    const store = reader();
    const task = await store.createTask({ description: "mirror failure target" });
    const events: string[] = [];
    store.on("task:updated", (updated) => events.push(updated.id));
    failMirror(store);

    await expect(mutate(store, task.id)).resolves.toBeDefined();

    expect(events).toContain(task.id);
    expect(landed((await reader().getTask(task.id)) as never)).toBe(true);
  });

  it("moveTask resolves and emits task:moved", async () => {
    const store = reader();
    const task = await store.createTask({ description: "mirror failure move target" });
    const moved: string[] = [];
    store.on("task:moved", (event) => moved.push(event.task.id));
    failMirror(store);

    await expect(store.moveTask(task.id, "in-progress", { bypassGuards: true } as never)).resolves.toMatchObject({ column: "in-progress" });

    expect(moved).toContain(task.id);
    expect((await reader().getTask(task.id)).column).toBe("in-progress");
  });
});
