---
title: Spec lock rejects an approved plan forever when Original Description has no markers
date: 2026-10-11
category: logic-errors
module: "@fusion/core (spec lock, approval fingerprint, prompt write), @fusion/engine (Plan Review step)"
tags: [spec-lock, plan-review, original-description, plan-evidence, parser-version, replan-loop]
problem_type: parser_boundary_mismatch
applies_when: "A reader and a writer disagree about a section boundary, or immutable evidence is deduplicated by a hash that does not include the version of the code that computed it."
---

# Spec lock rejects an approved plan forever when Original Description has no markers

## Symptom

A card stays in todo and repeats Plan Review on an unchanged spec. Every run ends
with `Plan approved but spec lock unavailable: section-duplicate (file-scope)`.
Each run is a full AI review session, about one per hour per card, and the card
never reaches execution. Two cards hit this at once: one on ten of eleven review
attempts over three days.

Both specs had a `## Original Description` section without the
`fusion-original-description` start and end markers, and both operator
descriptions quoted a literal `## File Scope` heading. Specs with the same
quoted heading inside a marked section locked without trouble.

## Root cause

Four defects had to line up.

1. **The reader only understood the marker envelope.** The reader used by the
   spec lock and the approval fingerprint returned the prompt unchanged when the
   start marker was absent. The quoted heading was then counted next to the
   planner's own `## File Scope` and reported as a duplicate. The writer already
   handled an unmarked section by aligning the known operator text, so the two
   views of the section boundary had drifted.
2. **One write path stored the section without the envelope.**
   `fn_task_prompt_write` hands the content to `updateTask({ prompt })`, which
   wrote it verbatim. Only triage finalization added the markers. A Plan Review
   inline repair never passes through finalization, and neither does a planning
   session that is interrupted before it. Both stuck specs were last written
   that way.
3. **Stored evidence outlived the parser.** Current-plan evidence is immutable
   and deduplicated by source hash, and the hash covered only the prompt and the
   bindings. An `unavailable` snapshot stored for a prompt would have kept
   answering for that unchanged prompt after the parser was fixed.
4. **Nothing stopped the next review.** After a lock rejection in the hold lane
   the card was neither parked nor rerouted, so the stranded-hold sweep seeded
   Plan Review again on the same plan.

## Fix

- One exported resolver, `resolveOriginalDescriptionSection`, decides the section
  boundary for the writer and for both readers. It distinguishes an absent
  section, a marked region, a start marker with no acceptable end marker, and an
  unmarked section. An unknown operator body (`undefined`) is a separate case
  from a known empty one: the readers end an unmarked section at the
  highest-priority known heading, then the first H2, then the end of the
  document. The readers stay functions of the prompt text alone.
- `updateTask({ prompt })` wraps an existing section in the marker envelope
  before it validates, writes, hashes or returns the content. It does not insert
  a missing section and does not touch seed prompts. The prompt-write tool
  verifies its read-back against the content the store reports it wrote.
- `SPEC_LOCK_PARSER_VERSION` is 2 and is part of the evidence source hash. There
  is no migration: old rows stay, and the next capture for any prompt appends a
  row computed by the current parser.
- The Plan Review step checks the lock before it creates a reviewer. An
  unlockable plan gets a deterministic `REVISE` and no AI session, and returns to
  the planner in place through the normal replan route and its revision budget.

The two stuck specs lock unchanged under the fixed parser. No stored spec was
rewritten.

## Pitfalls

- **Evidence deduplicated by source hash survives a parser fix.** If a hash
  identifies immutable derived data, the version of the code that derives it
  belongs in the hash. Otherwise the fix is correct and has no effect on the
  rows that needed it.
- **A marker-only reader is a second boundary definition.** When a writer
  tolerates a legacy shape, every reader of the same boundary must go through
  the same resolver, or the shapes the writer tolerates become shapes the reader
  misreads.
- **"Unknown" and "empty" are different inputs.** Treating an unknown operator
  body as empty ended an unmarked section at the first H2, which for a bare body
  is the quoted heading itself.
- **A fail-closed read-back must compare against what was stored.** Once the
  store normalizes content, comparing with the submitted bytes rejects every
  normalized write and sends the planner into another pass.
- **Residual, accepted:** with the body unknown, operator text in an unmarked
  section that quotes `## What This Delivers` still ends the section early. The
  preflight returns such a plan to the planner, and the rewrite is stored with
  markers, where the boundary is exact.

## Verification

- `packages/core/src/__tests__/planner/spec-lock.test.ts` builds bare, fenced and
  marked sections that quote every lockable heading and expects the lock of the
  same spec without quoted headings. A real planner duplicate after the section
  is still reported in every shape. The bare and fenced cases fail on the old
  reader.
- `packages/core/src/__tests__/postgres/plan-evidence-version-collision.pg.test.ts`
  seeds a version-1 `unavailable` row for an unchanged prompt and expects
  `lockCurrentPlan` to succeed. It fails with `UnavailablePlanLockError` when the
  parser version is taken out of the hash.
- `packages/core/src/__tests__/postgres/task-update-prompt-return.pg.test.ts`
  covers the stored envelope, idempotence, seed prompts and the
  `original-description` document.
- `packages/engine/src/__tests__/plan-review-spec-lock-preflight.test.ts` shows no
  reviewer session for an unlockable plan on a first and a repeated dispatch,
  and exactly one session for lockable plans and for both stuck shapes.

## Follow-up: a request that mentions the start marker

### Symptom

A planned spec whose operator request mentioned the start-marker comment was
stored with its `## Original Description` section unwrapped, and it stayed that
way. The resolver took the first start marker after the heading for the start of
an envelope, even when that marker was prose. With no end marker after it, the
result was `unresolved-marker`. Hygiene then returned the prompt unchanged, and
the readers kept the whole section in the spec lock and the approval
fingerprint. A single quote of the marker anywhere later in the plan had the
same effect on an otherwise ordinary unmarked section.

### Fix

- **Positional opener.** A start marker opens the envelope only on the first
  non-blank line under the heading, alone on that line (surrounding spaces, tabs
  and a trailing `\r` are allowed). Hygiene always writes the opener there and
  encodes every marker literal inside the body, so a start marker in any other
  position is prose, and the section resolves as unmarked under the existing
  rules. A positional opener is handled exactly as before, including the
  unlisted-successor and truncated-envelope cases, so prompts that hygiene
  wrapped keep their lock and fingerprint hashes.
  `original-description-hash-stability.test.ts` pins those hashes with values
  computed before the change.
- **Writer idempotence requires a real envelope.** `applyOriginalDescription`
  returns its input unchanged only when the resolved section is marked, its own
  body matches the operator text, and the body declares the encoding exactly
  when the text needs it. The old file-wide marker checks would have left an
  unmarked section unwrapped whenever the plan below it quoted both markers.
- **Parser version 3.** `SPEC_LOCK_PARSER_VERSION` is now 3. A stored version-2
  rejection of an unchanged marker-mentioning prompt no longer answers for it.
  Content hashes are unchanged for correctly wrapped prompts, so their active
  locks stay active.

Stored prompts are not backfilled. Such a section is stripped by the readers at
once and wrapped by its next prompt write. Until that write, a recomputed
approval fingerprint differs from the stored one. An audit of the stored
artifacts found one affected prompt (KB-128), and none with the residual shape
below.

### Residual, accepted

An unwrapped legacy section whose operator text begins with the start marker
alone on its first line still reads as a truncated envelope. Every new write
wraps the section, so only a pre-existing stored prompt can have that shape.
