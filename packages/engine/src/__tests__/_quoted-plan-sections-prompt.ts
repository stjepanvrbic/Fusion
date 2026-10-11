import { applyOriginalDescription } from "@fusion/core";

/*
FNXC:PlanSections 2026-10-11-17:08:
Shared fixture for plan-section readers: a planned prompt as the store writes it, whose Original Description quotes Mission, Dependencies, Do NOT, Context to Read First, Completion Criteria, Git Commit Convention, Review Level and Steps headings with unique decoy content.
Every consumer must read the plan's own sections and step headings, never the quoted ones.
*/

/** Quoted Mission: coordination-only wording, an integration keyword with a download verb, and a no-source-change statement. */
export const DECOY_MISSION = "DECOY-MISSION: record the routing handoff for the owner and probe the cloudflared tunnel. Do not edit product source.";
export const DECOY_DEPENDENCY = "KB-999";
export const DECOY_DO_NOT = "DECOY-DO-NOT: never touch the parser.";
export const DECOY_CONTEXT_PATH = ".fusion/tasks/KB-1/decoy-notes.md";
export const DECOY_COMPLETION = "DECOY-COMPLETION: decoy criterion met.";
export const DECOY_GIT = "DECOY-GIT: commit as decoy.";
export const DECOY_STEP = "Decoy step";
export const DECOY_STEP_PATH = "packages/decoy/step.ts";
export const DECOY_STRINGS = [
  DECOY_MISSION,
  DECOY_DEPENDENCY,
  DECOY_DO_NOT,
  DECOY_CONTEXT_PATH,
  DECOY_COMPLETION,
  DECOY_GIT,
  DECOY_STEP,
  DECOY_STEP_PATH,
] as const;

export const PLAN_MISSION = "PLAN-MISSION: implement the parser fix in the engine.";
export const PLAN_DEPENDENCY = "KB-100";
export const PLAN_DO_NOT = "PLAN-DO-NOT: skip tests.";
export const PLAN_CONTEXT_PATH = "packages/engine/src/real-context.ts";
export const PLAN_COMPLETION = "PLAN-COMPLETION: parser fixed.";
export const PLAN_GIT = "PLAN-GIT: commit as fix(KB-1).";
export const PLAN_STEP_PATHS = ["packages/engine/src/preflight.ts", "packages/engine/src/real.ts"] as const;

export const QUOTED_PLAN_SECTIONS_REQUEST = [
  "The requester pasted an older plan.",
  "",
  "## Mission",
  "",
  DECOY_MISSION,
  "",
  "## Dependencies",
  "",
  `- **Task:** ${DECOY_DEPENDENCY} (decoy)`,
  "",
  "## Do NOT",
  "",
  `- ${DECOY_DO_NOT}`,
  "",
  "## Context to Read First",
  "",
  `- \`${DECOY_CONTEXT_PATH}\``,
  "",
  "## Completion Criteria",
  "",
  `- [ ] ${DECOY_COMPLETION}`,
  "",
  "## Git Commit Convention",
  "",
  `- ${DECOY_GIT}`,
  "",
  "## Review Level: 1 (Plan Only)",
  "",
  "## Steps",
  "",
  `### Step 0: ${DECOY_STEP}`,
  "",
  `- \`${DECOY_STEP_PATH}\``,
].join("\n");

export interface QuotedPlanSectionsOptions {
  mission?: string;
  scope?: string;
  reviewLevel?: string;
  /** Extra lines appended to the plan's last step body. */
  stepExtra?: string;
  /** Extra sections appended after the plan. */
  extraSections?: string;
}

/** Planned PROMPT.md with the quoting request wrapped in the marker envelope and a plan carrying real versions of each section. */
export function plannedPromptWithQuotedSections(options: QuotedPlanSectionsOptions = {}): string {
  const plan = [
    "# Task: KB-1 - Example",
    "",
    "**Created:** 2026-10-11",
    "",
    "## What This Delivers",
    "",
    "- The plan is read.",
    "",
    `## Review Level: ${options.reviewLevel ?? "2 (Plan and Code)"}`,
    "",
    "## Mission",
    "",
    options.mission ?? PLAN_MISSION,
    "",
    "## Dependencies",
    "",
    `- **Task:** ${PLAN_DEPENDENCY} (real)`,
    "",
    "## Context to Read First",
    "",
    `- \`${PLAN_CONTEXT_PATH}\``,
    "",
    "## File Scope",
    "",
    `- \`${options.scope ?? "packages/engine/src/real.ts"}\``,
    "",
    "## Steps",
    "",
    "### Step 0: Preflight",
    "",
    `- \`${PLAN_STEP_PATHS[0]}\``,
    "",
    "### Step 1: Implement",
    "",
    `- \`${PLAN_STEP_PATHS[1]}\``,
    ...(options.stepExtra ? [options.stepExtra] : []),
    "",
    "## Completion Criteria",
    "",
    `- [ ] ${PLAN_COMPLETION}`,
    "",
    "## Git Commit Convention",
    "",
    `- ${PLAN_GIT}`,
    "",
    "## Do NOT",
    "",
    `- ${PLAN_DO_NOT}`,
    "",
    ...(options.extraSections ? [options.extraSections, ""] : []),
  ].join("\n");
  return applyOriginalDescription(plan, QUOTED_PLAN_SECTIONS_REQUEST);
}
