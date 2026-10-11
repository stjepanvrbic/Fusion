import { rm } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import * as schema from "../postgres/schema/index.js";
import { CORE_RUN_AUDIT_EMIT_TIMEOUT_MS } from "../run-audit/emit-bounded-run-audit.js";
import type { TaskStore } from "../store.js";
import type { WorkflowStepResult } from "../types.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../workflows/builtin-coding-workflow-ir.js";
import type { WorkflowIrV2 } from "../workflows/workflow-ir-types.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";

/*
 * FNXC:RunAudit 2026-08-20-06:40:
 * FN-9178 characterizes current awaited audit behavior through public store entry points; it is
 * not a remediation. These fixtures are PG-gated because TaskStore's durable methods require the
 * production async layer, while hostile doubles prove the operation's observable ordering.
 *
 * FNXC:RunAudit 2026-10-11-03:36:
 * Every case must settle each store operation it starts before it returns. The harness resets the database, the task ID sequence and the task directory tree between cases, so an operation that is still running acts on the next case's data and writes into a directory the next case's setup is removing. `own` tracks an operation that is not awaited at once, and the suite afterEach fails the case that leaves one running.
 * A held-sink case fakes only setTimeout and clearTimeout, and does so before it starts the operation. The operation then reaches its sink through real PostgreSQL round trips while the bounded-audit timer stays on the test clock. A default fake clock stalls those round trips, so a "still pending" assertion would pass without the sink ever being called; every pending assertion therefore follows the sink's own invocation signal.
 * Bypass and resume-step await their audit unbounded: they stay pending, without persisting, until the sink settles. Workflow-switch torn and phantom reconciliation await through the bounded seam: they settle with a typed outcome once CORE_RUN_AUDIT_EMIT_TIMEOUT_MS elapses, whatever the sink does afterwards.
 */
const LATE_AUDIT_MS = CORE_RUN_AUDIT_EMIT_TIMEOUT_MS + 100;
const SWITCH_SOURCE_COLUMN = "audit-source";
const HELD_AUDIT_STATES = ["never-settling", "late-settling"] as const;

pgDescribe("FN-9178 awaited store run-audit characterization", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_awaited_audit" });
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  const running = new Set<string>();
  function own<T>(label: string, operation: Promise<T>) {
    running.add(label);
    const settle = () => { running.delete(label); };
    operation.then(settle, settle);
    return { operation, isRunning: () => running.has(label) };
  }
  afterEach(() => {
    try {
      expect([...running], "store operations still running when the case returned").toEqual([]);
    } finally {
      running.clear();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  /** Holds the store's audit sink open on a test-controlled clock. A late-settling sink settles itself after the bounded window; a never-settling one settles only through `release`. */
  function holdAudit(store: TaskStore, state: (typeof HELD_AUDIT_STATES)[number] = "never-settling") {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let signal!: () => void;
    let release!: () => void;
    const invoked = new Promise<void>((resolve) => { signal = resolve; });
    const settled = new Promise<void>((resolve) => { release = resolve; });
    const sink = vi.spyOn(store, "recordRunAuditEvent").mockImplementation((() => {
      if (state === "late-settling") setTimeout(release, LATE_AUDIT_MS);
      signal();
      return settled;
    }) as never);
    return { sink, invoked, settled, release };
  }

  const failed = (): WorkflowStepResult => ({
    workflowStepId: "review", workflowStepName: "Review", phase: "pre-merge", status: "failed",
    completedAt: "2026-08-20T00:00:00.000Z",
  });
  const pending = (): WorkflowStepResult => ({
    workflowStepId: "review", workflowStepName: "Review", phase: "pre-merge", status: "pending",
  });

  async function seed(id: string, results: WorkflowStepResult[]) {
    const store = h.store();
    await store.createTaskWithReservedId({ description: id, column: "in-review" }, { taskId: id, applyDefaultWorkflowSteps: false });
    await store.updateTask(id, { workflowStepResults: results });
    return store;
  }

  async function seedTornSwitch(label: string) {
    const store = h.store();
    const sourceIr = structuredClone(BUILTIN_CODING_WORKFLOW_IR) as WorkflowIrV2;
    sourceIr.columns.push({ id: SWITCH_SOURCE_COLUMN, name: "Audit source", traits: [] });
    const source = await store.createWorkflowDefinition({ name: `source ${label}`, ir: sourceIr, layout: {} });
    const target = await store.createWorkflowDefinition({ name: `target ${label}`, ir: structuredClone(BUILTIN_CODING_WORKFLOW_IR) as WorkflowIrV2, layout: {} });
    const task = await store.createTask({ description: `switch ${label}` });
    await store.selectTaskWorkflow(task.id, source.id);
    await store.moveTask(task.id, SWITCH_SOURCE_COLUMN, { moveSource: "engine", bypassGuards: true, recoveryRehome: true });
    return { store, task, target };
  }

  async function seedPhantomReservation(label: string) {
    const store = h.store();
    const task = await store.createTask({ description: `phantom ${label}` });
    const layer = h.layer();
    const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
    await rm(join(h.rootDir(), ".fusion", "tasks", task.id), { recursive: true, force: true });
    await layer.db.delete(schema.project.tasks).where(and(eq(schema.project.tasks.projectId, projectId), eq(schema.project.tasks.id, task.id)));
    await layer.db.insert(schema.project.activityLog).values({ projectId, id: `audit-${task.id}`, timestamp: new Date().toISOString(), type: "task:created", taskId: task.id, details: "orphan" });
    return { store, task };
  }

  it("bypass treats an absent/non-function audit result as a completed write", async () => {
    const store = await seed("FN-BYP-ABSENT", [failed()]);
    vi.spyOn(store, "recordRunAuditEvent").mockImplementation(() => undefined as never);
    const write = vi.spyOn(store as never, "atomicWriteTaskJson");
    await expect(store.bypassFailedPreMergeReviewStep("FN-BYP-ABSENT", { reason: "test", actor: "operator" })).resolves.toBeDefined();
    expect(write).toHaveBeenCalledOnce();
  });

  it.each([
    ["synchronous throw", () => { throw new Error("sync"); }],
    ["rejection", () => Promise.reject(new Error("rejected"))],
  ])("bypass rejects and does not persist after a %s audit sink", async (_kind, sink) => {
    const id = `FN-BYP-${_kind.replace(/\W/g, "")}`;
    const store = await seed(id, [failed()]);
    vi.spyOn(store, "recordRunAuditEvent").mockImplementation(sink as never);
    const write = vi.spyOn(store as never, "atomicWriteTaskJson");
    await expect(store.bypassFailedPreMergeReviewStep(id, { reason: "test", actor: "operator" })).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
  });

  it("bypass remains pending for a never-settling audit sink", async () => {
    const store = await seed("FN-BYP-PENDING", [failed()]);
    const audit = holdAudit(store);
    const write = vi.spyOn(store as never, "atomicWriteTaskJson");
    const bypass = own("bypass", store.bypassFailedPreMergeReviewStep("FN-BYP-PENDING", { reason: "test", actor: "operator" }));
    await audit.invoked;
    expect(audit.sink).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(LATE_AUDIT_MS);
    expect(bypass.isRunning()).toBe(true);
    expect(write).not.toHaveBeenCalled();
    audit.release();
    await expect(bypass.operation).resolves.toMatchObject({ id: "FN-BYP-PENDING" });
    expect(write).toHaveBeenCalledOnce();
  });

  it("bypass waits for a late-settling audit before writing task.json", async () => {
    let resolve!: () => void;
    const store = await seed("FN-BYP-LATE", [failed()]);
    const audit = vi.spyOn(store, "recordRunAuditEvent").mockImplementation((() => new Promise<void>((done) => { resolve = done; })) as never);
    const write = vi.spyOn(store as never, "atomicWriteTaskJson");
    const { operation } = own("bypass", store.bypassFailedPreMergeReviewStep("FN-BYP-LATE", { reason: "test", actor: "operator" }));
    await vi.waitFor(() => expect(audit).toHaveBeenCalledOnce());
    expect(write).not.toHaveBeenCalled();
    resolve();
    await expect(operation).resolves.toMatchObject({ id: "FN-BYP-LATE" });
    expect(write).toHaveBeenCalledOnce();
  });

  it.each([
    ["absent", () => undefined, true],
    ["synchronous throw", () => { throw new Error("sync"); }, false],
    ["rejection", () => Promise.reject(new Error("rejected")), false],
  ])("resume-step's persistence follows a %s audit result", async (_state, sink, persists) => {
    const id = `FN-RESUME-${_state.replace(/\W/g, "")}`;
    const store = await seed(id, [pending()]);
    vi.spyOn(store, "recordRunAuditEvent").mockImplementation(sink as never);
    const write = vi.spyOn(store as never, "atomicWriteTaskJson");
    const operation = store.resumeWorkflowStep(id, { stepId: "review", reason: "test", actor: "operator" });
    if (persists) await expect(operation).resolves.toBeDefined();
    else await expect(operation).rejects.toThrow();
    expect(write).toHaveBeenCalledTimes(persists ? 1 : 0);
  });

  it.each(HELD_AUDIT_STATES)("resume-step cannot reach persistence while its %s audit is unresolved", async (state) => {
    const id = `FN-RESUME-${state}`;
    const store = await seed(id, [pending()]);
    const audit = holdAudit(store, state);
    const write = vi.spyOn(store as never, "atomicWriteTaskJson");
    const resume = own("resume-step", store.resumeWorkflowStep(id, { stepId: "review", reason: "test", actor: "operator" }));
    await audit.invoked;
    expect(audit.sink).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(CORE_RUN_AUDIT_EMIT_TIMEOUT_MS);
    // A bounded site would have settled by now; this unbounded await proceeds only once its sink settles.
    expect(resume.isRunning()).toBe(true);
    expect(write).not.toHaveBeenCalled();
    if (state === "late-settling") await vi.advanceTimersByTimeAsync(LATE_AUDIT_MS - CORE_RUN_AUDIT_EMIT_TIMEOUT_MS);
    else audit.release();
    await expect(resume.operation).resolves.toMatchObject({ id });
    expect(write).toHaveBeenCalledOnce();
  });

  it("preserves WorkflowSwitchRehomeFailedError after all hostile audit outcomes", async () => {
    for (const [state, sink] of [
      ["absent", () => undefined],
      ["sync", () => { throw new Error("sync"); }],
      ["reject", () => Promise.reject(new Error("reject"))],
    ] as const) {
      const { store, task, target } = await seedTornSwitch(state);
      vi.spyOn(store, "rehomeOccupant").mockResolvedValue({ moved: false, error: "race" } as never);
      vi.spyOn(store, "recordRunAuditEvent").mockImplementation(sink as never);
      await expect(store.selectTaskWorkflowAndReconcile(task.id, target.id)).rejects.toMatchObject({ name: "WorkflowSwitchRehomeFailedError", committed: true });
      vi.restoreAllMocks();
    }
  });

  it.each(HELD_AUDIT_STATES)("workflow-switch torn rejects with WorkflowSwitchRehomeFailedError once the bounded window elapses on a %s audit", async (state) => {
    const { store, task, target } = await seedTornSwitch(state);
    const audit = holdAudit(store, state);
    const rehome = vi.spyOn(store, "rehomeOccupant").mockResolvedValue({ moved: false } as never);
    const switching = own("workflow-switch", store.selectTaskWorkflowAndReconcile(task.id, target.id));
    await audit.invoked;
    expect(rehome).toHaveBeenCalledOnce();
    expect(audit.sink).toHaveBeenCalledOnce();
    expect(audit.sink).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "task:workflow-switch-torn", taskId: task.id }));
    await vi.advanceTimersByTimeAsync(CORE_RUN_AUDIT_EMIT_TIMEOUT_MS - 1);
    expect(switching.isRunning()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await expect(switching.operation).rejects.toMatchObject({ name: "WorkflowSwitchRehomeFailedError", committed: true });
    if (state === "late-settling") {
      await vi.advanceTimersByTimeAsync(LATE_AUDIT_MS - CORE_RUN_AUDIT_EMIT_TIMEOUT_MS);
      await audit.settled;
    }
    expect((await store.getTask(task.id)).column).toBe(SWITCH_SOURCE_COLUMN);
    expect(rehome).toHaveBeenCalledOnce();
    expect(audit.sink).toHaveBeenCalledOnce();
  });

  it.each([
    ["absent", () => undefined, "reconciled"],
    ["synchronous throw", () => { throw new Error("sync"); }, "audit-failed: sync"],
    ["rejection", () => Promise.reject(new Error("rejected")), "audit-failed: rejected"],
  ])("phantom reconciliation exposes %s audit outcome in its public result", async (_state, sink, expected) => {
    const { store, task } = await seedPhantomReservation(_state);
    vi.spyOn(store, "recordRunAuditEvent").mockImplementation(sink as never);
    const result = await store.reconcilePhantomCommittedReservations();
    if (expected === "reconciled") expect(result.reconciled).toContain(task.id);
    else expect(result.skipped).toContainEqual({ id: task.id, reason: expected });
  });

  it.each(HELD_AUDIT_STATES)("phantom reconciliation skips the reservation as timed out once the bounded window elapses on a %s audit", async (state) => {
    const { store, task } = await seedPhantomReservation(state);
    const audit = holdAudit(store, state);
    const reconciling = own("phantom reconciliation", store.reconcilePhantomCommittedReservations());
    await audit.invoked;
    expect(audit.sink).toHaveBeenCalledOnce();
    expect(audit.sink).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "task:reconcile-phantom-committed-reservation", taskId: task.id }));
    await vi.advanceTimersByTimeAsync(CORE_RUN_AUDIT_EMIT_TIMEOUT_MS - 1);
    expect(reconciling.isRunning()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    const result = await reconciling.operation;
    if (state === "late-settling") {
      await vi.advanceTimersByTimeAsync(LATE_AUDIT_MS - CORE_RUN_AUDIT_EMIT_TIMEOUT_MS);
      await audit.settled;
    }
    expect(result.reconciled).not.toContain(task.id);
    expect(result.skipped).toContainEqual({ id: task.id, reason: "audit-failed: timed-out" });
    expect(audit.sink).toHaveBeenCalledOnce();
  });
});
