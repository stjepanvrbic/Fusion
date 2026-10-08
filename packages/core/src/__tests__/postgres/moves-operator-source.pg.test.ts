/*
FNXC:LifecycleContainment 2026-10-07-21:40:
An "operator" move is a human action from a non-drag surface such as a CLI or chat retry. It may step a card back from WIP
(lifecycle containment governs automatic moves only), it is recorded and emitted as "engine" like the legacy absent source,
and it does not run the "user" hard-cancel cleanup. An explicit engine move along the same path stays refused.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import "@fusion/core";

import { pgDescribe, createSharedPgTaskStoreTestHarness } from "../../__test-utils__/pg-test-harness.js";

pgDescribe("operator move source (PostgreSQL)", () => {
  const harness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_moves_operator_source" });

  beforeAll(harness.beforeAll);
  afterAll(harness.afterAll);
  beforeEach(async () => { await harness.beforeEach(); });
  afterEach(async () => { await harness.afterEach(); });

  it("moves a review card back to the hold lane, emitted as engine, without the hard-cancel cleanup", async () => {
    const store = harness.store();
    const task = await store.createTask({ description: "operator retry target" });
    await store.moveTask(task.id, "in-progress", { bypassGuards: true } as never);
    await store.moveTask(task.id, "in-review", { bypassGuards: true } as never);
    await store.setCompletionHandoffAcceptedMarker(task.id, { source: "test" });
    const sources: string[] = [];
    store.on("task:moved", (event) => { if (event.task.id === task.id) sources.push(event.source); });

    const moved = await store.moveTask(task.id, "todo", { moveSource: "operator" });

    expect(moved.column).toBe("todo");
    expect(sources).toEqual(["engine"]);
    expect(await store.getCompletionHandoffAcceptedMarker(task.id)).not.toBeNull();
  });

  it("still refuses the same backward path for an explicit engine move", async () => {
    const store = harness.store();
    const task = await store.createTask({ description: "engine rebound target" });
    await store.moveTask(task.id, "in-progress", { bypassGuards: true } as never);

    await expect(store.moveTask(task.id, "todo", { moveSource: "engine" })).rejects.toThrow(/Forbidden lifecycle path/);
  });

  /*
  FNXC:LifecycleContainment 2026-10-08-05:54:
  KB-045 fails closed: a move that names no source is an automatic engine move, so the same backward path is refused,
  while an explicit operator move still passes. A forward unsourced handoff to review is unaffected.
  */
  it("refuses an unsourced backward move from WIP while an operator move still passes", async () => {
    const store = harness.store();
    const task = await store.createTask({ description: "unsourced rebound target" });
    await store.moveTask(task.id, "in-progress", { bypassGuards: true } as never);

    await expect(store.moveTask(task.id, "todo")).rejects.toThrow(/Forbidden lifecycle path/);
    store.taskCache.delete(task.id);
    expect((await store.getTask(task.id)).column).toBe("in-progress");

    const moved = await store.moveTask(task.id, "todo", { moveSource: "operator" });
    expect(moved.column).toBe("todo");
  });

  it("still lands an unsourced handoff of a WIP card in review", async () => {
    const store = harness.store();
    const task = await store.createTask({ description: "unsourced handoff target" });
    await store.moveTask(task.id, "in-progress", { bypassGuards: true } as never);

    await store.handoffToReview(task.id, { ownerAgentId: null, evidence: { reason: "kb-045-unsourced-handoff" } });

    store.taskCache.delete(task.id);
    expect((await store.getTask(task.id)).column).toBe("in-review");
  });
});
