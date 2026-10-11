import { ORIGINAL_DESCRIPTION_END_MARKER, ORIGINAL_DESCRIPTION_HEADING, applyOriginalDescription } from "@fusion/core";

/*
FNXC:FileScopeClassification 2026-10-11-14:50:
Shared fixture for File Scope readers and writers: a planned prompt as the store writes it, whose Original Description quotes a File Scope heading with a backticked decoy path.
Every consumer must read and extend the plan's own section, never the quoted one.
*/

/** Path that only the quoted request lists. */
export const QUOTED_DECOY_PATH = "decoy/quoted-only.ts";

/** Request text ending with a quoted File Scope heading, one backticked decoy bullet and an "Origin:" line. */
export const QUOTED_SCOPE_REQUEST = [
  "The requester explains the defect here.",
  "",
  "## File Scope",
  `- \`${QUOTED_DECOY_PATH}\``,
  "",
  "Origin: an earlier planning session.",
].join("\n");

/**
 * Planned PROMPT.md with the request wrapped in the marker envelope and the given plan File Scope body.
 * `scopeBody` `null` omits the plan's File Scope section entirely.
 */
export function plannedPromptWithQuotedScope(
  scopeBody: string | null = "- `packages/engine/src/real.ts`",
  options: { request?: string; extraSections?: string } = {},
): string {
  const plan = [
    "# Task: KB-1 - Example",
    "",
    "## What This Delivers",
    "",
    "- The plan's scope is read.",
    "",
    "## Mission",
    "",
    "Do the planned work.",
    "",
    ...(scopeBody === null ? [] : ["## File Scope", "", scopeBody, ""]),
    "## Steps",
    "",
    "### Step 1: Work",
    "",
    "- [ ] Do it.",
    "",
    ...(options.extraSections ? [options.extraSections, ""] : []),
  ].join("\n");
  return applyOriginalDescription(plan, options.request ?? QUOTED_SCOPE_REQUEST);
}

/** The Original Description region text (heading through end marker) of a fixture prompt. */
export function originalDescriptionRegionText(prompt: string): string {
  const end = prompt.indexOf(ORIGINAL_DESCRIPTION_END_MARKER) + ORIGINAL_DESCRIPTION_END_MARKER.length;
  return prompt.slice(prompt.indexOf(ORIGINAL_DESCRIPTION_HEADING), end);
}
