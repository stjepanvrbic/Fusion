import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

/*
FNXC:DecisionWait 2026-10-12-06:16:
A task whose plan requires an owner decision must be able to stop once, at the step the plan marks as a decision gate, and wait as a human-held freeze.
The park is not a general exit: without an open plan-marked gate the declaration is refused with the repair ladder, whatever its explanation says.
*/

const QUESTION = "Which of options 1-4 should this task implement?";
const UNBLOCK = "Record the chosen option numbers in a task comment, then retry.";
const REASON = "Awaiting the owner's choice among options 1-4; no choice is recorded on this card.";

type StepFixture = { name: string; status: string; decisionGate?: true; dependsOn?: number[] };

function baseTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-900",
    title: "Decision wait test",
    description: "",
    column: "in-progress",
    worktree: "/repo/.worktrees/calm-heron",
    branch: "fusion/fn-900",
    baseCommitSha: "abc123",
    effectiveNodeId: "steps#1:step-execute",
    steps: [
      { name: "Preflight", status: "done" },
      { name: "Read the owner's choice", status: "in-progress", decisionGate: true },
      { name: "Implement the chosen option", status: "pending" },
    ] as StepFixture[],
    currentStep: 1,
    dependencies: [],
    log: [],
    createdAt: "2026-10-12T06:16:00.000Z",
    updatedAt: "2026-10-12T06:16:00.000Z",
    ...overrides,
  };
}

function setup(overrides: Record<string, unknown> = {}, options: { recordRunAuditEvent?: ReturnType<typeof vi.fn> } = {}) {
  const store = createMockStore();
  store.recordRunAuditEvent = options.recordRunAuditEvent ?? vi.fn().mockResolvedValue(undefined);
  let task: any = baseTask(overrides);
  store.getTask.mockImplementation(async () => structuredClone(task));
  store.updateTask.mockImplementation(async (_id: string, updates: any) => {
    task = { ...task, ...updates };
    return task;
  });
  const onDone = vi.fn();
  const tool = (new TaskExecutor(store as any, "/repo") as any).createTaskDoneTool(task.id, task.worktree, "", new Map(), onDone);
  return { store, tool, onDone, getTask: () => task };
}

function declaration(overrides: Record<string, unknown> = {}) {
  return {
    outcome: "blocked",
    obstacle: "decision-required",
    reason: REASON,
    decision: { question: QUESTION, unblockCondition: UNBLOCK },
    ...overrides,
  };
}

function parkedRows(store: ReturnType<typeof createMockStore>) {
  return store.recordRunAuditEvent.mock.calls.map(([event]: [any]) => event);
}

describe("fn_task_done decision-required exit", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it.each([
    ["in progress", baseTask().steps],
    ["pending with every earlier step finished", [
      { name: "Preflight", status: "done" },
      { name: "Research", status: "skipped" },
      { name: "Read the owner's choice", status: "pending", decisionGate: true },
    ]],
    ["pending with its declared dependency finished", [
      { name: "Preflight", status: "done" },
      { name: "Unrelated work", status: "in-progress" },
      { name: "Read the owner's choice", status: "pending", decisionGate: true, dependsOn: [0] },
    ]],
  ])("parks the task once when the plan's decision gate is %s", async (_label, steps) => {
    const { store, tool, onDone, getTask } = setup({ steps });
    const before = structuredClone(getTask());

    const result = await tool.execute("id", declaration());
    const parked = getTask();

    expect(result.details).toEqual({});
    expect(result.content[0].text).toContain("Task parked waiting for a decision.");
    expect(result.content[0].text).toContain("the running-agent slot is released");
    expect(result.content[0].text).toContain("Retry resumes the interrupted workflow node");
    expect(parked).toMatchObject({
      status: "blocked",
      paused: true,
      pausedReason: "external-block",
      error: `BLOCKED: human-decision/DECISION_REQUIRED: ${REASON}`,
      externalBlock: {
        origin: "human-decision",
        code: "DECISION_REQUIRED",
        message: REASON,
        source: "agent-declaration",
        resume: {
          column: "in-progress",
          nodeId: "steps#1:step-execute",
          currentStep: 1,
          worktree: "/repo/.worktrees/calm-heron",
          branch: "fusion/fn-900",
        },
        report: { question: QUESTION, unblockCondition: UNBLOCK },
      },
    });
    expect(parked.externalBlock.autoResume).toBeUndefined();
    expect(parked.externalBlock.resumeRequest).toBeUndefined();
    expect(parked).not.toHaveProperty("userPaused");
    for (const key of ["column", "worktree", "branch", "steps", "currentStep", "dependencies"]) {
      expect(parked[key]).toEqual(before[key]);
    }
    expect(store.updateTask).toHaveBeenCalledTimes(1);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateStep).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(parkedRows(store).map((event: any) => event.mutationType)).toEqual(["task:external-block-parked"]);
  });

  it("names the decision wait and the gate step in the task log", async () => {
    const { store, tool } = setup();

    await tool.execute("id", declaration());

    const logged = store.logEntry.mock.calls.map(([, message]: [string, string]) => message);
    expect(logged).toEqual([
      "Decision wait parked at decision-gate Step 1 (Read the owner's choice) (human-decision/DECISION_REQUIRED); worktree and execution progress retained for Retry",
    ]);
  });

  it("builds the operator report from blockedReport plus the declared question and unblock condition", async () => {
    const { tool, getTask } = setup();

    await tool.execute("id", declaration({
      blockedReport: {
        verifiedCondition: "No owner comment or steering message is recorded.",
        unimplementedWork: "Steps 2-8 were not started.",
        unblockCondition: "This field is superseded by the declared decision.",
      },
    }));

    expect(getTask().externalBlock.report).toEqual({
      verifiedCondition: "No owner comment or steering message is recorded.",
      stopReason: "The task is paused at its decision step with the work done so far preserved.",
      unimplementedWork: "Steps 2-8 were not started.",
      unblockCondition: UNBLOCK,
      question: QUESTION,
    });
  });

  it("parks the stored KB-147 explanation as a decision wait, never as a fault", async () => {
    const reason = "Awaiting the owner's choice among KB-147 options 1-4 (KB-144 recommends 1 with 2). No owner-authored choice is recorded on this card: the task record has no comments or steering messages, the description is the unchanged original, and the only task documents are the planner's plan and the executor's owner-decision-request. The specification forbids choosing for the owner or defaulting to the recommendation, so Steps 2-8 cannot start. This is not a host, network, provider or credential failure and no tool or check is missing. Unblock: an owner comment on KB-147 naming the option numbers (option 3 only with explicit approval of the wider connection budget, option 4 only with sub-variant 4a or 4b).";
    const { tool, getTask } = setup();

    await tool.execute("id", declaration({ reason }));

    expect(getTask().externalBlock).toMatchObject({ origin: "human-decision", code: "DECISION_REQUIRED", message: reason });
    expect(getTask().error).toBe(`BLOCKED: human-decision/DECISION_REQUIRED: ${reason}`);
  });

  it("emits one parked row with ids and fixed outcomes only", async () => {
    const { store, tool } = setup();

    await tool.execute("id", declaration({
      blockedReport: { verifiedCondition: "No owner comment is recorded.", stopReason: "The plan forbids choosing for the owner." },
    }));

    const rows = parkedRows(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mutationType: "task:external-block-parked", target: "FN-900", taskId: "FN-900", agentId: "executor" });
    expect(rows[0].metadata).toEqual({
      taskId: "FN-900",
      origin: "human-decision",
      code: "DECISION_REQUIRED",
      source: "agent-declaration",
      column: "in-progress",
      resumeNodeId: "steps#1:step-execute",
    });
    const serialized = JSON.stringify(rows[0]);
    for (const prose of [QUESTION, UNBLOCK, REASON, "No owner comment is recorded.", "The plan forbids choosing for the owner.", "Read the owner's choice"]) {
      expect(serialized).not.toContain(prose);
    }
  });

  it.each([
    ["has no steps", []],
    ["has no decision gate", [
      { name: "Preflight", status: "done" },
      { name: "Implement", status: "in-progress" },
    ]],
    ["has a finished decision gate", [
      { name: "Read the owner's choice", status: "done", decisionGate: true },
      { name: "Implement", status: "in-progress" },
    ]],
    ["has a skipped decision gate", [
      { name: "Read the owner's choice", status: "skipped", decisionGate: true },
      { name: "Implement", status: "in-progress" },
    ]],
    ["has a decision gate behind an unfinished step", [
      { name: "Preflight", status: "done" },
      { name: "Implement", status: "in-progress" },
      { name: "Choose the rollout", status: "pending", decisionGate: true },
    ]],
    ["has a decision gate whose declared dependency is unfinished", [
      { name: "Preflight", status: "in-progress" },
      { name: "Choose the rollout", status: "pending", decisionGate: true, dependsOn: [0] },
    ]],
  ])("refuses the declaration when the plan %s", async (_label, steps) => {
    const { store, tool, getTask } = setup({ steps });
    const before = structuredClone(getTask());

    const result = await tool.execute("id", declaration());

    expect(result.details.error).toBe(result.content[0].text);
    expect(result.content[0].text.startsWith("This decision wait is not authorized: the approved plan has no open decision-gate step.")).toBe(true);
    expect(result.content[0].text).toContain("Continue repairing in place");
    expect(result.content[0].text).toContain("Repair ladder: (1) Resolve it");
    expect(result.content[0].text).toContain("(2) Substitute");
    expect(result.content[0].text).toContain("(3) Degrade and record");
    expect(getTask()).toEqual(before);
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalled();
    expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing interpreter", "The required Python regression command cannot run because neither python nor python3 is installed in the execution host.", "missing-tooling"],
    ["a failing test suite", "Three unit tests fail after my change and the owner should decide whether to keep them.", undefined],
    ["a contradictory plan", "Step 3 and Step 5 of the plan contradict each other, so the owner must choose which one applies.", undefined],
  ])("is not an exit from %s when no decision gate is open", async (_label, reason, hint) => {
    const { store, tool, getTask } = setup({
      steps: [{ name: "Preflight", status: "done" }, { name: "Implement", status: "in-progress" }],
    });
    const before = structuredClone(getTask());

    const result = await tool.execute("id", declaration({ reason }));

    expect(result.details.error).toContain("This decision wait is not authorized: the approved plan has no open decision-gate step.");
    expect(result.details.error).toContain("Repair ladder: (1) Resolve it");
    if (hint) expect(result.details.error).toContain(`Detected AI-repairable obstacle hint: ${hint}.`);
    expect(getTask()).toEqual(before);
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["no decision", { decision: undefined }],
    ["a blank question", { decision: { question: "   ", unblockCondition: UNBLOCK } }],
    ["a blank unblock condition", { decision: { question: QUESTION, unblockCondition: "\n" } }],
    ["a question only", { decision: { question: QUESTION } }],
  ])("refuses a declaration with %s at an open gate", async (_label, overrides) => {
    const { store, tool, getTask } = setup();
    const before = structuredClone(getTask());

    const result = await tool.execute("id", declaration(overrides));

    expect(result.details.error).toContain("requires a non-empty `decision.question` and `decision.unblockCondition`");
    expect(getTask()).toEqual(before);
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it("refuses a declaration that also names a dependency task", async () => {
    const { store, tool, getTask } = setup();
    const before = structuredClone(getTask());

    const result = await tool.execute("id", declaration({ blockedBy: ["FN-8145"] }));

    expect(result.details.error).toContain("does not take `blockedBy`");
    expect(result.details.error).toContain("Declare either the task dependency");
    expect(getTask()).toEqual(before);
    expect(getTask().dependencies).toEqual([]);
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it("does not write a second park for a card that is already waiting for a decision", async () => {
    const { store, tool, getTask } = setup();
    await tool.execute("id", declaration());
    const parked = structuredClone(getTask());

    const result = await tool.execute("id", declaration({
      reason: "Still waiting for the owner.",
      decision: { question: "A different question?", unblockCondition: "A different condition." },
    }));

    expect(result.details).toEqual({});
    expect(result.content[0].text).toContain("Task parked waiting for a decision.");
    expect(getTask()).toEqual(parked);
    expect(store.updateTask).toHaveBeenCalledTimes(1);
    expect(store.logEntry).toHaveBeenCalledTimes(1);
    expect(parkedRows(store)).toHaveLength(1);
  });

  it("still requires a reason and an obstacle before reading the task", async () => {
    const { store, tool } = setup();

    const noReason = await tool.execute("id", { outcome: "blocked", obstacle: "decision-required", decision: { question: QUESTION, unblockCondition: UNBLOCK } });
    const noObstacle = await tool.execute("id", { outcome: "blocked", reason: REASON, decision: { question: QUESTION, unblockCondition: UNBLOCK } });

    expect(noReason.details.error).toContain("requires a non-empty `reason`");
    expect(noObstacle.details.error).toContain('"outside-worktree", "inside-worktree", or "decision-required"');
    expect(store.getTask).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it.each([
    ["inside-worktree", {}],
    ["outside-worktree", {}],
    ["outside-worktree", { externalFailure: { cause: "credentials", observedError: "The owner has not chosen an option." } }],
  ])("keeps refusing a decision described under obstacle=%s, even at an open gate", async (obstacle, extra) => {
    const { store, tool, getTask } = setup();
    const before = structuredClone(getTask());

    const result = await tool.execute("id", { outcome: "blocked", obstacle, reason: REASON, ...extra });

    expect(result.details.error).toContain("This obstacle is not authorized to freeze the card.");
    expect(getTask()).toEqual(before);
    expect(store.updateTask).not.toHaveBeenCalled();
  });
});
