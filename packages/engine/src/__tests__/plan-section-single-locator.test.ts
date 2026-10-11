import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/*
FNXC:PlanSections 2026-10-11-17:08:
PROMPT.md plan sections are located by exactly one locator (`listPlanHeadings` / `locatePlanSection` / `extractPlanSection` / `extractPlanSectionWithHeading` from @fusion/core), which skips the Original Description region.
Private first-match locators read Mission, Dependencies, Do NOT, Context to Read First, Completion Criteria and Steps sections quoted in the operator request as the plan, and section writers put review notes inside the region where hygiene discarded them.
This ratchet refuses a new private locator in production source: a regular expression anchored on a level-two heading name, a string search for a level-two heading, or a heading template built for a search.
Constant heading strings used only for writing are fine when the core locator does the searching.
*/
const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const SOURCE_ROOTS = ["packages/core/src", "packages/engine/src", "packages/cli/src", "packages/dashboard/src"];
const ALLOWED: ReadonlyMap<string, string> = new Map([
  ["packages/core/src/tasks/original-description-policy.ts", "defines the Original Description region boundary (known-section terminators) that the locator itself depends on"],
  ["packages/core/src/memory/memory-insights.ts", "reads MEMORY.md sections, not PROMPT.md"],
  ["packages/cli/src/commands/dashboard.ts", "parses the git status porcelain branch header"],
  ["packages/dashboard/src/github.ts", "reads a GitHub issue body"],
]);

const PATTERNS = {
  /** `^##` then a whitespace class (one or two backslashes), a literal space or `[ \t]`, then a heading name or interpolation. */
  headingAnchor: /\^##(?:\\{1,2}s[+*]?| |\[ \\t\][+*]?)(?:[A-Z]|\$\{)/,
  /** A whitespace class after `\n##` or at a regular expression start `/##`, then a heading name or interpolation. */
  whitespaceClassHeading: /(?:\\n|\/)##\\{1,2}s[+*]?(?:[A-Z]|\$\{)/,
  /** A string search whose literal argument is a level-two heading, optionally after `\n`. */
  stringSearch: /\.(?:indexOf|lastIndexOf|includes|startsWith|search|split)\(\s*(["'`])(?:\\n)?## (?:[A-Z]|\$\{)/,
  /** A heading template assigned to a variable, the first half of an `indexOf(heading)` locator. */
  headingTemplate: /=\s*`## \$\{/,
} as const;

/** Samples of the private locators this change removed; each pattern must keep catching its shape. */
const REMOVED_LOCATOR_SAMPLES: Record<keyof typeof PATTERNS, readonly string[]> = {
  headingAnchor: [
    'const regex = new RegExp(`^## ${escapeRegex(sectionName)}\\s*$`, "m");',
    String.raw`const headingMatch = content.match(/^##\s+Dependencies\s*$/m);`,
    String.raw`const heading = content.match(/^##\s+Declared\s+Symbols\s*$/m);`,
    'const match = prompt.match(new RegExp(`^##\\\\s+${escapedHeading}\\\\s*$([\\\\s\\\\S]*?)`, "im"));',
    String.raw`return /^##\s+Review Level:\s*1\b[^\n]*\bPlan Only\b/im.test(prompt);`,
  ],
  whitespaceClassHeading: [
    String.raw`const acceptanceCriteriaMatch = content.match(/\n##\s+Acceptance Criteria\n/);`,
    String.raw`const reviewMatch = prompt.match(/##\s*Review Level[:\s]*(\d)/);`,
  ],
  stringSearch: [
    'if (promptMarkdown.includes("## Frontend UX Criteria")) {',
    'const start = prompt.indexOf("\\n## Mission");',
  ],
  headingTemplate: [
    "const heading = `## ${sectionName}`;",
  ],
};

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

function collectSourceFiles(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith("__") || entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
      continue;
    }
    if (/\.test\.tsx?$/.test(entry)) continue;
    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
}

function matchesAnyPattern(line: string): boolean {
  return Object.values(PATTERNS).some((pattern) => pattern.test(line));
}

describe("PROMPT.md plan sections have a single locator", () => {
  const files: string[] = [];
  for (const root of SOURCE_ROOTS) collectSourceFiles(join(REPO_ROOT, root), files);
  const matching = [
    ...new Set(
      files
        .map((file) => ({ file: relative(REPO_ROOT, file).replaceAll("\\", "/"), code: stripComments(readFileSync(file, "utf8")) }))
        .filter(({ code }) => code.split("\n").some(matchesAnyPattern))
        .map(({ file }) => file),
    ),
  ];

  it("scans a non-trivial production source set", () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it.each(Object.keys(PATTERNS) as (keyof typeof PATTERNS)[])("the %s pattern catches the removed locator shapes", (name) => {
    for (const sample of REMOVED_LOCATOR_SAMPLES[name]) expect(PATTERNS[name].test(sample)).toBe(true);
  });

  it("still matches every allowlisted file, so no entry is stale", () => {
    expect([...ALLOWED.keys()].filter((file) => !matching.includes(file))).toEqual([]);
  });

  it("finds no plan-section locator outside the allowlist", () => {
    expect(matching.filter((file) => !ALLOWED.has(file))).toEqual([]);
  });
});
