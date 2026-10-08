/*
FNXC:WorkflowTaskCancellation 2026-10-07-21:40:
The operator hard cancel runs its merge and work-item cleanup after the move has committed. Two of those calls were
fire-and-forget, so a rejection (a transient PostgreSQL error, or a refused work-item transition) became an unhandled
rejection, which the process supervisor treats as fatal. Every post-commit cleanup on both hard-cancel surfaces must be
best-effort: the move resolves and nothing rejects unhandled.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import "@fusion/core";

import { pgDescribe, createSharedPgTaskStoreTestHarness } from "../../__test-utils__/pg-test-harness.js";
import type { TaskStore } from "../../store.js";

pgDescribe("operator hard cancel cleanup is best-effort (PostgreSQL)", () => {
  const harness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_moves_cancel_best_effort" });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };

  beforeAll(harness.beforeAll);
  afterAll(harness.afterAll);
  beforeEach(async () => {
    await harness.beforeEach();
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
  });
  afterEach(async () => {
    process.off("unhandledRejection", onUnhandled);
    await harness.afterEach();
  });

  const WORK_ITEM_AND_MARKER_CLEANUP = ["cancelActiveWorkflowWorkItemsForTask", "clearCompletionHandoffAcceptedMarker"];
  const ALL_CLEANUP = [...WORK_ITEM_AND_MARKER_CLEANUP, "getMergeRequestRecordAsync"];

  function failCleanup(store: TaskStore, methods: readonly string[]): void {
    const failure = () => Promise.reject(new Error("transient cleanup failure"));
    for (const method of methods) (store as unknown as Record<string, unknown>)[method] = failure;
  }

  async function settle(): Promise<void> {
    for (let index = 0; index < 5; index++) await new Promise<void>((resolve) => setImmediate(resolve));
  }

  it.each([
    ["in-review", "work-item and marker cleanup", WORK_ITEM_AND_MARKER_CLEANUP],
    ["in-review", "every cleanup step", ALL_CLEANUP],
    ["in-progress", "every cleanup step", ALL_CLEANUP],
  ] as const)("a user move from %s back to todo resolves when %s rejects", async (fromColumn, _label, failing) => {
    const store = harness.store();
    const task = await store.createTask({ description: `hard cancel from ${fromColumn}` });
    await store.moveTask(task.id, "in-progress", { bypassGuards: true } as never);
    if (fromColumn === "in-review") await store.moveTask(task.id, "in-review", { bypassGuards: true } as never);
    await store.setCompletionHandoffAcceptedMarker(task.id, { source: "test" });
    failCleanup(store, failing);

    const moved = await store.moveTask(task.id, "todo", { moveSource: "user" });
    await settle();

    expect(moved.column).toBe("todo");
    expect(unhandled).toEqual([]);
  });
});
