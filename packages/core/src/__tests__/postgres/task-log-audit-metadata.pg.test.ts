/*
FNXC:RunAudit 2026-10-07-21:40:
A logEntry with a run context records a task:log audit row. Its action and outcome are free text already kept in the task
log, so the audit metadata must not repeat them.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

pgDescribe("task:log run-audit metadata (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_task_log_audit" });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);

  it("records fixed-shape metadata without the entry prose", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "audit prose target" });
    const secret = "token=ghp_SENTINEL";

    await store.logEntry(task.id, `pushed with ${secret}`, `remote said ${secret}`, { agentId: "agent-1", runId: "run-1" });

    const events = (await store.getRunAuditEventsAsync({ taskId: task.id })).filter((event) => event.mutationType === "task:log");
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toEqual({ hasOutcome: true });
    expect(JSON.stringify(events)).not.toContain("SENTINEL");
    expect((await store.getTask(task.id)).log.some((entry) => entry.action.includes("SENTINEL"))).toBe(true);
  });
});
