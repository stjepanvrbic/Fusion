---
category: workflow-learnings
module: scripts/check-inert-sync-lane-conversions.mjs
tags: [lifecycle-columns, ratchets, gates, measurement, inert-conversions]
problem_type: process-learning
applies_when: reading a ratchet or census number as evidence that work happened
---

# A falling count is not evidence that anything changed

Sibling to [lifecycle-conversions-that-score-as-wins](./lifecycle-conversions-that-score-as-wins.md),
which records the *shapes* an inert conversion takes and how to tell a claim from a measurement. Its
grammatical tell is the portable one:

> if a claim can be written without running anything, it has not been tested.

This document records the **metric** counterpart, and the instrument failures that let it persist. It
is written from a phase in which the lifecycle-column backlog went 126 → 12, and in which a number
moved without the system moving **four separate times**.

## The tell

**A count that falls is not evidence that anything changed.** Every gate in this program reports a
number, and every number has three ways of going down:

1. work happened
2. the code got denser and the scan stopped matching
3. someone lowered the allowance

Only the first is progress, and from inside the check all three look identical.

| what moved | what actually happened |
|---|---|
| census 12 → 2 in `scheduler.ts` (#3051) | ten guards routed through `resolveTaskWorkflowIrSync`, which answers with the DEFAULT board under PostgreSQL. Byte-identical behaviour. Refuted end-to-end in #3058 |
| census 45 → 44 in `triage.ts` (#3114) | converted the exact arm #3108 had flagged hours earlier, blockers named and a test behind it. #3126 reverted it — three PRs for one line |
| ratchet 20 → 15 | not a conversion: #3065 rewrote `a === x \|\| a === y` as `set.has(a)` and the check counted only comparisons. It printed *"total fell — re-record"*, which would have **permanently retired live guards** |
| ratchet 22 → 9 | `scheduler.ts` reported **0** while 13 guards still fell back to the default board, laundered through `mergeParkedColumns(sync(...), lanes)` |
| census deliberate `done` 3 → 2 and `in-review` 3 → 1 in `self-healing.ts` (KB-119) | no exemption was removed: the census parsed the `.ts` file as TSX, a generic arrow `<T>(run) =>` opened a phantom JSX element, and the parser silently dropped the remaining ~9,500 lines, three marked sites among them. `--strict` printed *"baseline CAN BE TIGHTENED"* and named `--update-baseline` as the next step |

Rows three and four are the dangerous shape: **the gate went quiet exactly when someone improved the
code**, and the remedy it suggested was to lower the allowance.

Row five was added later and is the same shape with a different cause: the scan lost the code
rather than the code outgrowing the scan. The census now picks the parser mode from the file
extension and exits 1 on any parse diagnostic, so a file it could not fully read yields an error
instead of a count.

### The obligation this creates

Before re-recording any baseline, establish *which* of the three causes applies. A drop caused by
denser encoding and a drop caused by a deleted gate are indistinguishable from inside the tool. The
check that works is cheap: dump the surviving hits and read them. Twice, that dump showed the
remaining entries were all in files nobody had touched — which is what a detection loss looks like.

## One defect, four spellings

The inert-lane ratchet was rewritten four times. Each version was correct about the shape in front of
it and blind to a trivially different spelling of the same defect:

```text
#3062  matched a local only        →  resolveX(store, id).review           walked past
#3068  matched comparisons only    →  parked.terminal.has(to)              walked past, and made the count FALL
#3079  matched same-file only      →  a helper imported from another file  walked past
#3181  matched direct assignment   →  wrapper(resolveX(...), lanes)        walked past
```

The lesson is not "write a better regex". It is that **enumerating the syntax that consumes a value
is a losing game**; the durable form keys on the *source* — anything derived from the broken reader —
and treats consumption as opaque. Each of the four fixes was verified by mutation: apply the shape,
confirm exit 1, restore the file. A green ratchet proves nothing about a shape it cannot express.

## An instrument that runs nowhere and one that cannot fail are the same defect

Both report green forever.

- **`check:inert-sync-lanes` was invoked by nothing** for six PRs — not `test:gate`, not any workflow.
  It only ran when a human typed it. The #3108 → #3114 → #3126 round trip happened while it was
  flagging the defect correctly the entire time.
- **`check:quarantine-ledger` was worse.** It ran nowhere *and* omitted `--strict`, and the script
  only exits non-zero with that flag. Wiring it alone would have been theatre. AGENTS.md had stated
  the 14-day deletion policy the whole time.

Both failures are invisible to every normal signal: the script exists, it is documented, it passes
when run by hand. The audit that finds them is mechanical — list every `check:*` script, grep the gate
chain and `.github/workflows/` for each, and check the exit-code path for a `--strict`-style flag the
package script omits.

## Base drift makes branch numbers incomparable

Three false alarms in this phase came from comparing a branch's reported number against a
remembered or differently-based one. One was mine: I "found" a 13-guard drop that was my own stale
figure from an earlier round.

**Branch outputs are not comparable. Scripts on one tree are.** The procedure that works:

```shell
# Extract both versions; neither needs its branch checked out.
git show <branchA>:scripts/<check>.mjs > /tmp/a.mjs
git show <branchB>:scripts/<check>.mjs > /tmp/b.mjs

# Run both against ONE tree. The primary checkout on `main` is the natural choice
# and needs no switching -- `git show` already did the fetching.
node /tmp/a.mjs ; node /tmp/b.mjs

# If a different tree is genuinely required, take a worktree rather than moving
# the primary checkout off `main` (AGENTS.md, Standing Rule: Prefer `main`):
#   wt switch --create <branch>        # or: git worktree add ../wt/<branch> <branch>
```

That is how two competing fixes were shown to be **additive rather than overlapping** (#3169 + #3181
= 22 = 13 + 7 + 2), which decided the merge order and let one collapse into six lines inside the
other.

## A pick-work list nominating decided sites

The census gained a `--triage` split (documented vs unexamined) because the headline number conflated
"deferred on purpose, reason written next to it" with "nobody has looked". At one point 88 guards
were 53-in-a-PR, 13-flagged, 11-fallback-arms and 11 genuinely open.

The split then had its own version of the same bug, twice: its marker set missed phrasings like
`STAYS INLINE`, `honest about being one` and `would be inert`, so a list headed *"this is the list to
pick work from"* reached **100% false positives** — every entry already decided.

That direction of error is the expensive one. Sending a worker at a site whose owner wrote down why it
must not move is precisely the #3108 → #3114 → #3126 sequence. Over-reporting hides real work;
under-reporting manufactures the collision. When in doubt, prefer showing a decided site over hiding
an open one, and make the marker phrases specific to *declining a conversion* rather than generic.

## Measured: what each lifecycle ratchet cannot see (2026-07-31)

The checklist below says to mutate the shape a ratchet claims to catch and confirm it exits non-zero.
Run against all five lifecycle gates on one tree, staging a probe file per form. Two were wrong.

| gate | catches | does NOT catch |
|---|---|---|
| `lifecycle-column-census` | `===` / `!==` comparisons | ~~membership, switch~~ **fixed** — both were invisible while it printed "a new guard cannot land silently". ~~Files directly in a root~~ **fixed**. The file list held 2,654 of 2,865 production files. It skipped the 16 files directly under `packages/dashboard/app/` and the 195 directly under a `plugins/*/src/` directory, and those 211 files held five unmarked column guards while the census printed "BACKLOG ZERO". ~~The example plugins~~ **fixed**. No root covered `plugins/examples/*/src`. Its four source files held three unmarked column guards, all in the CI status example |
| `check-move-target-literals` | direct + backtick destinations | ~~ternary destination~~ **fixed**; still misses a destination bound to a local first. ~~Files directly under `packages/*/app`~~ **fixed**. The file list held 2,502 of 2,518 production files and skipped the 16 files directly under `packages/dashboard/app/`, which held no literal move target. ~~Plugin code~~ **fixed**. The scope had no `plugins` root, so the check opened none of the 351 plugin and example-plugin source files. Two of them call `moveTask`, and neither passes a literal destination |
| `no-legacy-move-targets.test.ts` (Vitest, in the merge gate) | a quoted legacy id as the second argument of `moveTask(...)`, matched by a regular expression over comment-stripped source | ~~22 files under its own roots~~ **fixed**. It built its list from its own pathspecs and listed 2,496 of 2,518 production files. It skipped the 16 files directly under `packages/dashboard/app/` and the 6 `.tsx` files under `packages/*/src/`, which held no literal move target. ~~Plugin code~~ **fixed**, as in the row above. ~~A listed file it could not read~~ **fixed**. It counted the file as empty and still passed. It now fails the scan with an error that names the file |
| `check-sql-column-literals` | `"column"` comparisons, including inside plain template literals — not only drizzle `sql` tags | nothing found; the one miss probed was an invented identifier the schema never uses. ~~Everything after a generic arrow or angle-bracket assertion in a `.ts` file~~ **fixed**. The old parse stopped early in 10 of 2,671 scanned files. The unread parts held no SQL column literal |
| `check-inert-sync-lane-conversions` | lane reads via the `resolvePlannerLanes` helper | a DIRECT `store.resolveTaskWorkflowIrSync(...)` read feeding `resolveLifecycleColumns` — inert by the same mechanism, untracked |
| `check-fnxc-future-dates` | future stamps | nothing found — it caught the author of this table, twice |
| `check-inert-flag-seams` | an optional trailing lane or flag parameter that a production call site omits | ~~everything after a generic arrow or angle-bracket assertion in a `.ts` file~~ **fixed**. The old parse stopped early in 24 of 6,807 files (10 production, 14 test or fixture). The unread parts held 3,014 calls. One was a call to a seam, `isNearDuplicateCanonicalInactive` in `self-healing.ts`, and it supplies its flags |
| `check-plugin-interop-drift` | a mirrored function whose parameter count differs from the real one, and a mirrored interface property the real interface lacks | ~~the same blind spot in a `.ts` dashboard module~~ **fixed**. None of the 12 files it reads was affected when measured |
| `unwired-lane-parameter` (a library that no command runs) | an exported optional lane parameter that no other file mentions | ~~the same blind spot~~ **fixed**. The old parse stopped early in 9 of 2,817 files. The 19 reported parameters did not change |

<!-- FNXC:ScriptAstGates 2026-10-12-05:10: A script AST gate never reports a result for a file it did not fully parse. -->
The last three rows and the struck-through generic-arrow entries were measured on 2026-10-12, not in the 2026-07-31 probe.
Until then these gates parsed every file as TSX. In a `.ts` file, TSX reads a generic arrow `<T>(run) =>` or an angle-bracket assertion `<T>value` as the start of a JSX element. The parser returns a partial tree without raising an error, and the gate reported the file as checked.
`lifecycle-column-census` had the same defect, described in `docs/testing.md`.

Script AST gates parse through `scripts/lib/parse-source-file.mjs`, which picks the parse mode from the file extension and refuses any file with a parse error.
A file with a syntax error fails every gate that scans it, with a message naming the file and line. That includes an untracked scratch file and a deliberately broken fixture under a scanned root.

<!-- FNXC:SourceFileListing 2026-10-12-06:14: A gate's file list holds every file under its roots that has one of its extensions, files directly in a root included, on every platform. -->
The two struck-through "files directly" entries were also measured on 2026-10-12.
Both gates listed their sources with git pathspecs such as `packages/*/app/**/*.tsx`. Git matches a pathspec without glob magic unless told otherwise, so `**/` needs a directory between `app/` and the file, and `app/App.tsx` was never listed. A plain `*` also matches `/`, so `packages/a/b/src` counted as a root.
The pathspecs date from 2026-07-29, so every zero the census printed from 2026-07-31 on was measured over a list without those files. On 2026-10-12 the list omitted 211 files with five column guards in them.

A detection probe cannot find this. A probe checks what the parser does with a file, and the gate never opened these files.
Before trusting a zero, compare the gate's file list with the repository: take every path from an unfiltered `git ls-files`, keep the ones under the gate's roots that have one of its extensions, and check that the gate lists the same set.

Both gates now declare a scope, `{ roots, extensions }`. `listProductionSourceFiles` in `scripts/lib/list-git-source-files.mjs` builds one `:(glob)<root>/**/*<extension>` pathspec per root and extension, which lists direct children and keeps `*` inside one path segment.
`scripts/__tests__/list-git-source-files.test.mjs` makes the comparison above for each gate's scope on every run, so a new root or extension is checked without a new test.

<!-- FNXC:SourceFileListing 2026-10-12-07:05: The two move-target checks read one file list, and both lifecycle scopes cover the two directories that hold plugin code. -->
A second comparison on 2026-10-12 found two more lists that missed files.

The Vitest guard `packages/engine/src/__tests__/no-legacy-move-targets.test.ts` is in the merge gate. It built its own pathspec list, so the lister fix did not reach it, and it listed 2,496 of 2,518 files.
It now calls `listProductionSourceFiles(MOVE_TARGET_SOURCE_SCOPE)`, the list the script check scans. Its case `lists every source file its roots contain` makes the repository comparison on every gate run.

The example plugins are in `plugins/examples/<plugin>/src`, one level deeper than `plugins/*/src`. The earlier pathspecs listed only their test files, because a plain `*` matched `examples/<plugin>` and `**/` needed the `__tests__` directory. Once `*` stayed inside one path segment, no root listed them at all.
The move-target scope had no plugin root.
Both scopes now have the roots `packages/*/src`, `packages/*/app`, `plugins/*/src` and `plugins/examples/*/src`, which held 2,869 production files on that day.

The wider census reported three unmarked column guards, all in `plugins/examples/fusion-plugin-ci-status/src/index.ts`.
The `done` guard became an `onTaskCompleted` hook, which the host fires for the complete lane whatever its id is.
The `in-progress` and `archived` guards were given `DELIBERATE-LITERAL` comments that day, because the plugin SDK had no call that returns a column's role and no hook reports those two lanes.

<!-- FNXC:PluginExamples 2026-10-12-08:27: The example plugin must not compare column ids, so the plugin SDK exports a lane-role lookup and the two marked guards use it. -->
The SDK now exports `taskColumnHasLaneRole`, which asks the Fusion host whether a column carries a lane role for a task. The example asks for the `wip` and `archived` roles, both markers are gone, and the census baseline no longer holds an entry for that file.

A marked guard has to stay an `===` comparison. The census counts a membership test or a `switch` only when the receiver is named `column`, `columnId` or `col`, so it reports nothing for `["done", "archived"].includes(toColumn)`. Rewriting a guard into that shape removes it from the count without converting it.

<!-- FNXC:SourceFileListing 2026-10-12-09:13: A move-target check never reports a count for a listed file it did not read. -->
The lister runs `git ls-files --cached --others`, so a tracked file deleted from the working tree stays on the list until the deletion is staged.
On such a tree the Vitest guard passed, because it treated a file it could not open as empty, while `scripts/check-move-target-literals.mjs` exited 2.
Both checks now fail on that tree and name the file.

### The axis this table did not have

Everything above is **detection**: what each tool can and cannot see. I probed that thoroughly and
then wrote "sound" for two gates on the strength of it.

Within a day, three of these tools turned out to share a different defect entirely — **they wrote to
the tree they were checking**, auto-tightening their own baseline during a plain check run:

| gate | wrote during a check | fixed by |
|---|---|---|
| `check-fnxc-future-dates` | yes | #3287 |
| `lifecycle-column-census` | yes, under `--strict` | #3289 |
| `check-sql-column-literals` | yes | #3292 |

No number of detection probes could have surfaced that. The table asserted one property carefully and
**said nothing about the other while reading as comprehensive** — which is the same failure it
documents in the tools it audits.

What it cost: every worker who ran a gate received a byte-identical uncommitted diff they had not
authored, and reasonably committed it. #3283 and #3285 are the same `+0/-1` five minutes apart, by
two authors, neither of whom wrote that line.

**So audit a tool on at least four axes, not one:**

1. **What can it see?** — probe each spelling of the thing it claims to catch.
2. **Can it fail at all?** — invoke it as `package.json` does; a report-only run exits 0 forever.
3. **Does it write?** — `git status --porcelain` before and after, on a clean tree.
4. **Which files does it open?** Compare its file list with the repository, as the 2026-10-12 note above describes.

A trap for the third: these gates write only when a tightening is *available*, so a clean tree after
a run proves the trigger is absent, not that the tool is read-only. Inflate a baseline entry first,
then run it.

Three tools converged on the same write-during-check design independently, which says the pattern is
attractive rather than that anyone was careless: the tightening is correct, the write saves a step,
and the message even tells you to commit it.

Two lessons the table encodes beyond its rows.

**A ratchet's blind spot is invisible in exactly the way its subject is.** Both fixed gaps sat next to
a printed zero and a sentence promising nothing could land silently. The count was true; the sentence
was true only for the forms the parser happened to visit.

**Probe correctness is its own trap.** The first census probe measured nothing because the scanner
enumerates git-tracked files and the probe was untracked — the scanned-file count stayed flat, which
reads exactly like "no gap". `git add -f` the probe and confirm the scanned count moved. A first
`DELIBERATE-LITERAL` probe also read as a broken escape hatch until the marker was moved to its own
line: mid-expression it attaches to the wrong node, which is the documented gotcha and still caught
the person who had just written it down.

## Checklist

- Before re-recording a baseline: dump the surviving hits and name which of the three causes applies.
- Before trusting a ratchet: mutate the shape it claims to catch and confirm it exits non-zero.
- Before trusting a `check:*` script: confirm something runs it, and that it can fail.
- Before comparing two numbers: confirm they came from one tree.
- Before trusting a zero: confirm the gate's file list holds every file under its roots.
- Before converting a flagged site: read the flag. It is a claim, and it decays — but re-deriving it
  costs minutes and overriding it wrongly has cost three PRs.

## FN-126: 2 → 0 was removed work, not a detection loss

The executor planning-evacuation predicate stopped calling the synchronous workflow resolver. Its
PostgreSQL selection reader measured as the same legacy defaults already beside the predicate, so it
could not serve renamed boards. The listener now uses payload lanes, then the TTL `TaskLaneCache`, then
legacy ids. Before recording the zero baseline, staged `===` and array/filter/`includes` probes each
failed the ratchet; the scanner now also fails if no `resolveTaskWorkflowIrSync` source exists.

The measured blind-spot table's inert-sync row now catches membership receivers containing tainted role
reads. The direct `store.resolveTaskWorkflowIrSync(...)` → `resolveLifecycleColumns` form remains out
of scope here and is separately protected by the core callsite allow-list test.
