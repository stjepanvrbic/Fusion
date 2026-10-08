/*
FNXC:WorkflowLifecycleColumns 2026-07-27-23:20 (Phase B / slice B2):

MeshLeaseManager recovers a task whose owning node abandoned its lease by
clearing the local lease and rebounding the card to the backlog. Four literal
sites decided where "the backlog" is:

  - `if (task.column !== "todo")`      — the already-parked guard
  - `moveTask(task.id, "todo", …)`     — the rebound target
  - `decisionPath: … "lease-recovered-in-place" : "lease-recovered-to-todo"`
  - `newColumn: … task.column : "todo"` — the audit's record of where it landed

Under a workflow with no `todo` column the first three misbehave TOGETHER and
quietly: the guard says "not already parked" (true, but for the wrong reason),
and the move then targets a column id the workflow does not define. The audit
meanwhile asserts the card landed in `todo` regardless of what actually
happened, so the run-audit trail — the only post-hoc record of a lease recovery
— records a column that does not exist.

These tests were written against the literal implementation and observed
FAILING first. The rebound target is the KTD-10 `resolveReboundTarget` ordering
(hold → intake → first column) already used by self-healing.ts:714, not a new
rule invented here.

FNXC:LifecycleContainment 2026-10-08-05:45:
KB-045 keeps lease recovery in the card's current lifecycle role: a WIP card is recovered in place (WIP→hold is F5), an unresolvable workflow recovers in place instead of guessing `todo`, and only a forward move (for example intake→hold) still rebounds, as an engine move.
*/
import { describe, expect, it, vi } from "vitest";
import type { RunAuditEventInput, Task, TaskStore, WorkflowIr } from "@fusion/core";

import { MeshLeaseManager } from "../project/mesh-lease-manager.js";

const WF = "custom:wf";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    description: "x",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    checkedOutBy: "agent-1",
    checkedOutAt: "2026-05-01T00:00:00.000Z",
    checkoutLeaseRenewedAt: "2026-05-01T00:00:00.000Z",
    checkoutLeaseEpoch: 1,
    checkoutNodeId: "node-a",
    ...overrides,
  } as Task;
}

/** A workflow whose hold column is `drafting` — there is NO `todo` column. */
function renamedIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "inbox", label: "Inbox", traits: [{ trait: "intake" }] },
      { id: "drafting", label: "Drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "building", label: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "shipped", label: "Shipped", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

/** The builtin coding shape, for the byte-identical regression floor. */
function defaultIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "triage", label: "Triage", traits: [{ trait: "intake" }] },
      { id: "todo", label: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", label: "In Progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "done", label: "Done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function harness(currentTask: Task, ir: WorkflowIr | undefined) {
  const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
  const moveTask = vi.fn().mockResolvedValue(currentTask);
  const selection = { workflowId: WF, stepIds: [] };

  const taskStore = {
    getTask: vi.fn().mockResolvedValue(currentTask),
    updateTask: vi.fn().mockResolvedValue(currentTask),
    moveTask,
    logEntry: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent,
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    // `undefined` ir models a workflow that cannot be resolved at all.
    getWorkflowDefinition: vi.fn(async () => (ir ? { ir } : null)),
  } as unknown as TaskStore;

  const manager = new MeshLeaseManager({
    taskStore,
    nodeHealthMonitor: { getNodeHealth: () => "offline" } as never,
    getHandoffPolicy: vi.fn().mockResolvedValue("reassign-any-healthy"),
    localNodeId: "local",
  });

  const unreachableEvent = () =>
    recordRunAuditEvent.mock.calls
      .map((call) => call[0] as RunAuditEventInput)
      .find((c) => c.mutationType === "task:auto-recover-node-unreachable");

  return { manager, moveTask, unreachableEvent };
}

describe("MeshLeaseManager lease rebound under a renamed column vocabulary", () => {
  it("recovers an abandoned WIP lease in place instead of stepping back to the renamed hold column", async () => {
    const current = task({ column: "building" });
    const h = harness(current, renamedIr());

    const ok = await h.manager.recoverAbandonedLease("FN-1", "stale lease");

    expect(ok).toBe(true);
    // KB-045: WIP→hold is a backward F5 move and lease recovery is not a revision.
    expect(h.moveTask).not.toHaveBeenCalled();
  });

  it("records the column the card ACTUALLY stayed in for an in-place WIP recovery", async () => {
    const current = task({ column: "building" });
    const h = harness(current, renamedIr());

    await h.manager.recoverAbandonedLease("FN-1", "stale lease");

    /* The audit is the only post-hoc record of a lease recovery; it must name
       the column the card is really in. */
    expect(h.unreachableEvent()?.metadata).toMatchObject({
      previousColumn: "building",
      newColumn: "building",
      decisionPath: "lease-recovered-in-place",
    });
  });

  it("treats a card already AT the renamed hold column as recovered in place", async () => {
    const current = task({ column: "drafting" });
    const h = harness(current, renamedIr());

    await h.manager.recoverAbandonedLease("FN-1", "stale lease");

    // No redundant move, and the audit says in-place rather than claiming a move.
    expect(h.moveTask).not.toHaveBeenCalled();
    expect(h.unreachableEvent()?.metadata).toMatchObject({
      newColumn: "drafting",
      decisionPath: "lease-recovered-in-place",
    });
  });

  it("moves an intake card forward to the renamed hold column as an engine move", async () => {
    /* Intake is not the rebound target — KTD-10 prefers hold, and only falls
       back to intake when the workflow declares no hold column. Intake→hold is
       forward, so the move stays. */
    const current = task({ column: "inbox" });
    const h = harness(current, renamedIr());

    await h.manager.recoverAbandonedLease("FN-1", "stale lease");

    expect(h.moveTask).toHaveBeenCalledWith("FN-1", "drafting", expect.objectContaining({ moveSource: "engine" }));
    expect(h.moveTask).not.toHaveBeenCalledWith("FN-1", "todo", expect.any(Object));
    expect(h.unreachableEvent()?.metadata).toMatchObject({
      previousColumn: "inbox",
      newColumn: "drafting",
      decisionPath: "lease-recovered-to-todo",
    });
  });

  it("recovers in place when the workflow cannot be resolved", async () => {
    /* KB-045: an unresolvable workflow must not invent the legacy todo route,
       which would be a backward move for a WIP card. */
    const current = task({ column: "in-progress" });
    const h = harness(current, undefined);

    await h.manager.recoverAbandonedLease("FN-1", "stale lease");

    expect(h.moveTask).not.toHaveBeenCalled();
    expect(h.unreachableEvent()?.metadata).toMatchObject({
      newColumn: "in-progress",
      decisionPath: "lease-recovered-in-place",
    });
  });

  it("recovers a WIP card in place when the workflow selection read throws", async () => {
    /* The resolver degrades a throwing selection read to the default coding IR;
       the WIP card must still stay put rather than rebound to its todo lane. */
    const current = task({ column: "in-progress" });
    const h = harness(current, renamedIr());
    const failingStore = (h.manager as unknown as { options: { taskStore: Record<string, unknown> } }).options.taskStore;
    failingStore.getTaskWorkflowSelectionAsync = vi.fn(async () => {
      throw new Error("selection read failed");
    });
    failingStore.getTaskWorkflowSelection = vi.fn(() => {
      throw new Error("selection read failed");
    });

    await h.manager.recoverAbandonedLease("FN-1", "stale lease");

    expect(h.moveTask).not.toHaveBeenCalled();
    expect(h.unreachableEvent()?.metadata).toMatchObject({
      newColumn: "in-progress",
      decisionPath: "lease-recovered-in-place",
    });
  });

  it("keeps a builtin-coding WIP card in place (regression floor)", async () => {
    const current = task({ column: "in-progress" });
    const h = harness(current, defaultIr());

    await h.manager.recoverAbandonedLease("FN-1", "stale lease");

    expect(h.moveTask).not.toHaveBeenCalled();
    expect(h.unreachableEvent()?.metadata).toMatchObject({
      previousColumn: "in-progress",
      newColumn: "in-progress",
      decisionPath: "lease-recovered-in-place",
    });
  });

  it("moves a builtin-coding intake card forward to todo as an engine move", async () => {
    const current = task({ column: "triage" });
    const h = harness(current, defaultIr());

    await h.manager.recoverAbandonedLease("FN-1", "stale lease");

    expect(h.moveTask).toHaveBeenCalledWith("FN-1", "todo", expect.objectContaining({ moveSource: "engine" }));
  });
});
