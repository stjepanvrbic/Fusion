import { createLogger } from "../process/logger.js";
import {
  ORIGINAL_DESCRIPTION_START_MARKER,
  resolveOriginalDescriptionEnd,
  resolveOriginalDescriptionSection,
} from "./original-description-policy.js";

/**
 * FNXC:PlanApproval 2026-07-15-21:30:
 * FN-8008 — Original Description bodies are verbatim, so marker-like text can occur both
 * inside the generated body and later in operator-authored prompt content. The generated
 * closing marker is bounded by the next known PROMPT section (or end of file), preventing a
 * later literal marker from swallowing a real Mission/Steps/File Scope revision.
 *
 * FNXC:SpecLock 2026-09-07-05:09:
 * The spec-lock parser and approval fingerprint share this resolver so operator prose cannot
 * drift their view of planner-authored prompt structure.
 *
 * FNXC:SpecLock 2026-09-09-08:09:
 * FN-9272 derives accepted marker successors from the policy-owned terminator list. This keeps
 * the planner-required What This Delivers section aligned with spec-lock parsing while retaining
 * the known-heading boundary that prevents literal markers in operator prose from swallowing plans.
 */
export function findGeneratedOriginalDescriptionEnd(promptText: string, start: number): number {
  if (start === -1) return -1;
  const result = resolveOriginalDescriptionEnd(
    promptText,
    start + ORIGINAL_DESCRIPTION_START_MARKER.length,
  );
  return result.resolved ? result.end : -1;
}

/**
 * FNXC:SpecLock 2026-10-11-10:00:
 * The spec lock and the approval fingerprint describe the planner-authored plan only, so operator
 * prose under `## Original Description` must never reach them, whichever way the section was
 * stored. An unmarked section (a prompt written without the hygiene envelope) used to pass through
 * untouched: a heading the operator quoted there was counted next to the planner's own and an
 * approved plan could never be locked. The boundary comes from the resolver the writer uses, with
 * the operator body unknown, because both results are persisted hashes of the prompt text alone.
 *
 * Only an ambiguous marker region is reported: a start marker with no acceptable end marker
 * leaves the prompt unchanged, and unresolved takes precedence over skipped candidates. An absent
 * or unmarked section is an ordinary shape and never warns.
 */
export function stripOriginalDescriptionSection(promptText: string): string {
  const section = resolveOriginalDescriptionSection(promptText);
  if (section.kind === "absent") return promptText;
  if (section.kind === "unresolved-marker") {
    createLogger("original-description-region").warn(
      `Generated Original Description start marker has no acceptable end marker; successor heading: ${section.rejectedSuccessorHeading ?? "(no following H2 heading)"}; skipped candidates: ${section.skippedCandidateCount}`,
    );
    return promptText;
  }
  if (section.kind === "marked" && section.skippedCandidateCount > 0) {
    createLogger("original-description-region").warn(
      `Generated Original Description skipped candidates before a resolved end marker: ${section.skippedCandidateCount}`,
    );
  }

  const before = promptText.slice(0, section.sectionStart).trimEnd();
  const after = promptText.slice(section.sectionEnd).replace(/^\n+/, "");
  return after ? `${before}\n\n${after}` : `${before}\n`;
}
