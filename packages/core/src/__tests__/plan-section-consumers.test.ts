import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskStore } from "../store.js";
import { parseDependenciesFromPromptImpl, parseStepsFromPromptImpl } from "../task-store/task-artifacts-ops.js";
import { rewriteMissionSection } from "../task-store/comments.js";
import { FRONTEND_UX_CRITERIA_SECTION, applyFrontendUxCriteria } from "../tasks/frontend-ux-policy.js";
import { applyOriginalDescription } from "../tasks/original-description-policy.js";
import { extractPlanSection, locateOriginalDescriptionRegion } from "../tasks/original-description-region.js";
import { getStepParser, parseStepHeadings } from "../tasks/step-parsers.js";
import { extractDeclaredSymbolsFromPrompt } from "../tasks/task-symbol-resolution.js";
import { classifyReviewArtifactTask } from "../types/task/documents-artifacts.js";

/*
FNXC:PlanSections 2026-10-11-17:08:
A request that quotes plan headings (steps, dependencies, symbols, frontend criteria, Mission) must not change a planned task's step list, dependency edges, declared symbols or review-artifact class, and section writers must leave the quoted request byte-identical.
Seed prompts keep reading their quoted headings.
*/

const QUOTED_STEPS = ["## Steps", "", "### Step 0: Decoy step", "", "- [ ] decoy", "", "### Step 1 (depends: 9): Broken", ""];

function request(steps: readonly string[] = QUOTED_STEPS): string {
  return [
    "The requester pasted an older plan.",
    "",
    "## Mission",
    "",
    "DECOY mission.",
    "",
    "## Dependencies",
    "",
    "- **Task:** KB-999 (decoy)",
    "",
    ...steps,
    "## Declared Symbols",
    "",
    "- `decoy.ts#Decoy`",
    "",
    "## Frontend UX Criteria",
    "",
    "- [ ] decoy criterion",
  ].join("\n");
}

function plan(options: { dependencies?: boolean; steps?: string[]; scope?: string } = {}): string {
  return [
    "# Task: KB-1 - Example",
    "",
    "## What This Delivers",
    "",
    "- Value.",
    "",
    "## Mission",
    "",
    "Do the planned work.",
    "",
    ...(options.dependencies === false ? [] : ["## Dependencies", "", "- **Task:** KB-100 (real)", ""]),
    "## Declared Symbols",
    "",
    "- `packages/core/src/real.ts#realSymbol`",
    "",
    "## File Scope",
    "",
    `- \`${options.scope ?? "packages/engine/src/real.ts"}\``,
    "",
    "## Steps",
    "",
    ...(options.steps ?? ["### Step 0: Preflight", "", "- [ ] check", "", "### Step 1: Implement", "", "- [ ] build", ""]),
    "## Completion Criteria",
    "",
    "- [ ] Works",
    "",
  ].join("\n");
}

const planned = (options?: Parameters<typeof plan>[0], quoted = request()): string => applyOriginalDescription(plan(options), quoted);
const regionText = (prompt: string): string => {
  const region = locateOriginalDescriptionRegion(prompt)!;
  return prompt.slice(region.start, region.end);
};

describe("step list", () => {
  it("parses only the plan's step headings, never a quoted (or malformed quoted) one", () => {
    const prompt = planned();
    expect(prompt).toContain("### Step 1 (depends: 9): Broken");
    expect(parseStepHeadings(prompt).map((step) => step.name)).toEqual(["Preflight", "Implement"]);
    expect(getStepParser("step-headings")!.parse(prompt).steps.map((step) => step.name)).toEqual(["Preflight", "Implement"]);
  });

  it("still reads a seed prompt's quoted steps", () => {
    const seedSteps = ["## Steps", "", "### Step 0: Decoy step", "", "- [ ] decoy", ""];
    const seed = `# Task: KB-1 - Example\n\n${request(seedSteps)}\n`;
    expect(parseStepHeadings(seed).map((step) => step.name)).toEqual(["Decoy step"]);
  });

  it("reads plain step headings only from the plan's Steps section", () => {
    const prompt = planned(
      { steps: ["### Preflight", "", "- [ ] check", "", "### Implementation", "", "- [ ] build", ""] },
      request(["## Steps", "", "### Decoy", "", "- [ ] decoy", ""]),
    );
    expect(parseStepHeadings(prompt).map((step) => step.name)).toEqual(["Preflight", "Implementation"]);
  });
});

describe("store prompt parsers", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function storeFor(prompt: string): Promise<TaskStore> {
    dir = await mkdtemp(join(tmpdir(), "kb136-plan-sections-"));
    await writeFile(join(dir, "PROMPT.md"), prompt, "utf-8");
    const taskDir = dir;
    return { taskDir: () => taskDir } as unknown as TaskStore;
  }

  it("returns the plan's dependencies and steps", async () => {
    const store = await storeFor(planned());
    expect(await parseDependenciesFromPromptImpl(store, "KB-1")).toEqual(["KB-100"]);
    expect((await parseStepsFromPromptImpl(store, "KB-1")).map((step) => step.name)).toEqual(["Preflight", "Implement"]);
  });

  it("returns no dependencies when only the request quotes a Dependencies section", async () => {
    const store = await storeFor(planned({ dependencies: false }));
    expect(await parseDependenciesFromPromptImpl(store, "KB-1")).toEqual([]);
  });
});

describe("declared symbols and review-artifact class", () => {
  it("reads declared symbols from the plan only", () => {
    expect(extractDeclaredSymbolsFromPrompt(planned())).toEqual(["packages/core/src/real.ts#realSymbol"]);
  });

  it("classifies by the plan's Frontend UX Criteria section only", () => {
    const prompt = planned();
    expect(classifyReviewArtifactTask(prompt)).toBe("backend");
    expect(classifyReviewArtifactTask(applyFrontendUxCriteria(planned({ scope: "packages/dashboard/app/components/Real.tsx" })))).toBe("user-facing");
  });
});

describe("section writers", () => {
  it("inserts frontend criteria after the plan's Mission, despite a quoted criteria section", () => {
    const prompt = planned({ scope: "packages/dashboard/app/components/Real.tsx" });
    const result = applyFrontendUxCriteria(prompt);
    const inserted = result.indexOf(FRONTEND_UX_CRITERIA_SECTION);

    expect(inserted).toBeGreaterThan(result.lastIndexOf("## Mission"));
    expect(result.indexOf(FRONTEND_UX_CRITERIA_SECTION, inserted + 1)).toBe(-1);
    expect(regionText(result)).toBe(regionText(prompt));
    expect(result.slice(0, inserted)).toBe(`${prompt.slice(0, prompt.indexOf("## Dependencies\n\n- **Task:** KB-100")).trimEnd()}\n\n`);
    expect(applyFrontendUxCriteria(result)).toBe(result);
  });

  it("rewrites the plan's Mission and leaves the quoted one untouched", () => {
    const prompt = planned();
    const result = rewriteMissionSection(prompt, "New mission.");

    expect(regionText(result)).toBe(regionText(prompt));
    expect(extractPlanSection(result, "Mission")).toBe("\nNew mission.\n\n");
    expect(result).toContain("DECOY mission.");
  });

  it("rewrites a region-free Mission with one blank line around the new body", () => {
    expect(rewriteMissionSection("# T\n\n## Mission\n\nOld.\n\n## Steps\n", "New.")).toBe("# T\n\n## Mission\n\nNew.\n\n## Steps\n");
    expect(rewriteMissionSection("# T\n\n## Mission\nOld.\n", "New.")).toBe("# T\n\n## Mission\n\nNew.\n");
    expect(rewriteMissionSection("# T\n\n## Steps\n", "New.")).toBe("# T\n\n## Steps\n");
  });
});
