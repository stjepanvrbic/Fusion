import { createLogger } from "../process/logger.js";
import {
  ORIGINAL_DESCRIPTION_END_MARKER,
  ORIGINAL_DESCRIPTION_START_MARKER,
  findUnmarkedSectionTerminatorOffset,
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

/**
 * FNXC:FileScopeClassification 2026-10-11-14:50:
 * Operator text under `## Original Description` is the request, never the plan, so section readers that locate plan structure (File Scope first) must not see it.
 * Requests routinely end with a quoted `## File Scope` list; reading it made plan writes impossible, gave a task a wrong or empty declared scope, and sent scope additions into text that hygiene rewrites away.
 * The boundary is the one `stripOriginalDescriptionSection` uses (operator body unknown), so a reader and the spec lock agree on what is plan.
 *
 * An unresolved marker has two shapes.
 * When an end marker follows the start marker, the region ends just past the first one: hygiene encodes marker literals inside the body, so the first end marker closes every region the store wrote, even when a custom plan heading follows it.
 *
 * FNXC:FileScopeClassification 2026-10-11-16:55:
 * An unresolved marker is always a positional opener, because the resolver reads a start marker anywhere else as prose and resolves the section as unmarked.
 * With no end marker after it, the opener belongs to a truncated envelope; the region is bounded like an unmarked section with the body unknown.
 *
 * Returns `null` when the prompt has no Original Description heading: a seed prompt keeps its operator text as provisional plan content.
 * Never logs, because scope readers run on every scheduler pass.
 */
export function locateOriginalDescriptionRegion(promptText: string): { start: number; end: number } | null {
  const section = resolveOriginalDescriptionSection(promptText);
  if (section.kind === "absent") return null;
  if (section.kind === "marked" || section.kind === "unmarked") {
    return { start: section.sectionStart, end: section.sectionEnd };
  }

  const endMarker = promptText.indexOf(ORIGINAL_DESCRIPTION_END_MARKER, section.bodyStart);
  if (endMarker !== -1) {
    return { start: section.sectionStart, end: endMarker + ORIGINAL_DESCRIPTION_END_MARKER.length };
  }

  const headingEnd = promptText.indexOf("\n", section.sectionStart);
  const headerEnd = headingEnd === -1 ? promptText.length : headingEnd;
  const terminatorOffset = findUnmarkedSectionTerminatorOffset(promptText.slice(headerEnd));
  return {
    start: section.sectionStart,
    end: terminatorOffset === -1 ? promptText.length : headerEnd + terminatorOffset,
  };
}

/** A level-two plan heading located outside the Original Description region. */
export interface PlanHeading {
  /** Heading text after `## `, trimmed (a CRLF `\r` is stripped). */
  text: string;
  /** Offset of the heading line. */
  headingStart: number;
  /** Offset just past the heading line. */
  sectionStart: number;
  /** Offset of the next unfenced level-one or level-two heading, the region start, or the end of the content. */
  sectionEnd: number;
}

const PLAN_HEADING_LINE = /^##\s+(.*?)\s*$/;
const SECTION_TERMINATOR_LINE = /^#{1,2}\s/;
const FENCE_LINE = /^```/;

function normalizeHeadingText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * FNXC:PlanSections 2026-10-11-17:08:
 * Operator text under `## Original Description` is the request, never the plan, for every plan heading, not only File Scope.
 * A request that quoted `## Mission`, `## Dependencies`, `## Steps` or `## Do NOT` above the plan's own section used to win a first-match search, so executors read quoted rules and steps, triage stored quoted dependencies, and section writers put notes inside the region where hygiene replaced them with the verbatim request.
 * Every reader and writer that locates a plan section goes through this one scan, so they cannot disagree about which section is the plan's.
 *
 * Grammar: a heading is an unfenced `## <text>` line with non-empty text; matching is case-sensitive and compares text with whitespace runs collapsed, with no trailing-colon or prefix variants.
 * Lines inside the region do not exist for the scan: they never match a heading and never toggle the fence state, so an unbalanced fence in operator text cannot hide a plan section.
 * A section ends at the next unfenced level-one or level-two heading (fresh fence state after the heading) and is clamped to the region start when the region begins inside it.
 * A region never promotes its content: a planned prompt whose plan lacks a section has none, even when the request quotes one.
 * Seed prompts (bootstrap stub, refinement seed, a specified prompt that copies the request) have no Original Description heading, so their quoted headings stay provisional plan content.
 * Never logs, because section readers run on every scheduler pass.
 */
export function listPlanHeadings(content: string): PlanHeading[] {
  const region = locateOriginalDescriptionRegion(content);
  const lines = content.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    lineStarts.push(offset);
    offset += (lines[i] ?? "").length + (i < lines.length - 1 ? 1 : 0);
  }
  const lineEnd = (i: number): number => (i + 1 < lines.length ? lineStarts[i + 1]! : content.length);

  const headings: PlanHeading[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineStart = lineStarts[i]!;
    if (region && lineStart >= region.start && lineStart < region.end) continue;
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const text = PLAN_HEADING_LINE.exec(line)?.[1];
    if (!text) continue;

    const sectionStart = lineEnd(i);
    let sectionEnd = content.length;
    let scanInFence = false;
    for (let j = i + 1; j < lines.length; j++) {
      const scanLine = lines[j] ?? "";
      if (FENCE_LINE.test(scanLine)) {
        scanInFence = !scanInFence;
        continue;
      }
      if (!scanInFence && SECTION_TERMINATOR_LINE.test(scanLine)) {
        sectionEnd = lineStarts[j]!;
        break;
      }
    }
    if (region && region.start >= sectionStart && region.start < sectionEnd) sectionEnd = region.start;

    headings.push({ text, headingStart: lineStart, sectionStart, sectionEnd });
  }
  return headings;
}

/** The first plan section titled `name` (see `listPlanHeadings`), or `null` when the plan has none. */
export function locatePlanSection(
  content: string,
  name: string,
): { headingStart: number; sectionStart: number; sectionEnd: number } | null {
  const wanted = normalizeHeadingText(name);
  const heading = listPlanHeadings(content).find((entry) => normalizeHeadingText(entry.text) === wanted);
  return heading ? { headingStart: heading.headingStart, sectionStart: heading.sectionStart, sectionEnd: heading.sectionEnd } : null;
}

/** Body of the plan section titled `name` (heading line excluded, untrimmed), or `null` when the plan has none. */
export function extractPlanSection(content: string, name: string): string | null {
  const located = locatePlanSection(content, name);
  return located ? content.slice(located.sectionStart, located.sectionEnd) : null;
}

/**
 * The plan section titled `name` including its heading line, trimmed, or `""` when the plan has none.
 * For readers that quote the section into another prompt (step prompts, review summaries, spec checks).
 */
export function extractPlanSectionWithHeading(content: string, name: string): string {
  const located = locatePlanSection(content, name);
  return located ? content.slice(located.headingStart, located.sectionEnd).trim() : "";
}
