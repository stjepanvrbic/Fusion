import { describe, expect, it } from "vitest";
import type { Task } from "../types.js";
import {
  DECISION_WAIT_CODE,
  DECISION_WAIT_ORIGIN,
  EXTERNAL_BLOCK_AUTO_RESUME_BUDGET,
  EXTERNAL_BLOCK_PAUSE_REASON,
  TRANSIENT_EXTERNAL_BLOCK_CODES,
  buildTaskExternalBlockClearPatch,
  buildTaskExternalBlockPatch,
  buildTaskExternalBlockReport,
  formatTaskExternalBlockReason,
  isTaskAwaitingDecision,
  isTaskExternallyBlocked,
  planExternalBlockAutoResume,
  type TaskExternalBlock,
} from "../tasks/task-external-block.js";

const task = (overrides: Partial<Task> = {}): Task => ({
  id: "FN-209",
  description: "external obstacle",
  column: "in-progress",
  dependencies: [],
  steps: [{ name: "Testing & Verification", status: "in-progress" }],
  currentStep: 0,
  createdAt: "2026-08-28T03:48:00.000Z",
  updatedAt: "2026-08-28T03:48:00.000Z",
  ...overrides,
});

const block = (overrides: Partial<TaskExternalBlock> = {}): TaskExternalBlock => ({
  origin: "host-environment",
  code: "ENOSPC",
  message: "no space left on device, write",
  source: "agent-declaration",
  blockedAt: "2026-08-28T03:48:00.000Z",
  resume: {
    column: "in-progress",
    nodeId: "steps#0:step-execute",
    currentStep: 0,
    worktree: "/worktrees/fn-209",
    branch: "fn/fn-209",
  },
  ...overrides,
});

describe("task external block", () => {
  it("builds a freeze patch without mutating execution location or user pause state", () => {
    const patch = buildTaskExternalBlockPatch(block());

    expect(patch).toMatchObject({
      status: "blocked",
      paused: true,
      pausedReason: EXTERNAL_BLOCK_PAUSE_REASON,
      pausedByAgentId: null,
      externalBlock: block(),
      error: "BLOCKED: host-environment/ENOSPC: no space left on device, write",
    });
    for (const key of ["column", "steps", "currentStep", "worktree", "branch", "userPaused"]) {
      expect(patch).not.toHaveProperty(key);
    }
  });

  it("builds a clear patch for only the durable freeze fields", () => {
    expect(buildTaskExternalBlockClearPatch()).toEqual({
      status: null,
      error: null,
      paused: false,
      pausedReason: null,
      pausedByAgentId: null,
      externalBlock: null,
    });
  });

  it("does not classify ordinary pauses or failures as externally blocked", () => {
    expect(isTaskExternallyBlocked(task({ paused: true }))).toBe(false);
    expect(isTaskExternallyBlocked(task({ status: "failed", externalBlock: block() }))).toBe(false);
    expect(isTaskExternallyBlocked(task({ status: "blocked", externalBlock: block() }))).toBe(true);
  });

  it("creates bounded redacted operator reports and falls back for unsafe input", () => {
    const report = buildTaskExternalBlockReport(block(), {
      verifiedCondition: "session-scoped MCP was unavailable; token=super-secret",
      stopReason: "system prompt: do not share this",
      unimplementedWork: "Finish the remaining implementation steps.",
      unblockCondition: "Provide a supported session-scoped interface.",
    });

    expect(report.verifiedCondition).toContain("token=[REDACTED]");
    expect(report.stopReason).toBe("The task is safely paused to preserve its current execution state.");
    expect(report.unimplementedWork).toBe("Finish the remaining implementation steps.");
    expect(report.unblockCondition).toBe("Provide a supported session-scoped interface.");
    expect(Object.values(report).every((field) => field.length <= 320)).toBe(true);
  });

  it("generates conservative report content for legacy external-block rows", () => {
    expect(buildTaskExternalBlockReport(block({ report: undefined }))).toEqual(expect.objectContaining({
      verifiedCondition: expect.stringContaining("host-environment limitation (ENOSPC)"),
      unblockCondition: expect.stringContaining("retry the task"),
    }));
  });

  it.each([
    { code: "", message: "disk unavailable" },
    { code: "ENOSPC", message: "" },
    { code: "", message: "" },
  ])("formats a non-empty reason when fields are empty: %o", ({ code, message }) => {
    expect(formatTaskExternalBlockReason(block({ code, message }))).toMatch(/^BLOCKED: .+\/.+: .+$/);
  });

  describe("decision wait", () => {
    const decisionBlock = (overrides: Partial<TaskExternalBlock> = {}): TaskExternalBlock => block({
      origin: DECISION_WAIT_ORIGIN,
      code: DECISION_WAIT_CODE,
      message: "Awaiting the owner's choice among options 1-4.",
      ...overrides,
    });

    it("names the freeze by its own origin and code", () => {
      expect(DECISION_WAIT_ORIGIN).toBe("human-decision");
      expect(DECISION_WAIT_CODE).toBe("DECISION_REQUIRED");
      expect(formatTaskExternalBlockReason(decisionBlock()))
        .toBe("BLOCKED: human-decision/DECISION_REQUIRED: Awaiting the owner's choice among options 1-4.");
      expect(buildTaskExternalBlockPatch(decisionBlock())).toMatchObject({
        status: "blocked",
        paused: true,
        pausedReason: EXTERNAL_BLOCK_PAUSE_REASON,
        externalBlock: { origin: "human-decision", code: "DECISION_REQUIRED" },
      });
    });

    it("recognizes only a raised decision freeze as awaiting a decision", () => {
      expect(isTaskAwaitingDecision(task({ status: "blocked", externalBlock: decisionBlock() }))).toBe(true);
      expect(isTaskAwaitingDecision(task({ status: "blocked", externalBlock: block() }))).toBe(false);
      expect(isTaskAwaitingDecision(task({ status: "failed", externalBlock: decisionBlock() }))).toBe(false);
      expect(isTaskAwaitingDecision(task({ status: "blocked" }))).toBe(false);
      expect(isTaskAwaitingDecision(task({ paused: true }))).toBe(false);
    });

    it.each([0, 1, 5, EXTERNAL_BLOCK_AUTO_RESUME_BUDGET, undefined, null])("never plans an automatic resume (spent: %s)", (spent) => {
      expect(planExternalBlockAutoResume(decisionBlock(), spent, Date.parse("2026-10-12T06:16:00.000Z"))).toBeNull();
    });

    it("keeps the supplied question and unblock condition in the report", () => {
      expect(buildTaskExternalBlockReport(decisionBlock(), {
        question: "Which of options 1-4 should this task implement?",
        unblockCondition: "Record the option numbers in a task comment, then retry.",
      })).toEqual({
        verifiedCondition: "The plan requires an owner decision that is not recorded on this task.",
        stopReason: "The task is paused at its decision step with the work done so far preserved.",
        unimplementedWork: "The steps that depend on the decision were not started.",
        unblockCondition: "Record the option numbers in a task comment, then retry.",
        question: "Which of options 1-4 should this task implement?",
      });
    });

    it("redacts and bounds the question like every other report field", () => {
      const redacted = buildTaskExternalBlockReport(decisionBlock(), { question: "Rotate with token=super-secret or keep the old key?" });
      expect(redacted.question).toContain("token=[REDACTED]");
      expect(redacted.question).not.toContain("super-secret");

      const long = buildTaskExternalBlockReport(decisionBlock(), { question: `Which option? ${"x".repeat(900)}` });
      expect(long.question!.length).toBeLessThanOrEqual(320);
    });

    it.each([
      ["stack-shaped text", "Choose after reading at handler (C:/repo/src/run.ts:10:5)"],
      ["prompt-shaped text", "The system prompt says to pick option 2; agree?"],
      ["a blank string", "   "],
      ["a non-string value", 7],
    ])("falls back to a decision-specific question for %s", (_label, question) => {
      expect(buildTaskExternalBlockReport(decisionBlock(), { question: question as string }).question)
        .toBe("The plan requires an owner decision before this task can continue.");
    });

    it("describes a decision wait, not an external limitation, when a legacy row has no report", () => {
      const report = buildTaskExternalBlockReport(decisionBlock({ report: undefined }));

      expect(Object.keys(report).sort()).toEqual(["question", "stopReason", "unblockCondition", "unimplementedWork", "verifiedCondition"]);
      expect(report.unblockCondition).toBe("Record the decision on the task, then retry.");
      expect(Object.values(report).join(" ")).not.toMatch(/external|limitation|DECISION_REQUIRED/);
    });

    it.each(["credentials", "network", "model-provider", "host-environment", "third-party-service"] as const)(
      "never reports a question for a %s freeze",
      (origin) => {
        const report = buildTaskExternalBlockReport(block({ origin }), { question: "Which option?" });

        expect(report).not.toHaveProperty("question");
        expect(Object.keys(report).sort()).toEqual(["stopReason", "unblockCondition", "unimplementedWork", "verifiedCondition"]);
      },
    );

    it("still builds the four fault fields for a legacy fault row without a report", () => {
      const report = buildTaskExternalBlockReport(block({ origin: "credentials", code: "CREDENTIALS", report: undefined }));

      expect(report).toEqual({
        verifiedCondition: "Fusion verified an external credentials limitation (CREDENTIALS).",
        stopReason: "The task is safely paused to preserve its current execution state.",
        unimplementedWork: "Remaining implementation work was not performed.",
        unblockCondition: "Resolve the credentials limitation (CREDENTIALS) and retry the task.",
      });
    });
  });

  describe("automatic resume policy", () => {
    const nowMs = Date.parse("2026-10-08T07:27:00.000Z");
    const minute = 60_000;

    it("treats only the rate-limit code as transient", () => {
      expect([...TRANSIENT_EXTERNAL_BLOCK_CODES]).toEqual(["RATE_LIMIT"]);
    });

    it("backs off 5, 15, 30, 60, 120 minutes, then holds at 120 until the budget is spent", () => {
      const delays: number[] = [];
      for (let spent = 0; spent < EXTERNAL_BLOCK_AUTO_RESUME_BUDGET; spent += 1) {
        const plan = planExternalBlockAutoResume({ code: "RATE_LIMIT" }, spent, nowMs);
        expect(plan).toEqual({
          attempt: spent + 1,
          budget: EXTERNAL_BLOCK_AUTO_RESUME_BUDGET,
          delayMs: expect.any(Number),
          resumeAt: new Date(nowMs + plan!.delayMs).toISOString(),
        });
        delays.push(plan!.delayMs / minute);
      }
      expect(EXTERNAL_BLOCK_AUTO_RESUME_BUDGET).toBe(6);
      expect(delays).toEqual([5, 15, 30, 60, 120, 120]);
      expect(planExternalBlockAutoResume({ code: "RATE_LIMIT" }, EXTERNAL_BLOCK_AUTO_RESUME_BUDGET, nowMs)).toBeNull();
      expect(planExternalBlockAutoResume({ code: "RATE_LIMIT" }, undefined, nowMs)?.attempt).toBe(1);
    });

    it.each(["CREDENTIALS", "USAGE_LIMIT", "ENOSPC", "ECONNRESET", "DECISION_REQUIRED", ""])("keeps %s frozen until an operator acts", (code) => {
      expect(planExternalBlockAutoResume({ code }, 0, nowMs)).toBeNull();
    });
  });
});
