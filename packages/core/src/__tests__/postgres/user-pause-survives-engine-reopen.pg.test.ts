import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { readTaskRow } from "../../task-store/async/async-persistence.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
} from "../../__test-utils__/pg-test-harness.js";
import type { TaskStore } from "../../store.js";

/*
FNXC:WorkflowLifecycle 2026-10-08-01:40:
KB-013 symptom verification against a REAL store. Original symptom: an operator pauses a card, then an
engine-sourced move reopens it into a planning lane without `preservePause`; the reopen wiped the park, the
card became dispatchable, and the scheduler restarted work the operator stopped.
The rule is now structural in the default-workflow hooks: a non-user move (engine, operator, absent source)
never clears an operator pause; only a user move or an explicit `pauseTask(id, false)` lifts it.
Legal backward moves used here: engine wip -> hold names the registered `plan-review-revise-replan`
reason; `operator` and absent sources are exempt from the direction policy, so they can reopen from review.

FNXC:LifecycleContainment 2026-10-08-06:02:
KB-045 judges an absent source as an automatic engine move, so a sourceless wip -> hold reopen is now
refused by FN-207 containment; the card stays in WIP and the operator park survives. Only `operator` and
`user` sources remain exempt from the direction policy.
*/
pgDescribe("operator pause survives non-user reopens into planning (KB-013)", () => {
  const harness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_user_pause_reopen" });
  beforeAll(harness.beforeAll);
  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);
  afterAll(harness.afterAll);

  async function pausedInProgress(store: TaskStore, description: string): Promise<string> {
    const created = await store.createTask({ description });
    await store.moveTask(created.id, "todo", { moveSource: "engine" });
    await store.moveTask(created.id, "in-progress", { moveSource: "scheduler" });
    await store.pauseTask(created.id, true, undefined, { userPaused: true });
    return created.id;
  }

  // Raw rows store `paused`/`user_paused` as integer 0/1 columns, hence the Boolean() reads.
  async function expectParked(store: TaskStore, id: string): Promise<void> {
    const row = await readTaskRow(store.asyncLayer!, id);
    expect(row?.column).toBe("todo");
    expect(Boolean(row?.paused)).toBe(true);
    expect(Boolean(row?.userPaused)).toBe(true);
    const task = await store.getTask(id);
    expect(task.paused).toBe(true);
    expect(task.userPaused).toBe(true);
    // The scheduler's dispatch-skip predicate stays true.
    expect(Boolean(task.paused || task.userPaused)).toBe(true);
  }

  it("keeps the pause across an engine wip -> hold reopen without preservePause, until an explicit unpause", async () => {
    const store = harness.store();
    const id = await pausedInProgress(store, "Operator paused, then engine replan");

    const moved = await store.moveTask(id, "todo", {
      moveSource: "engine",
      lifecycleReason: "plan-review-revise-replan",
    });
    expect(moved.paused).toBe(true);
    expect(moved.userPaused).toBe(true);
    await expectParked(store, id);

    const unpaused = await store.pauseTask(id, false);
    expect(unpaused.paused).toBeFalsy();
    expect(unpaused.userPaused).toBeFalsy();
    const row = await readTaskRow(store.asyncLayer!, id);
    expect(Boolean(row?.paused)).toBe(false);
    expect(Boolean(row?.userPaused)).toBe(false);
  });

  it("refuses an absent-source wip -> hold reopen and keeps the card parked in place", async () => {
    const store = harness.store();
    const id = await pausedInProgress(store, "Operator paused, then sourceless requeue");

    await expect(store.moveTask(id, "todo")).rejects.toThrow(/Forbidden lifecycle path/);
    const row = await readTaskRow(store.asyncLayer!, id);
    expect(row?.column).toBe("in-progress");
    expect(Boolean(row?.paused)).toBe(true);
    expect(Boolean(row?.userPaused)).toBe(true);
  });

  it("keeps the pause across an operator-source review -> hold reopen", async () => {
    const store = harness.store();
    const created = await store.createTask({ description: "Operator paused in review, then operator retry" });
    await store.moveTask(created.id, "todo", { moveSource: "engine" });
    await store.moveTask(created.id, "in-progress", { moveSource: "scheduler" });
    await store.moveTask(created.id, "in-review", { moveSource: "engine" });
    await store.pauseTask(created.id, true, undefined, { userPaused: true });

    await store.moveTask(created.id, "todo", { moveSource: "operator" });
    await expectParked(store, created.id);
  });

  it("still clears an engine-owned park on an engine reopen (unchanged semantics)", async () => {
    const store = harness.store();
    const created = await store.createTask({ description: "Engine park, then engine replan" });
    await store.moveTask(created.id, "todo", { moveSource: "engine" });
    await store.moveTask(created.id, "in-progress", { moveSource: "scheduler" });
    await store.pauseTask(created.id, true, undefined, { pausedReason: "branch-conflict-unrecoverable" });

    await store.moveTask(created.id, "todo", {
      moveSource: "engine",
      lifecycleReason: "plan-review-revise-replan",
    });
    const row = await readTaskRow(store.asyncLayer!, created.id);
    expect(Boolean(row?.paused)).toBe(false);
    expect(Boolean(row?.pausedReason)).toBe(false);
  });

  it("a user move to the hold lane re-parks with userPaused", async () => {
    const store = harness.store();
    const id = await pausedInProgress(store, "Operator paused, then operator drag");

    const moved = await store.moveTask(id, "todo", { moveSource: "user" });
    expect(moved.userPaused).toBe(true);
    expect(moved.paused).toBeFalsy();
    const row = await readTaskRow(store.asyncLayer!, id);
    expect(Boolean(row?.userPaused)).toBe(true);
  });
});
