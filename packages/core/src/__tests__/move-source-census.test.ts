/*
FNXC:LifecycleContainment 2026-10-07-21:40:
Lifecycle containment judges automatic moves, so it must know who made each move. An absent moveSource is ambiguous between
an internal engine move and an operator surface, which is why the direction policy still exempts it. This census is the
ratchet toward treating an absent source as "engine": every production `.moveTask(` call names its source, either inline
or through the options object it passes. The remaining unattributed calls are listed exactly, with the reason each is still
open, so a new omission fails here and a fixed site must be removed from the list. When the list is empty, the absent
source can be flipped in resolveDirectionPolicySource.
*/
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..", "..");
const SOURCE_ROOTS = ["packages", "plugins"];
const SKIPPED_DIRECTORIES = new Set(["__tests__", "__test-utils__", "dist", "node_modules", "e2e", "stories", ".storybook"]);

/** Unattributed calls owned by the in-flight recovery-ownership change, which names each of these sources. */
const PENDING_RECOVERY_OWNERSHIP: Readonly<Record<string, number>> = {
  "packages/engine/src/executor/run-implementation.ts": 13,
  "packages/engine/src/executor/create-task-done-tool.ts": 3,
  "packages/engine/src/executor/non-continuable-session.ts": 2,
  "packages/engine/src/executor/task-done-refusal-handler.ts": 1,
  "packages/engine/src/executor/route-reset-parse-pin-mismatch.ts": 1,
  "packages/engine/src/executor/dep-abort-cleanup.ts": 1,
  "packages/engine/src/executor/bootstrap-misbinding-recovery.ts": 1,
  "packages/engine/src/self-healing.ts": 1,
  "packages/engine/src/runtimes/in-process-runtime.ts": 1,
  // Spreads its caller's options; the seam's callers must name the source.
  "packages/engine/src/execution/lifecycle-move.ts": 1,
};

/**
 * Automatic moves the direction policy would refuse once their source is named. Each needs a containment decision (stay
 * in the current role, or a registered revision reason) before it can say "engine".
 */
const PENDING_CONTAINMENT_DECISION: Readonly<Record<string, number>> = {
  // Automatic triage routing lands cards in the default board's intake-role lane (rule F1).
  "packages/dashboard/src/triage-trait.ts": 3,
  // The merge-conflict bounce sends a review card to WIP; containment keeps merge-failure repair in review.
  "packages/engine/src/project-engine.ts": 1,
  // The mission retry returns a failed WIP card to the hold lane (rule F5).
  "packages/engine/src/missions/mission-autopilot.ts": 1,
  // Abandoned-lease recovery rebounds a WIP card to the hold lane (rule F5).
  "packages/engine/src/project/mesh-lease-manager.ts": 1,
  // Agent-requested column routing of an existing canonical task may step it backward.
  "packages/engine/src/agent-tools.ts": 1,
};

/** Calls that are not TaskStore moves. */
const NOT_A_STORE_MOVE: Readonly<Record<string, number>> = {
  // `deps.moveTask(toColumn, ctx)`: the injected mover in workflow-column-boundary-hooks.ts names "engine".
  "packages/engine/src/workflows/workflow-column-boundary.ts": 1,
};

function productionFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...productionFiles(path));
    else if (/\.(ts|tsx|mts)$/.test(entry) && !/\.(test|spec|stories)\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) files.push(path);
  }
  return files;
}

/** Blank out comments while keeping every offset, so call windows and declarations line up with the source. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`])\/\/.*$/gm, (match, lead: string) => lead + " ".repeat(match.length - lead.length));
}

/** End offset of the balanced group opened at `open`, skipping string literals. */
function closingIndex(source: string, open: number): number {
  const opener = source[open]!;
  const closer = opener === "(" ? ")" : "}";
  let depth = 0;
  let quote: string | undefined;
  for (let index = open; index < source.length; index++) {
    const char = source[index]!;
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === opener) depth++;
    else if (char === closer && --depth === 0) return index;
  }
  return source.length - 1;
}

/** Top-level comma-separated arguments of the call whose `(` is at `open`. */
function callArguments(source: string, open: number): string[] {
  const end = closingIndex(source, open);
  const args: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = open + 1;
  for (let index = open + 1; index < end; index++) {
    const char = source[index]!;
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "(" || char === "{" || char === "[") depth++;
    else if (char === ")" || char === "}" || char === "]") depth--;
    else if (char === "," && depth === 0) {
      args.push(source.slice(start, index));
      start = index + 1;
    }
  }
  const last = source.slice(start, end);
  if (last.trim()) args.push(last);
  return args;
}

/** True when the options argument names a moveSource inline or through the object literal its identifier was declared as. */
function namesMoveSource(source: string, callStart: number, options: string | undefined): boolean {
  if (options === undefined) return false;
  if (/\bmoveSource\s*:/.test(options)) return true;
  const identifier = options.trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(identifier)) return false;
  const declaration = new RegExp(`\\b(?:const|let)\\s+${identifier}\\b[^=;]*=\\s*\\{`, "g");
  let literalOpen = -1;
  for (const match of source.slice(0, callStart).matchAll(declaration)) literalOpen = (match.index ?? 0) + match[0].length - 1;
  if (literalOpen < 0) return false;
  return /\bmoveSource\s*:/.test(source.slice(literalOpen, closingIndex(source, literalOpen) + 1));
}

function unattributedMoveCalls(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const sourceRoot of SOURCE_ROOTS) {
    for (const pkg of readdirSync(join(ROOT, sourceRoot))) {
      const srcDirectory = join(ROOT, sourceRoot, pkg, "src");
      try {
        if (!statSync(srcDirectory).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const file of productionFiles(srcDirectory)) {
        const source = stripComments(readFileSync(file, "utf8"));
        let cursor = 0;
        while ((cursor = source.indexOf(".moveTask(", cursor)) >= 0) {
          const open = cursor + ".moveTask".length;
          const args = callArguments(source, open);
          if (!namesMoveSource(source, cursor, args[2])) {
            const key = relative(ROOT, file).split(sep).join("/");
            counts[key] = (counts[key] ?? 0) + 1;
          }
          cursor = open;
        }
      }
    }
  }
  return counts;
}

describe("moveTask source census", () => {
  it("every production moveTask call names its source except the listed open sites", () => {
    expect(unattributedMoveCalls()).toEqual({
      ...PENDING_RECOVERY_OWNERSHIP,
      ...PENDING_CONTAINMENT_DECISION,
      ...NOT_A_STORE_MOVE,
    });
  });

  it("recognizes an inline source, an options identifier, and an omission", () => {
    const sample = stripComments([
      "const moveOptions = { preserveProgress: true, moveSource: \"engine\" as const };",
      "await store.moveTask(id, column, moveOptions);",
      "await store.moveTask(id, column, { moveSource: \"operator\" });",
      "// await store.moveTask(id, column, { moveSource: \"user\" });",
      "await store.moveTask(id, column);",
    ].join("\n"));
    const verdicts: boolean[] = [];
    let cursor = 0;
    while ((cursor = sample.indexOf(".moveTask(", cursor)) >= 0) {
      const open = cursor + ".moveTask".length;
      verdicts.push(namesMoveSource(sample, cursor, callArguments(sample, open)[2]));
      cursor = open;
    }
    expect(verdicts).toEqual([true, true, false]);
  });
});
