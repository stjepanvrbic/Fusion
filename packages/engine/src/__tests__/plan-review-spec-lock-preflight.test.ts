/*
FNXC:SpecLock 2026-10-11-10:17:
A plan the lock parser deterministically rejects must not cost an AI Plan Review session. The step
returns a deterministic REVISE before any reviewer exists, on the first dispatch and on a dispatch
that follows a post-approval lock rejection of the same unchanged plan. The positive controls keep the
"no session" assertions from passing vacuously and show that a spec whose unmarked Original
Description quotes a lockable heading is reviewed again.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { PLAN_LOCK_UNAVAILABLE_DIAGNOSTIC } from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import { createMockStore, mockedCreateFnAgent, resetExecutorMocks } from "./executor-test-helpers.js";

const TASK_ID = "KB-9118";

const plannerSpec = [
  "## What This Delivers",
  "",
  "- An approved plan reaches execution.",
  "",
  "## Mission",
  "",
  "Build a safe widget.",
  "",
  "## File Scope",
  "",
  "- src/widget.ts",
  "",
  "## Steps",
  "",
  "### Step 0: Preflight",
  "",
  "- [ ] check",
  "",
].join("\n");
const header = `# Task: ${TASK_ID} - Safe widget\n\n**Created:** 2026-10-11\n**Size:** M\n\n`;
const lockablePlan = `${header}${plannerSpec}`;
const quotedOperatorBody = "Operator request.\n\n## File Scope\n- operator/path.ts\n\nMore operator prose.";
const withUnmarkedSection = (sectionBody: string) => `${header}## Original Description\n\n${sectionBody}\n\n${plannerSpec}`;
const duplicateFileScopePlan = `${withUnmarkedSection(quotedOperatorBody)}\n## File Scope\n\n- src/other.ts\n`;

function baseTask(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    title: "Safe widget",
    description: quotedOperatorBody,
    column: "todo" as const,
    worktree: "/tmp/wt",
    branch: "fusion/kb-9118",
    baseCommitSha: "abc123",
    dependencies: [],
    steps: [{ name: "s", status: "pending" as const }],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function planReviewStep() {
  return {
    id: "graph:plan-review-step",
    name: "Plan Review",
    description: "",
    mode: "prompt",
    phase: "pre-merge",
    gateMode: "gate",
    prompt: "Review the plan.",
    toolMode: "readonly",
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function approveOnSession() {
  const output = '{"verdict":"APPROVE","notes":"Reviewed the plan and found it complete."}';
  mockedCreateFnAgent.mockImplementation(async () => {
    const listeners: Array<(event: unknown) => void> = [];
    return {
      session: {
        state: {},
        subscribe: (listener: (event: unknown) => void) => {
          listeners.push(listener);
          return () => {};
        },
        prompt: vi.fn(async () => {
          for (const listener of listeners) {
            listener({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", partial: output, contentIndex: 0, delta: output },
            });
          }
        }),
        dispose: vi.fn(),
      },
    } as never;
  });
}

function setup(prompt: string, options: { backend?: boolean; task?: Record<string, unknown> } = {}) {
  const store = createMockStore();
  const task = baseTask({ prompt, ...options.task });
  store.getTask.mockResolvedValue(task);
  store.getTaskDocument = vi.fn(async (_id: string, key: string) => (key === "PROMPT.md" ? { content: prompt } : undefined));
  if (options.backend !== undefined) store.isBackendMode = vi.fn(() => options.backend);
  const executor = new TaskExecutor(store as never, "/tmp/test", {
    agentStore: { getAgent: vi.fn().mockResolvedValue(null), createAgent: vi.fn() },
  } as never);
  const dispatch = () => (executor as unknown as {
    executeWorkflowStep: (...args: unknown[]) => Promise<Record<string, unknown>>;
  }).executeWorkflowStep(task, planReviewStep(), "/tmp/wt", {}, undefined, undefined);
  return { store, dispatch };
}

describe("Plan Review spec-lock preflight", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("starts no reviewer session on a second dispatch of an unchanged plan the lock already rejected", async () => {
    const rejection = `${PLAN_LOCK_UNAVAILABLE_DIAGNOSTIC} section-duplicate (file-scope).`;
    const { store, dispatch } = setup(duplicateFileScopePlan, {
      backend: true,
      task: {
        workflowStepResults: [{
          workflowStepId: "plan-review",
          workflowStepName: "Plan Review",
          phase: "pre-merge",
          status: "failed",
          output: rejection,
          notes: rejection,
          startedAt: "2026-10-11T08:00:00.000Z",
          completedAt: "2026-10-11T08:05:00.000Z",
        }],
      },
    });

    const result = await dispatch();

    expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, revisionRequested: true, verdict: "REVISE" });
    expect(result.notes).toContain("section-duplicate");
    expect(result.notes).toContain("file-scope");
    expect(result.output).toBe(`REVISE: ${result.notes}`);
    expect(String(result.notes).startsWith(PLAN_LOCK_UNAVAILABLE_DIAGNOSTIC)).toBe(false);
    expect(store.logEntry).toHaveBeenCalledWith(TASK_ID, expect.stringContaining("section-duplicate (file-scope)"));
  });

  it("starts no reviewer session on the first dispatch of an unlockable plan", async () => {
    const { dispatch } = setup(duplicateFileScopePlan, { backend: true });

    const result = await dispatch();

    expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, revisionRequested: true, verdict: "REVISE" });
    expect(result.notes).toContain("section-duplicate (file-scope)");
  });

  it.each([
    ["missing", lockablePlan.replace("## Mission\n\nBuild a safe widget.\n\n", ""), "mission-missing"],
    ["empty", lockablePlan.replace("Build a safe widget.\n\n", ""), "mission-empty"],
    ["duplicated", `${lockablePlan}\n## Mission\n\nSecond mission.\n`, "mission-duplicate"],
  ])("requests a revision without a session when Mission is %s", async (_state, prompt, reason) => {
    const { dispatch } = setup(prompt, { backend: true });

    const result = await dispatch();

    expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, revisionRequested: true, verdict: "REVISE" });
    expect(result.notes).toContain(`${reason} (mission)`);
  });

  it.each([
    ["a lockable plan", lockablePlan],
    ["a bare unmarked Original Description that quotes File Scope", withUnmarkedSection(quotedOperatorBody)],
    ["a fenced unmarked Original Description that quotes File Scope", withUnmarkedSection(`\`\`\`text\n${quotedOperatorBody}\n\`\`\``)],
  ])("reviews %s with exactly one reviewer session", async (_shape, prompt) => {
    approveOnSession();
    const { dispatch } = setup(prompt, { backend: true });

    const result = await dispatch();

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true, verdict: "APPROVE" });
  });

  it.each([
    ["false", false],
    ["absent", undefined],
  ])("is inert when backend storage is %s, where no spec lock exists", async (_state, backend) => {
    approveOnSession();
    const { dispatch } = setup(duplicateFileScopePlan, { backend });

    const result = await dispatch();

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true, verdict: "APPROVE" });
  });
});
