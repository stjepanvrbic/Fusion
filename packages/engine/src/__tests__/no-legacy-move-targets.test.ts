// @vitest-environment node

/*
FNXC:WorkflowResolvedColumns 2026-07-31-23:59:
A MOVE TARGET IS AN ARGUMENT, SO NO EXISTING GATE COUNTS IT.

The lifecycle-column census counts COMPARISONS against legacy ids. `moveTask(task.id, "todo")` contains
no comparison, so the census reported zero while 25 such targets sat in `self-healing.ts` alone and 31
across the tree.

The failure mode is worse than a stale guard's. `moveTaskInternal` REJECTS a target the workflow does
not declare — `TransitionRejectionError: unknown-column` — which `task-store/moves.ts` documents after
a completion handoff was found THROWING on every renamed board. A guard that fails to match degrades to
"no rescue"; a target that throws is "no rescue, plus an exception in the sweep", and every one of these
sites is a recovery path.

So this ratchet exists because the population was invisible, not because it was large. Fixing it once
without a guard means it is invisible again the moment someone adds the next one.

WHAT IS AND IS NOT A TARGET. Only the SECOND argument of a `moveTask(...)` call counts. A legacy id as
a FALLBACK (`resolveReboundTargetForTask` returning `"todo"`, or `lifecycle?.complete ?? "done"`) is
the degraded answer every resolver in this program is required to have, and is not flagged — the
resolver is what makes the call correct, and its fallback is what keeps default boards working.

BASELINE, NOT ZERO. Files outside the converted set keep their current counts so this can land without
blocking other lanes; the ratchet fails on any INCREASE, and on a decrease that was not re-recorded —
a stale allowance is a hole the same guards can regrow through.
*/

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MOVE_TARGET_SOURCE_SCOPE } from "../../../../scripts/check-move-target-literals.mjs";
import { listProductionSourceFiles } from "../../../../scripts/lib/list-git-source-files.mjs";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../../..");

/** Legacy lifecycle column ids, as move TARGETS. */
const LEGACY = "(?:todo|triage|in-progress|in-review|done|archived)";
const MOVE_TARGET = new RegExp(`moveTask\\s*\\(\\s*[^,()]+,\\s*["']${LEGACY}["']`, "g");

/*
Files that still hold literal targets, with the count each is allowed.

EMPTY, and that is the end state rather than a starting one: every `moveTask` call in the tree now
resolves its target. It was populated when this guard was written — `cli/src/extension.ts`,
`core/task-store/branch-and-pr-entities.ts`, `dashboard/src/server.ts` and `engine/agent-tools.ts`
each held one — and the stale-allowance case below is what forced this map to be emptied when those
four were converted in the same change. Leaving the entries behind would have left four slots open
for the class to regrow through while the guard stayed green.

A NOTE FOR WHOEVER ADDS ONE. If a call genuinely cannot resolve its target, record it here with a
comment saying why, rather than widening the matcher. The failure this guards is not "a literal
appears" — it is `TransitionRejectionError: unknown-column` thrown at runtime on a renamed board.
*/
const ALLOWED: Record<string, number> = {};

// FNXC:WorkflowResolvedColumns 2026-10-12-07:05:
// This guard and the script check `scripts/check-move-target-literals.mjs` must scan the same files: every non-test `.ts` and `.tsx` file under each root of the move-target scope, files directly in a root included.
// A pathspec list written in this file once had no entry for `.tsx` under `packages/*/src` and required a directory between `app/` and the file, so the guard passed while it never opened 22 files, `packages/dashboard/app/App.tsx` among them.
// The scope and the lister are imported from the script check, so a root added there is scanned here without an edit to this file.
// The lister resolves its pathspecs against `cwd`, which must be the repository root. The list is computed once per run because the tree cannot change during it.
// (Line comments, because the globs quoted here contain the block-comment terminator.)
let sourceFilesCache: string[] | undefined;
function sourceFiles(): string[] {
  sourceFilesCache ??= listProductionSourceFiles(MOVE_TARGET_SOURCE_SCOPE, { cwd: REPO_ROOT }) as string[];
  return sourceFilesCache;
}

/*
FNXC:WorkflowResolvedColumns 2026-10-12-07:05:
The files the guard must list, computed without git pathspec matching and without the lister or its test-file predicate, so a wrong pathspec or a wrong filter in either cannot make both sides of the comparison agree.
A file counts when its leading path segments match a scope root (`*` stands for exactly one segment and at least one segment follows the root), its name ends with a scope extension, and it is not a test file.
*/
function isUnderRoot(file: string, root: string): boolean {
  const rootSegments = root.split("/");
  const fileSegments = file.split("/");
  return fileSegments.length > rootSegments.length
    && rootSegments.every((segment, index) => segment === "*" || segment === fileSegments[index]);
}

const TEST_FILE_SUFFIXES = [".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx"];

function repositoryFilesInScope(): string[] {
  const { roots, extensions } = MOVE_TARGET_SOURCE_SCOPE as { roots: readonly string[]; extensions: readonly string[] };
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((file) => file.length > 0)
    .filter((file) => roots.some((root) => isUnderRoot(file, root)))
    .filter((file) => extensions.some((extension) => file.endsWith(extension)))
    .filter((file) => !file.includes("__tests__") && !TEST_FILE_SUFFIXES.some((suffix) => file.endsWith(suffix)));
}

/** Blank comments in place so prose describing a past call is not counted as one. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

/*
FNXC:WorkflowResolvedColumns 2026-08-05-00:02 (gate cost):
SHARED comment-stripped read cache. countByFile() already memoised its scan, but the anti-vacuity
case ("scans a real corpus") re-read the ENTIRE corpus a second time with its own readFileSync loop
to find moveTask( callers — measured ~270ms of a second full pass over the same unchanging tree. Both
consumers want the same comment-stripped source, so read+strip each file once and share it.
*/
const strippedSourceCache = new Map<string, string>();
function strippedSource(file: string): string {
  const cached = strippedSourceCache.get(file);
  if (cached !== undefined) return cached;
  let stripped: string;
  try {
    stripped = stripComments(readFileSync(resolve(REPO_ROOT, file), "utf8"));
  } catch {
    stripped = "";
  }
  strippedSourceCache.set(file, stripped);
  return stripped;
}

/*
FNXC:WorkflowResolvedColumns 2026-07-31-23:59:
MEMOISED for gate admission. Each case called this independently and every call re-read the whole
corpus, so the scan ran five times for one tree: measured 660ms of the suite's 800ms. The tree cannot
change mid-run, so the repeat reads bought nothing.

This matters because the gate's admission bar is about cost and determinism, and a guard that is
gratuitously slow is a guard someone eventually moves back out of the gate.
*/
let countsCache: Record<string, number> | undefined;

function countByFile(): Record<string, number> {
  if (countsCache) return countsCache;
  const counts: Record<string, number> = {};
  for (const file of sourceFiles()) {
    const hits = strippedSource(file).match(MOVE_TARGET);
    if (hits && hits.length > 0) counts[file] = hits.length;
  }
  countsCache = counts;
  return counts;
}

describe("moveTask targets resolve the board's own lane", () => {
  /*
  ANTI-VACUITY, and its first version was self-defeating: it asserted the scan finds at least one
  offender, which can only hold while the defect exists. Converting the last four sites turned it red
  — the guard failing precisely because the tree became correct.

  A clean tree is the expected end state, so the proof has to be that the scan REACHES the right code
  rather than that it finds something wrong in it. Two independent legs, both of which break if the
  glob stops resolving or `moveTask` is renamed: the corpus is a real file list, and files that
  genuinely call `moveTask` are inside it. The matcher itself is covered by the case table below.
  */
  it("scans a real corpus that still reaches the moveTask call sites", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(200);

    const callers = files.filter((file) => /moveTask\s*\(/.test(strippedSource(file)));
    expect(callers.length).toBeGreaterThan(5);
    expect(callers).toContain("packages/engine/src/self-healing.ts");
    /* A plugin calls moveTask too, so the corpus has to reach plugin code. */
    expect(callers).toContain("plugins/fusion-plugin-even-realities-glasses/src/agent-actions.ts");
  });

  it("lists every source file its roots contain", () => {
    const expected = repositoryFilesInScope().sort();
    const listed = [...sourceFiles()].sort();

    /* Two files the earlier pathspecs skipped: a direct child of an `app` root and a `.tsx` file under a `src` root. They also prove the expected set is the real population. */
    expect(expected).toContain("packages/dashboard/app/App.tsx");
    expect(expected).toContain("packages/cli/src/commands/dashboard-tui/app.tsx");

    const listedSet = new Set(listed);
    const expectedSet = new Set(expected);
    const omitted = expected.filter((file) => !listedSet.has(file));
    const unexpected = listed.filter((file) => !expectedSet.has(file));
    expect(
      { omitted, unexpected },
      `The guard scans ${listed.length} file(s) and its roots contain ${expected.length}.\n`
      + `Under the roots but not scanned (${omitted.length}):\n${omitted.join("\n")}\n`
      + `Scanned but outside the roots (${unexpected.length}):\n${unexpected.join("\n")}`,
    ).toEqual({ omitted: [], unexpected: [] });
    expect(listed.length).toBe(expected.length);
  });

  /* The matcher is covered, because the scan is only as good as it: each case is a real shape. */
  it.each<[source: string, shouldFlag: boolean, why: string]>([
    ['await store.moveTask(task.id, "todo");', true, "the plain form"],
    ['await this.store.moveTask(taskId, "archived", { moveSource: "engine" });', true, "with options"],
    ["await store.moveTask(id, 'done');", true, "single quotes"],
    ['await store.moveTask(task.id, await resolveReboundTargetForTask(store, task.id));', false, "resolved"],
    ['await store.moveTask(task.id, completeLane);', false, "resolved via a local"],
    ['const target = lifecycle?.complete ?? "done";', false, "a FALLBACK is not a target"],
    ['return resolveReboundTarget(ir) ?? "todo";', false, "a resolver's own degraded answer"],
    ['if (task.column === "todo") return;', false, "a comparison — the census owns that class"],
  ])("matcher: %s -> %s (%s)", (source, shouldFlag) => {
    expect(new RegExp(MOVE_TARGET.source).test(source)).toBe(shouldFlag);
  });

  it("self-healing.ts has NO literal move targets", () => {
    /* The file this ratchet was written for: 25 sites, now zero. Asserted by name because a
       regression here is a recovery path that throws on a renamed board. */
    expect(countByFile()["packages/engine/src/self-healing.ts"] ?? 0).toBe(0);
  });

  it("no file exceeds its recorded allowance", () => {
    const counts = countByFile();
    const violations: string[] = [];
    for (const [file, count] of Object.entries(counts)) {
      const allowed = ALLOWED[file] ?? 0;
      if (count > allowed) violations.push(`${file}: ${count} literal move target(s), allowed ${allowed}`);
    }
    expect(
      violations,
      "A moveTask target the workflow does not declare is REJECTED (TransitionRejectionError: "
      + "unknown-column), so this throws on a renamed board rather than degrading.\n"
      + "Resolve the target (resolveReboundTargetForTask / resolveArchiveTargetForTask /\n"
      + "resolveTaskLifecycleColumns) — a legacy id is fine as the resolver's FALLBACK, not as the "
      + "argument:\n" + violations.join("\n"),
    ).toEqual([]);
  });

  it("no allowance is stale", () => {
    /* A recorded allowance that exceeds the tree is a hole the same targets can regrow through —
       the same reason the census baseline fails on an unrecorded DROP. */
    const counts = countByFile();
    const stale = Object.entries(ALLOWED)
      .filter(([file, allowed]) => (counts[file] ?? 0) < allowed)
      .map(([file, allowed]) => `${file}: allows ${allowed}, tree has ${counts[file] ?? 0}`);
    expect(stale, `Lower the allowance to match the tree:\n${stale.join("\n")}`).toEqual([]);
  });
});
