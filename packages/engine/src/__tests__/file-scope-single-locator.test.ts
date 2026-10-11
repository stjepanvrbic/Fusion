import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/*
FNXC:FileScope 2026-10-11-14:50:
File Scope is located in PROMPT.md by exactly one locator, which skips the Original Description region.
Fourteen private locators, none aware of that region, read a File Scope list quoted in the operator request as the task's scope, rejected valid plans and dropped scope additions.
This ratchet refuses a new private locator: production code outside the allowlist may not spell the heading as a regular expression or pass the heading name as a bare string literal.
Readers and writers use `locateFileScopeSection`, `extractFileScopeSection`, `extractFileScopeSectionWithHeading` or `appendFileScopeEntries` from @fusion/core instead.
*/
const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const SOURCE_ROOTS = ["packages/core/src", "packages/engine/src", "packages/cli/src", "packages/dashboard/src"];
const ALLOWED = new Set([
  "packages/core/src/tasks/file-scope-classification.ts",
  "packages/core/src/tasks/original-description-policy.ts",
]);
const LOCATOR = "packages/core/src/tasks/file-scope-classification.ts";

/** A regular expression that spells the heading: a whitespace class before "File", optionally between the words. */
const HEADING_PATTERN = /\\s[+*]?File(?: |\\s[+*]?)Scope/;
/** The heading name passed as a bare string literal, the shape a generic section reader takes. */
const BARE_LITERAL = /(["'`])File Scope\1/;

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

describe("File Scope has a single locator", () => {
  const files: string[] = [];
  for (const root of SOURCE_ROOTS) collectSourceFiles(join(REPO_ROOT, root), files);
  const matching = files
    .map((file) => ({ file: relative(REPO_ROOT, file).replaceAll("\\", "/"), code: stripComments(readFileSync(file, "utf8")) }))
    .filter(({ code }) => HEADING_PATTERN.test(code) || BARE_LITERAL.test(code))
    .map(({ file }) => file);

  it("scans a non-trivial production source set", () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it("matches the locator itself, so the patterns are live", () => {
    expect(matching).toContain(LOCATOR);
  });

  it("finds no File Scope locator outside the allowlist", () => {
    expect(matching.filter((file) => !ALLOWED.has(file))).toEqual([]);
  });
});
