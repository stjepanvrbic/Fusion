---
title: File Scope read from a list quoted in the Original Description
date: 2026-10-11
category: logic-errors
module: "@fusion/core (File Scope classification, prompt validation), @fusion/engine (scope tool, remediation widen, merge auto-widen, scope guards, step and review prompts, spec checks), @fusion/dashboard (GitHub tracking dedup)"
tags: [file-scope, original-description, prompt-parsing, squash-invariant, scope-lease, section-boundary]
problem_type: parser_boundary_mismatch
applies_when: "Code locates a structural section of PROMPT.md (File Scope first) in a prompt that also carries the operator's verbatim request, or several modules each locate the same section with their own pattern."
---

# File Scope read from a list quoted in the Original Description

## Symptom

Operator requests often end with a quoted `## File Scope` heading, a path list
and an "Origin:" line. Once planning wraps that request in the Original
Description region, the quoted heading sits above the plan's own File Scope
section, and four things went wrong:

- **Plans could not be saved.** A prompt write was rejected with
  `Invalid File Scope entries in PROMPT.md for <id>: @fusion/core/memory-mcp`,
  a token that appeared only in the request. The store re-inserts the request
  before it validates, so no plan text could avoid it.
- **The scope was wrong.** A stored prompt parsed to the single token
  `commands/mcp-memory-server.js` from the request's "Origin:" line instead of
  the three files the plan listed. The squash invariant then refused the task's
  own files: "staged files [...] have zero overlap with declared File Scope
  [commands/mcp-memory-server.js]".
- **The scope was silently empty.** When the quoted list had no backticks,
  the parsed scope was empty although the plan listed files, so leases, overlap
  blocking, the completion scope-leak check and the squash invariant ran with no
  declared scope. A board scan found 21 stored prompts in this shape.
- **Scope additions vanished.** The scope tool and the review-remediation widen
  inserted under the first heading, inside the region. The store then replaced
  the region body with the verbatim request, so the addition was lost while the
  tool reported success.

## Root cause

Fourteen independent locators found the File Scope section, none aware of the
Original Description region: the core locator, nine engine readers (merge
scope, no-commit eligibility, the remediation scope guard, step and review
prompts, prompt compaction, two spec checks), three engine writers, a core
fallback reader and the dashboard's GitHub tracking dedup. Several also accepted
looser headings (case-insensitive, a trailing colon, a suffix). The spec lock
and the approval fingerprint already stripped the region first; the File Scope
readers had no such boundary.

## Fix

- `locateOriginalDescriptionRegion` returns the region with the boundary the spec
  lock uses (operator body unknown). An unresolved start marker followed by an
  end marker ends just past the first end marker; one with no end marker is
  bounded like an unmarked section.
- `locateFileScopeSection` treats lines inside the region as absent, for heading
  matching and for fence tracking. A region never promotes its content: a plan
  without a File Scope section declares none. Seed prompts have no region, so a
  heading in their operator text keeps its provisional meaning.
- One writer, `appendFileScopeEntries`, serves the scope tool, the remediation
  widen and the merge-time auto-widen, so what a writer adds is what every
  reader returns.
- Every other reader takes the section from the core exports
  (`extractFileScopeSection`, `extractFileScopeSectionWithHeading`) and keeps
  its own line handling. A source ratchet refuses a new private locator.

No stored prompt was rewritten: the parser reads PROMPT.md on every call, so
affected tasks parse correctly as soon as the fixed engine runs. A task whose
merge was refused needs an operator Retry.

## Rule for future section readers

Locate a PROMPT.md section through one shared locator that skips the Original
Description region, never through a private regular expression or a generic
"first heading with this name" reader. A reader and a writer of the same section
must share that locator, or additions land where readers never look. A reader
for a new heading calls `locatePlanSection` / `extractPlanSection` /
`extractPlanSectionWithHeading` from `@fusion/core` with the heading name; it
never spells the heading as a pattern.

## Generalized to every plan section

The File Scope fix left every other plan heading on first-match readers. A
request that quoted `## Mission`, `## Dependencies`, `## Do NOT`,
`## Context to Read First`, `## Completion Criteria` or `## Steps` above the
plan's own section was read as the plan: step sessions received the quoted
rules, reading list and completion criteria, quoted `### Step N:` headings
became stored task steps (a malformed quoted `(depends: …)` annotation threw),
triage stored a quoted `- **Task:**` line as a dependency, the reviewer and
session compaction summarized the quoted Mission, and Plan Review spec checks
judged quoted content. Section writers (frontend UX criteria, Mission rewrite,
review-gate failure and advisory notes) wrote next to a quoted heading, inside
the region, where hygiene discarded the write.

The File Scope algorithm is now the generic primitive in
`packages/core/src/tasks/original-description-region.ts`:
`listPlanHeadings(content)` returns every unfenced level-two heading outside
the region, and `locatePlanSection`, `extractPlanSection` and
`extractPlanSectionWithHeading` take a heading name. Matching is case-sensitive
on whitespace-collapsed text with no trailing-colon or prefix variants; a
section ends at the next unfenced level-one or level-two heading.
`locateFileScopeSection` delegates to it. `matchStepHeadings` drops step
headings inside the region (offsets stay relative to the full prompt), and
every engine and core reader and writer listed above locates through the
primitive. `packages/engine/src/__tests__/plan-section-single-locator.test.ts`
refuses a new private locator: a heading-anchored regular expression, a string
search for a level-two heading, or a heading template, outside a four-file
allowlist (the region-boundary terminators, MEMORY.md, git status porcelain, a
GitHub issue body).

A planning-time scan of all 77 stored prompts (71 with a region) found no
region quoting one of these headings, a step heading or a dependency line, so
no persisted step or dependency list changes and no prompt was rewritten.
`stripOriginalDescriptionSection` and the spec-lock and approval hashes are
unchanged.

## Pitfalls

- **The shared resolver is not fence-aware.** A prompt with no real section that
  shows an Original Description heading inside a fenced sample is read as having
  a region from that line.
- **Only a positional start marker opens the envelope.** A request that mentions
  the start marker anywhere else resolves as an unmarked section, so hygiene can
  wrap it and every plan-section reader bounds it like any unmarked region.

## Verification

- `packages/core/src/__tests__/file-scope-classification.test.ts` runs five
  quoted variants (plain, backticked path, path-like Origin token, package
  specifier, mixed) against marked, unmarked and custom-successor regions, plus
  seed prompts, unbalanced fences, literal markers, CRLF and the append helper.
- `packages/core/src/__tests__/postgres/task-update-prompt-return.pg.test.ts`
  reproduces the three store symptoms against a real store.
- `packages/engine/src/__tests__/file-scope-consumers-original-description.test.ts`
  covers each engine reader; `merger-ai-squash-gates.test.ts` lands the stored
  shape under strict policy; `file-scope-single-locator.test.ts` is the ratchet.
- `packages/core/src/__tests__/original-description-region.test.ts` ("plan
  sections") and `plan-section-consumers.test.ts`, and the engine
  `plan-section-consumers-original-description.test.ts` and
  `review-findings-injection.test.ts`, cover every other plan section;
  `plan-section-single-locator.test.ts` is their ratchet.
