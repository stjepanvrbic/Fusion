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
must share that locator, or additions land where readers never look. When a
section reader must exist for a new heading, add it next to the File Scope
locator and extend the ratchet.

## Pitfalls

- **Generic section readers still read other headings from the request.**
  `Mission`, `Steps`, `Dependencies`, `Do NOT`, `Context to Read First` and
  `Completion Criteria` are still found by the first matching heading anywhere
  in the document.
- **The shared resolver is not fence-aware.** A prompt with no real section that
  shows an Original Description heading inside a fenced sample is read as having
  a region from that line.
- **A request that mentions the start marker cannot be wrapped.** The resolver
  takes the first start-marker occurrence after the heading as an envelope start,
  so hygiene leaves such a section unwrapped. The File Scope locator bounds it
  like an unmarked section, but the spec lock does not strip it.

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
