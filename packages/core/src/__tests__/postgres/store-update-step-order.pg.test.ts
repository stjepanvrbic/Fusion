/**
 * FNXC:SqliteFinalRemoval 2026-06-25-00:00:
 * PostgreSQL-backed counterpart of store-update-step-order.test.ts.
 *
 * Migrated from `createSharedTaskStoreTestHarness` (SQLite) to
 * `createSharedPgTaskStoreTestHarness`. Validates step-order guard semantics
 * work identically against PostgreSQL backend mode.
 */
import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { findOpenDecisionGateStep } from "../../tasks/decision-gate.js";
import {
  DECISION_WAIT_CODE,
  DECISION_WAIT_ORIGIN,
  buildTaskExternalBlockPatch,
  buildTaskExternalBlockReport,
  isTaskAwaitingDecision,
  type TaskExternalBlock,
} from "../../tasks/task-external-block.js";

const pgTest = pgDescribe;

pgTest("TaskStore.updateStep step-order guard (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_step_order",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("no-ops out-of-order done updates when an earlier step is pending", async () => {
    const store = h.store();
    const task = await h.createTaskWithSteps();

    await store.updateStep(task.id, 0, "done");
    const updated = await store.updateStep(task.id, 2, "done");

    expect(updated.steps[2].status).toBe("pending");
  });

  it("does not start a later step when an earlier ordered step is still in progress", async () => {
    const store = h.store();
    const task = await h.createTaskWithSteps();

    await store.updateStep(task.id, 0, "in-progress");
    await Promise.all([
      store.updateStep(task.id, 1, "done"),
      store.updateStep(task.id, 2, "in-progress"),
    ]);

    const updated = await store.getTask(task.id);
    expect(updated.steps.map((step) => step.status)).toEqual([
      "in-progress",
      "pending",
      "pending",
    ]);
    expect(updated.currentStep).toBe(0);
    expect(updated.log.map((entry) => entry.action)).toContainEqual(
      expect.stringContaining("Ignored out-of-order in-progress for step 2"),
    );
  });

  /*
   * FNXC:StepLifecycle 2026-07-22-10:30:
   * Legacy state can already contain the inversion being repaired. The atomic start verdict
   * must report the dependency rejection even though the target remains in-progress.
   */
  it("reports blocked for a corrupted in-progress step with an unfinished predecessor", async () => {
    const store = h.store();
    const task = await h.createTaskWithSteps();
    await store.updateTask(task.id, {
      steps: task.steps.map((step, index) => ({
        ...step,
        status: index < 2 ? "in-progress" as const : step.status,
      })),
    });

    const result = await store.startStep(task.id, 1);

    expect(result).toMatchObject({
      accepted: false,
      disposition: "blocked",
      blockingStepIndex: 0,
    });
    expect(result.task.steps[1].status).toBe("in-progress");
  });

  it("reports resumed for a valid in-progress step whose predecessors are terminal", async () => {
    const store = h.store();
    const task = await h.createTaskWithSteps();
    await store.updateStep(task.id, 0, "done");
    await store.updateStep(task.id, 1, "in-progress");

    const result = await store.startStep(task.id, 1);

    expect(result).toMatchObject({
      accepted: true,
      disposition: "resumed",
    });
    expect(result.task.steps[1].status).toBe("in-progress");
  });

  /*
   * FNXC:DecisionGate 2026-10-12-06:16:
   * The decision-gate attribute and the decision-wait freeze live in JSONB columns with no migration.
   * The store must return both unchanged after step updates and a re-read, because the executor authorizes a decision wait from the stored steps and every operator view reads the stored freeze.
   */
  it("keeps the decision-gate attribute and a decision-wait freeze through store writes and reads", async () => {
    const store = h.store();
    const task = await h.createTaskWithSteps();
    await store.updateTask(task.id, {
      steps: task.steps.map((step, index) => (index === 1 ? { ...step, decisionGate: true as const } : step)),
    });
    expect(findOpenDecisionGateStep((await store.getTask(task.id)).steps)).toBeUndefined();

    await store.updateStep(task.id, 0, "done");
    expect(findOpenDecisionGateStep((await store.getTask(task.id)).steps)).toBe(1);
    const started = await store.updateStep(task.id, 1, "in-progress");
    expect(started.steps[1]).toMatchObject({ status: "in-progress", decisionGate: true });
    expect(started.steps[0]).not.toHaveProperty("decisionGate");

    const cause = { origin: DECISION_WAIT_ORIGIN, code: DECISION_WAIT_CODE };
    const externalBlock: TaskExternalBlock = {
      ...cause,
      message: "Awaiting the owner's choice among options 1-4.",
      source: "agent-declaration",
      blockedAt: "2026-10-12T06:16:00.000Z",
      resume: { column: started.column, currentStep: 1 },
      report: buildTaskExternalBlockReport(cause, { question: "Which option should this task implement?", unblockCondition: "Record the option in a comment, then retry." }),
    };
    await store.updateTask(task.id, buildTaskExternalBlockPatch(externalBlock) as never);

    const frozen = await store.getTask(task.id);
    expect(isTaskAwaitingDecision(frozen)).toBe(true);
    expect(frozen).toMatchObject({ status: "blocked", paused: true, pausedReason: "external-block", column: started.column });
    expect(frozen.externalBlock).toEqual(externalBlock);
    expect(frozen.steps[1]).toMatchObject({ status: "in-progress", decisionGate: true });
    expect(findOpenDecisionGateStep(frozen.steps)).toBe(1);
  });

  it("allows an explicitly independent step to finish out of index order", async () => {
    const store = h.store();
    const task = await h.createTaskWithSteps();
    await store.updateTask(task.id, {
      steps: task.steps.map((step, index) =>
        index === 2 ? { ...step, dependsOn: [] } : step,
      ),
    });

    const active = await store.updateStep(task.id, 2, "in-progress");
    expect(active.steps[2].status).toBe("in-progress");

    const updated = await store.updateStep(task.id, 2, "done");

    expect(updated.steps[0].status).toBe("pending");
    expect(updated.steps[1].status).toBe("pending");
    expect(updated.steps[2].status).toBe("done");
    expect(updated.currentStep).toBe(0);

    const remaining = await store.updateStep(task.id, 0, "done");
    expect(remaining.currentStep).toBe(1);
    const finalized = await store.updateStep(task.id, 1, "done");
    expect(finalized.steps.every((step) => step.status === "done")).toBe(true);
    expect(finalized.currentStep).toBe(3);
  });

  it("still blocks out-of-index completion when an explicit dependency is pending", async () => {
    const store = h.store();
    const task = await h.createTaskWithSteps();
    await store.updateTask(task.id, {
      steps: task.steps.map((step, index) =>
        index === 2 ? { ...step, dependsOn: [1] } : step,
      ),
    });

    await store.updateStep(task.id, 1, "in-progress");
    const updated = await store.updateStep(task.id, 2, "done");

    expect(updated.steps[2].status).toBe("pending");
    expect(updated.log.at(-1)?.action).toContain("dependency step 1");
  });

  it("blocks a start when an explicit dependency is still in progress", async () => {
    const store = h.store();
    const task = await h.createTaskWithSteps();
    await store.updateTask(task.id, {
      steps: task.steps.map((step, index) =>
        index === 2 ? { ...step, dependsOn: [1] } : step,
      ),
    });

    await store.updateStep(task.id, 0, "done");
    const started = await store.updateStep(task.id, 1, "in-progress");
    expect(started.steps[1].status).toBe("in-progress");

    const updated = await store.updateStep(task.id, 2, "in-progress");

    expect(updated.steps[2].status).toBe("pending");
    expect(updated.log.at(-1)?.action).toContain("dependency step 1");
  });

  it("allows a satisfied explicit dependency while an unrelated earlier step is pending", async () => {
    const store = h.store();
    const task = await h.createTaskWithSteps();
    await store.updateTask(task.id, {
      steps: task.steps.map((step, index) =>
        index === 1
          ? { ...step, dependsOn: [] }
          : index === 2
            ? { ...step, dependsOn: [1] }
            : step,
      ),
    });

    await store.updateStep(task.id, 1, "done");
    const updated = await store.updateStep(task.id, 2, "done");

    expect(updated.steps[0].status).toBe("pending");
    expect(updated.steps[1].status).toBe("done");
    expect(updated.steps[2].status).toBe("done");
  });

  it("honors an explicit empty dependency list for graph-source completion", async () => {
    const store = h.store();
    const task = await h.createTaskWithSteps();
    await store.updateTask(task.id, {
      steps: task.steps.map((step, index) =>
        index === 2 ? { ...step, dependsOn: [] } : step,
      ),
    });

    const updated = await store.updateStep(task.id, 2, "done", { source: "graph" });

    expect(updated.steps[2].status).toBe("done");
  });

  it("blocks a graph-source start while its implicit predecessor is unfinished", async () => {
    const store = h.store();
    const task = await h.createTaskWithSteps();

    const updated = await store.updateStep(task.id, 2, "in-progress", { source: "graph" });

    expect(updated.steps[2].status).toBe("pending");
    expect(updated.log.map((entry) => entry.action)).toContainEqual(
      expect.stringContaining("Ignored dependency-order in-progress for step 2"),
    );
    expect(updated.log.map((entry) => entry.action)).toContainEqual(
      expect.stringContaining("[integrity-warning] graph-source updateStep suppressed"),
    );
  });

  /*
   * FNXC:StepDependencyValidation 2026-10-01-22:44:
   * FN-9435 makes malformed persisted dependency metadata terminal rather than treating it as
   * legacy sequential ordering. Refusing before mutation preserves the target step and leaves a
   * durable integrity record that operators can use to repair the corrupt plan.
   */
  it.each([{ dependsOn: [2] }, { dependsOn: [99] }, { dependsOn: [-1] }, { dependsOn: [1.5] }])(
    "terminally refuses malformed persisted dependsOn %j before mutating the target step",
    async ({ dependsOn }) => {
      const store = h.store();
      const task = await h.createTaskWithSteps();
      await store.updateTask(task.id, {
        steps: task.steps.map((step, index) =>
          index === 2 ? { ...step, dependsOn } : step,
        ),
      });

      const updated = await store.updateStep(task.id, 2, "done");

      expect(updated.steps[2].status).toBe("pending");
      expect(updated.log.map((entry) => entry.action)).toContainEqual(
        expect.stringContaining("[integrity-error] invalid step dependencies"),
      );
    },
  );

  it("allows done when prior steps are skipped", async () => {
    const store = h.store();
    const task = await h.createTaskWithSteps();

    await store.updateStep(task.id, 0, "done");
    await store.updateStep(task.id, 1, "skipped");
    const updated = await store.updateStep(task.id, 2, "done");

    expect(updated.steps[2].status).toBe("done");
    expect(updated.currentStep).toBe(3);
  });

  it("allows done when prior steps are done and advances currentStep", async () => {
    const store = h.store();
    const task = await h.createTaskWithSteps();

    await store.updateStep(task.id, 0, "done");
    await store.updateStep(task.id, 1, "done");
    const updated = await store.updateStep(task.id, 2, "done");

    expect(updated.steps[2].status).toBe("done");
    expect(updated.currentStep).toBe(3);
  });

  it("keeps done→in-progress regression guard behavior", async () => {
    const store = h.store();
    const task = await h.createTaskWithSteps();

    await store.updateStep(task.id, 0, "done");
    const updated = await store.updateStep(task.id, 0, "in-progress");

    expect(updated.steps[0].status).toBe("done");
  });
});
