import { describe, expect, it } from "vitest";
import { applyOriginalDescription, type Task, type TaskDetail, type TaskStore } from "@fusion/core";
import { extractFileScope } from "../merge/merger-file-scope.js";
import { validateDiffScope } from "../merger.js";
import { buildWorkflowFailureScopeGuard } from "../executor/workflow-failure-scope-guard.js";
import { buildStepPrompt } from "../execution/step-session-executor.js";
import { __testOnlyPromptCompaction } from "../pi.js";
import { detectDanglingTaskDocReferences } from "../spec-validation/task-document-references.js";
import { detectExternalIntegrationEvidenceGaps } from "../spec-validation/external-integration-evidence.js";
import { getNoCommitEligibilityReason } from "../executor/no-commit-eligibility.js";
import { QUOTED_DECOY_PATH, plannedPromptWithQuotedScope } from "./_quoted-file-scope-prompt.js";

/*
FNXC:FileScope 2026-10-11-14:50:
Every engine reader of File Scope locates the section through the core locator.
Each case uses a planned prompt whose Original Description quotes a File Scope list and asserts the consumer acts on the plan's own list.
*/
const REAL_PATH = "packages/engine/src/real.ts";
const prompt = plannedPromptWithQuotedScope();

function fileScopePortion(text: string): string {
  const start = text.indexOf("## File Scope");
  expect(start).toBeGreaterThanOrEqual(0);
  const next = text.indexOf("\n## ", start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

describe("File Scope consumers ignore a list quoted in the Original Description", () => {
  it("extractFileScope returns only the plan's entries", () => {
    expect(extractFileScope(prompt)).toEqual([REAL_PATH]);
  });

  it("validateDiffScope judges changes against the plan's scope", async () => {
    const store = { getTask: async () => ({ prompt }) } as unknown as TaskStore;
    const diffStat = [
      ` ${QUOTED_DECOY_PATH} | 4 ++--`,
      ` ${REAL_PATH} | 4 ++--`,
      " 2 files changed, 4 insertions(+), 4 deletions(-)",
    ].join("\n");

    const result = await validateDiffScope(store, "KB-1", diffStat);

    expect(result.outOfScopeFiles).toEqual([QUOTED_DECOY_PATH]);
  });

  it("the remediation scope guard lists the plan's scope", () => {
    const guard = buildWorkflowFailureScopeGuard({ id: "KB-1" } as Task, prompt);
    expect(guard).toContain(`- ${REAL_PATH}`);
    expect(guard).not.toContain(QUOTED_DECOY_PATH);
  });

  it("the step prompt quotes the plan's File Scope", () => {
    const task = {
      id: "KB-1",
      title: "Example",
      description: "Example",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Work", status: "pending" }],
      currentStep: 0,
      log: [],
      prompt,
      createdAt: "2026-10-11T00:00:00.000Z",
      updatedAt: "2026-10-11T00:00:00.000Z",
    } as TaskDetail;

    const portion = fileScopePortion(buildStepPrompt(task, 0));

    expect(portion).toContain(REAL_PATH);
    expect(portion).not.toContain(QUOTED_DECOY_PATH);
  });

  it("the compacted task prompt keeps the plan's File Scope", () => {
    const verbose = Array.from({ length: 120 }, (_, i) => `- verbose requirement ${i}: ${"x".repeat(80)}`).join("\n");
    const planned = plannedPromptWithQuotedScope(undefined, { extraSections: `## Do NOT\n\n${verbose}` });
    const out = __testOnlyPromptCompaction.compactLargePromptSections(`## Task PROMPT.md\n\n\`\`\`markdown\n${planned}\n\`\`\``);

    expect(out).not.toBeNull();
    const portion = fileScopePortion(out ?? "");
    expect(portion).toContain(REAL_PATH);
    expect(portion).not.toContain(QUOTED_DECOY_PATH);
  });

  it("a task-local artifact listed only in the quoted section is still reported as dangling", async () => {
    const artifact = ".fusion/tasks/KB-1/notes.md";
    const planned = applyOriginalDescription(
      [
        "# Task: KB-1 - Example",
        "",
        "## Mission",
        "",
        "Do the planned work.",
        "",
        "## File Scope",
        "",
        `- \`${REAL_PATH}\``,
        "",
        "## Steps",
        "",
        "### Step 1: Read",
        "",
        `- Read ${artifact}`,
        "",
      ].join("\n"),
      `The requester keeps notes.\n\n## File Scope\n- \`${artifact}\``,
    );

    const refs = await detectDanglingTaskDocReferences(planned, {
      rootDir: "project-root",
      taskId: "KB-1",
      existsImpl: async () => false,
    });

    expect(refs.map((ref) => ref.path)).toEqual([artifact]);
  });

  it("integration keywords only in the quoted section demand no evidence", () => {
    const request = [
      "The requester wants an external integration.",
      "",
      "## File Scope",
      "- Install and probe the `worktrunk` binary.",
      "- Download from https://github.com/example/worktrunk/releases/latest/download/worktrunk.tar.gz",
    ].join("\n");

    expect(detectExternalIntegrationEvidenceGaps({ promptContent: plannedPromptWithQuotedScope(undefined, { request }) })).toEqual([]);
  });

  it("no-commit eligibility reads the plan's section, not board-only wording in the request", () => {
    const planned = applyOriginalDescription(
      [
        "# Task: KB-1 - Route the handoff",
        "",
        "## Review Level: 1 (Plan Only)",
        "",
        "## Mission",
        "",
        "Record the routing handoff for the owner. Do not edit product source.",
        "",
        "## File Scope",
        "",
        `- \`${REAL_PATH}\``,
        "",
        "## Steps",
        "",
        "### Step 1: Record",
        "",
        "- [ ] Record it.",
        "",
      ].join("\n"),
      "Route this handoff.\n\n## File Scope\n- task board updates only",
    );

    expect(getNoCommitEligibilityReason({ id: "KB-1", prompt: planned } as Task)).toBeNull();
  });
});
