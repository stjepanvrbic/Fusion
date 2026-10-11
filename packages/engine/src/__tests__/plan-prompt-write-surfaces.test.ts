import { readFile } from "node:fs/promises";

import { type RunMutationContext, type TaskStore } from "@fusion/core";
import { describe, expect, it, vi } from "vitest";
import { createTaskPromptWriteTool as createTriagePromptWriteTool } from "../agent-tools.js";
import { createTaskPromptWriteTool as createPlanReviewPromptWriteTool } from "../executor/shared-worker-tools.js";

const TASK_ID = "FN-142";
const CONTENT = "# Verified plan";

async function runTool(tool: { execute: (...args: any[]) => Promise<any> }, content = CONTENT) {
  return tool.execute("call-prompt", { content }, undefined, undefined, undefined);
}

function getText(result: any): string {
  const first = result?.content?.[0];
  return first?.type === "text" ? first.text : "";
}

function createProductionShapedStore() {
  const updateTask = vi.fn().mockResolvedValue({ id: TASK_ID });
  const getTask = vi.fn().mockResolvedValue({ id: TASK_ID, prompt: CONTENT });
  return {
    store: { updateTask, getTask } as unknown as TaskStore,
    updateTask,
    getTask,
  };
}

describe("planning prompt-write surfaces", () => {
  /*
  FNXC:PlanArtifactPersistence 2026-08-22-03:37:
  Initial planning, replanning, Plan Review repair, and reviewer inline repair must all retain the
  same fail-closed PROMPT.md read-back. Their task-row mutation result intentionally has no prompt.
  */
  it("confirms initial triage and replanning writes through the production factory with its run context", async () => {
    const { store, updateTask } = createProductionShapedStore();
    const runContext = { agentId: "triage-agent", runId: "run-142" } as RunMutationContext;

    const result = await runTool(createTriagePromptWriteTool(store, TASK_ID, runContext));

    expect(updateTask).toHaveBeenCalledWith(TASK_ID, { prompt: CONTENT }, runContext);
    expect(getText(result)).toBe(`Updated PROMPT.md for ${TASK_ID}.`);
  });

  it("rejects an invalid Markdown dependency before either prompt-write surface mutates", async () => {
    const invalid = "### Step 12: First\n### Step 8 (depends: 0): Second";
    const triage = createProductionShapedStore();
    const review = createProductionShapedStore();
    const triageResult = await runTool(createTriagePromptWriteTool(triage.store, TASK_ID), invalid);
    const reviewResult = await runTool(createPlanReviewPromptWriteTool({ store: review.store, getRunContextFor: vi.fn() } as any, TASK_ID), invalid);
    expect(getText(triageResult)).toContain("step 2 depends on invalid step 0 (zero)");
    expect(getText(reviewResult)).toContain("step 2 depends on invalid step 0 (zero)");
    expect(triage.updateTask).not.toHaveBeenCalled();
    expect(review.updateTask).not.toHaveBeenCalled();
  });

  it("confirms Plan Review repair writes through the shared worker registration", async () => {
    const { store, updateTask } = createProductionShapedStore();
    const runContext = { agentId: "review-agent", runId: "run-143" } as RunMutationContext;
    const deps = { store, getRunContextFor: vi.fn().mockReturnValue(runContext) } as any;

    const result = await runTool(createPlanReviewPromptWriteTool(deps, TASK_ID));

    expect(deps.getRunContextFor).toHaveBeenCalledWith(TASK_ID);
    expect(updateTask).toHaveBeenCalledWith(TASK_ID, { prompt: CONTENT }, runContext);
    expect(getText(result)).toBe(`Updated PROMPT.md for ${TASK_ID}.`);
  });

  it("keeps reviewer inline repair wired to the same production prompt-write factory", async () => {
    const reviewerSource = await readFile(new URL("../execution/reviewer.ts", import.meta.url), "utf8");
    const { store } = createProductionShapedStore();

    expect(reviewerSource).toContain("createTaskPromptWriteTool(options.store, options.taskId)");
    expect(getText(await runTool(createTriagePromptWriteTool(store, TASK_ID)))).toBe(`Updated PROMPT.md for ${TASK_ID}.`);
  });

  /*
  FNXC:OriginalDescriptionInPrompt 2026-10-11-10:09:
  The store wraps an unmarked Original Description section, so on every surface the stored PROMPT.md
  can differ from the submitted text. Each surface must confirm against what was stored, and must
  still reject when the artifact on disk is not that content.
  */
  describe("when the store wraps an unmarked Original Description section", () => {
    const planner = "## What This Delivers\n\n- Value.\n\n## Mission\n\nBuild it.\n";
    const operator = "Operator request.\n\n## Mission\n\nOperator prose.";
    const submitted = `# Task\n\n## Original Description\n\n${operator}\n\n${planner}`;
    const stored = `# Task\n\n## Original Description\n\n<!-- fusion-original-description:start -->\n${operator}\n<!-- fusion-original-description:end -->\n\n${planner}`;
    const surfaces: Array<[string, (store: TaskStore) => { execute: (...args: any[]) => Promise<any> }]> = [
      ["triage and replanning", (store) => createTriagePromptWriteTool(store, TASK_ID)],
      ["Plan Review repair", (store) => createPlanReviewPromptWriteTool({ store, getRunContextFor: vi.fn() } as any, TASK_ID)],
    ];
    const wrappingStore = (readBack: string) => {
      const upsertTaskDocument = vi.fn().mockResolvedValue({ key: "plan", content: stored });
      const store = {
        updateTask: vi.fn().mockResolvedValue({ id: TASK_ID, prompt: stored }),
        getTask: vi.fn().mockResolvedValue({ id: TASK_ID, prompt: readBack }),
        getTaskDocument: vi.fn().mockResolvedValue(null),
        upsertTaskDocument,
      } as unknown as TaskStore;
      return { store, upsertTaskDocument };
    };

    it.each(surfaces)("confirms a %s write and mirrors the stored content", async (_surface, createTool) => {
      const { store, upsertTaskDocument } = wrappingStore(stored);

      expect(getText(await runTool(createTool(store), submitted))).toBe(`Updated PROMPT.md for ${TASK_ID}.`);
      expect(upsertTaskDocument).toHaveBeenCalledWith(TASK_ID, expect.objectContaining({ key: "plan", content: stored }));
    });

    it.each(surfaces)("rejects a %s write whose artifact is not the stored content", async (_surface, createTool) => {
      const { store, upsertTaskDocument } = wrappingStore(submitted);

      expect(getText(await runTool(createTool(store), submitted))).toContain("could not be verified");
      expect(upsertTaskDocument).not.toHaveBeenCalled();
    });
  });

  it("never treats a promptless updateTask row as verification evidence", async () => {
    const updateTask = vi.fn().mockResolvedValue({ id: TASK_ID });
    const getTask = vi.fn().mockResolvedValue(null);
    const store = { updateTask, getTask } as unknown as TaskStore;

    const result = await runTool(createTriagePromptWriteTool(store, TASK_ID));

    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(getTask).toHaveBeenCalledTimes(1);
    expect(getText(result)).toContain("could not be verified");
  });
});
