import { describe, expect, it, vi } from "vitest";

vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn(),
  wrapToolsWithOutputBudget: vi.fn((tools: unknown[]) => tools),
  wrapToolsWithRtkRewrite: vi.fn((tools: unknown[]) => tools),
  wrapToolsWithPermanentAgentGating: vi.fn((tools: unknown[]) => tools),
  wrapToolsWithActionGate: vi.fn((tools: unknown[]) => tools),
  describeModel: vi.fn().mockReturnValue("mock-provider/mock-model"),
  formatModelMarkerDetails: vi.fn((model: string) => model),
  promptWithFallback: vi.fn(),
}));

import type { Task, TaskDetail } from "@fusion/core";
import { buildStepPrompt, parseStepFileScopes } from "../execution/step-session-executor.js";
import { reviewStep } from "../execution/reviewer.js";
import { createFnAgent, promptWithFallback } from "../pi.js";
import { detectDanglingTaskDocReferences } from "../spec-validation/task-document-references.js";
import { detectExternalIntegrationEvidenceGaps } from "../spec-validation/external-integration-evidence.js";
import { getNoCommitEligibilityReason } from "../executor/no-commit-eligibility.js";
import { extractPromptSection, parseReviewLevelFromPrompt } from "../executor/prompt-derived-eligibility.js";
import {
  DECOY_CONTEXT_PATH,
  DECOY_STEP_PATH,
  DECOY_STRINGS,
  PLAN_COMPLETION,
  PLAN_CONTEXT_PATH,
  PLAN_DEPENDENCY,
  PLAN_DO_NOT,
  PLAN_GIT,
  PLAN_MISSION,
  PLAN_STEP_PATHS,
  plannedPromptWithQuotedSections,
} from "./_quoted-plan-sections-prompt.js";

/*
FNXC:PlanSections 2026-10-11-17:08:
Every engine reader of plan sections and step headings locates them through the core plan-section locator.
Each case runs a planned prompt whose Original Description quotes the plan's headings with decoy content through a production entry point, and asserts the plan's content is used and no decoy appears.
*/
const prompt = plannedPromptWithQuotedSections();

function expectNoDecoy(text: string): void {
  for (const decoy of DECOY_STRINGS) expect(text).not.toContain(decoy);
}

function taskFor(promptText: string): TaskDetail {
  return {
    id: "KB-1",
    title: "Example",
    description: "Example",
    column: "in-progress",
    dependencies: [],
    steps: [
      { name: "Preflight", status: "pending" },
      { name: "Implement", status: "pending" },
    ],
    currentStep: 0,
    log: [],
    prompt: promptText,
    createdAt: "2026-10-11T00:00:00.000Z",
    updatedAt: "2026-10-11T00:00:00.000Z",
  } as TaskDetail;
}

describe("plan-section consumers ignore sections quoted in the Original Description", () => {
  it("the first step prompt quotes the plan's sections and the plan's Step 0", () => {
    const stepPrompt = buildStepPrompt(taskFor(prompt), 0);

    for (const value of [PLAN_DO_NOT, PLAN_CONTEXT_PATH, PLAN_DEPENDENCY, PLAN_GIT, "### Step 0: Preflight", PLAN_STEP_PATHS[0]]) {
      expect(stepPrompt).toContain(value);
    }
    expect(stepPrompt).not.toContain(PLAN_COMPLETION);
    expectNoDecoy(stepPrompt);
  });

  it("the last plan step is the last step and carries the plan's Completion Criteria", () => {
    const stepPrompt = buildStepPrompt(taskFor(prompt), 1);

    expect(stepPrompt).toContain("### Step 1: Implement");
    expect(stepPrompt).toContain(PLAN_COMPLETION);
    expect(stepPrompt).toContain("**Document your deliverables:**");
    expectNoDecoy(stepPrompt);
  });

  it("per-step file scopes follow the plan's step positions", () => {
    const scopes = parseStepFileScopes(prompt);

    expect([...scopes.keys()]).toEqual([0, 1]);
    expect(scopes.get(0)).toContain(PLAN_STEP_PATHS[0]);
    expect(scopes.get(1)).toContain(PLAN_STEP_PATHS[1]);
    expect([...scopes.values()].flat()).not.toContain(DECOY_STEP_PATH);
  });

  it("the reviewer's compacted retry quotes the plan's Mission, Dependencies and step titles", async () => {
    const subscribers: Array<(event: unknown) => void> = [];
    vi.mocked(createFnAgent).mockResolvedValue({
      session: {
        prompt: vi.fn(async () => {
          for (const subscriber of subscribers) {
            subscriber({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "### Verdict: APPROVE\n### Summary\nok" } });
          }
        }),
        subscribe: vi.fn((cb: (event: unknown) => void) => subscribers.push(cb)),
        dispose: vi.fn(),
      },
    } as never);
    vi.mocked(promptWithFallback)
      .mockImplementationOnce(async () => {
        throw new Error("exceeded model token limit: 262144 (requested: 262879)");
      })
      .mockImplementationOnce(async (session, request) => {
        await session.prompt(request);
      });
    const task = { id: "KB-1", column: "in-progress", steps: [], log: [], reviewerContextRetryCount: 0 };
    const store = {
      getSettings: vi.fn().mockResolvedValue({ maxReviewerContextRetries: 2, maxTotalRetriesBeforeFail: 25 }),
      getTask: vi.fn(async () => task),
      updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => Object.assign(task, patch)),
      logEntry: vi.fn().mockResolvedValue(undefined),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
    };

    await reviewStep("worktree", "KB-1", 1, "Implement", "code", prompt, "abc123", { store: store as never, taskId: "KB-1" });

    const retryRequest = vi.mocked(promptWithFallback).mock.calls[1]?.[1] as string;
    for (const value of [PLAN_MISSION, PLAN_DEPENDENCY, "### Step 0: Preflight", "### Step 1: Implement"]) {
      expect(retryRequest).toContain(value);
    }
    expectNoDecoy(retryRequest);
  });

  it("the compacted task prompt keeps the plan's Mission, Dependencies and step outline", async () => {
    const { __testOnlyPromptCompaction } = await vi.importActual<typeof import("../pi.js")>("../pi.js");
    const verbose = Array.from({ length: 120 }, (_, i) => `- verbose requirement ${i}: ${"x".repeat(80)}`).join("\n");
    const planned = plannedPromptWithQuotedSections({ extraSections: `## Notes\n\n${verbose}` });
    const out = __testOnlyPromptCompaction.compactLargePromptSections(`## Task PROMPT.md\n\n\`\`\`markdown\n${planned}\n\`\`\``) ?? "";

    for (const value of [PLAN_MISSION, PLAN_DEPENDENCY, "### Step 0: Preflight", "### Step 1: Implement"]) {
      expect(out).toContain(value);
    }
    expectNoDecoy(out);
  });

  it("a task-local reference quoted in the request's reading list is not reported; the same reference in the plan's Steps is", async () => {
    const options = { rootDir: "project-root", taskId: "KB-1", existsImpl: async () => false };

    expect(await detectDanglingTaskDocReferences(prompt, options)).toEqual([]);

    const citing = plannedPromptWithQuotedSections({ stepExtra: `- [ ] Read ${DECOY_CONTEXT_PATH}` });
    expect((await detectDanglingTaskDocReferences(citing, options)).map((ref) => ref.path)).toEqual([DECOY_CONTEXT_PATH]);
  });

  it("an integration keyword only in the quoted Mission demands no evidence; in the plan's Mission it does", () => {
    expect(detectExternalIntegrationEvidenceGaps({ promptContent: prompt })).toEqual([]);

    const integrating = plannedPromptWithQuotedSections({ mission: "Install the cloudflared binary and wire it into the engine." });
    const gaps = detectExternalIntegrationEvidenceGaps({ promptContent: integrating });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.missing).toContain("canonical-upstream-repo-url");
  });

  it.each([
    ["the plan's Review Level is not Plan Only", {}],
    ["the plan's Mission implements code", { reviewLevel: "1 (Plan Only)" }],
  ])("no-commit eligibility stays off when %s, whatever the request quotes", (_label, options) => {
    const planned = plannedPromptWithQuotedSections({ ...options, scope: "task board updates only" });
    expect(getNoCommitEligibilityReason({ id: "KB-1", prompt: planned } as Task)).toBeNull();
  });

  it("the Review Level and named sections come from the plan", () => {
    expect(parseReviewLevelFromPrompt(prompt)).toBe(2);
    expect(extractPromptSection(prompt, "Mission")).toBe(PLAN_MISSION);
  });
});
