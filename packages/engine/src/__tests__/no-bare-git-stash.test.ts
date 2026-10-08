import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSourceFile,
  forEachChild,
  isArrayLiteralExpression,
  isNoSubstitutionTemplateLiteral,
  isStringLiteral,
  isTemplateExpression,
  ScriptTarget,
  type Node,
  type SourceFile,
} from "typescript";
import { getExecutorSystemPrompt } from "../executor/system-prompt.js";

/*
FNXC:WorktreeStashIsolation 2026-10-08-08:29:
Code-construct ratchet for the KB-008 incident. Git keeps one stash reflog per repository, shared by the primary checkout and every linked worktree, so any position-based stash operation races every other session.
Engine and CLI production code must address stash entries by SHA via `src/merge/tagged-stash.ts`.

Only code constructs are inspected — string literals, template literal text, and array literals whose first element is "stash" (or "git","stash"). Comments are never inspected.
Rules:
  R1 any `stash pop` (no allowlist).
  R2 bare `git stash` (implicit push), `stash save`, or `stash push` without `-m`/`--message`.
  R3 `stash apply|drop|show` with a literal positional `stash@{` argument, `stash apply|drop` with no argument, or `rev-parse stash@{`.
  R4 `stash drop` with a computed ref outside `src/merge/tagged-stash.ts` (the only SHA-verified drop).
Hyphen/colon vocabulary tokens (`stash-pull-pop`, `stash:pop`, `stash-ff-restore`) are not commands and never match.
*/

type Violation = { file: string; line: number; rule: "R1" | "R2" | "R3" | "R4"; text: string };

const DROP_OWNER = "src/merge/tagged-stash.ts";
/** Placeholder for computed (non-literal) values so rules can tell "argument present" from "no argument". */
const EXPR = "${expr}";
/** A command ends at end-of-text, a shell separator, a closing paren, a newline, or a quote. A markdown backtick is prose, not an end. */
const END = String.raw`(?=\s*$|\s*[;&|)\n"'])`;

const TEXT_RULES: Array<{ rule: Violation["rule"]; test: (text: string) => boolean }> = [
  { rule: "R1", test: (t) => /\bstash\s+pop\b/.test(t) },
  { rule: "R2", test: (t) => new RegExp(String.raw`\bgit\s+stash(?:${END}|\s+-)`).test(t) },
  { rule: "R2", test: (t) => /\bstash\s+save\b/.test(t) },
  {
    rule: "R2",
    test: (t) => [...t.matchAll(/\bstash\s+push\b([^;&|\n]*)/g)].some((m) => !/(?:^|\s)(?:-m|--message)(?:\s|=|$)/.test(m[1] ?? "")),
  },
  { rule: "R3", test: (t) => /\bstash\s+(?:apply|drop|show)\s+(?:-\S+\s+)*stash@\{/.test(t) },
  { rule: "R3", test: (t) => new RegExp(String.raw`\bstash\s+(?:apply|drop)${END}`).test(t) },
  { rule: "R3", test: (t) => /\brev-parse\b[^;&|\n]*stash@\{/.test(t) },
  // A bare positional ref constant (array argument or fallback value) is a position-based address.
  { rule: "R3", test: (t) => /^stash@\{\d+\}$/.test(t.trim()) },
];

function lineOf(sourceFile: SourceFile, node: Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function literalText(node: Node): string | undefined {
  if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function checkArray(tokens: string[]): Array<Violation["rule"]> {
  const start = tokens[0] === "stash" ? 0 : tokens[0] === "git" && tokens[1] === "stash" ? 1 : -1;
  if (start < 0) return [];
  const [sub, ...rest] = tokens.slice(start + 1);
  const rules: Array<Violation["rule"]> = [];
  if (sub === undefined || (sub.startsWith("-") && sub !== EXPR)) rules.push("R2");
  if (sub === "pop") rules.push("R1");
  if (sub === "save") rules.push("R2");
  if (sub === "push" && !rest.some((a) => a === "-m" || a === "--message" || a.startsWith("--message="))) rules.push("R2");
  if (sub === "apply" || sub === "drop" || sub === "show") {
    if (rest.some((a) => a.startsWith("stash@{"))) rules.push("R3");
    if ((sub === "apply" || sub === "drop") && rest.length === 0) rules.push("R3");
  }
  return rules;
}

/** Scan one source file's code constructs. Exported shape is exercised by the self-tests below. */
function scanSource(file: string, source: string): Violation[] {
  const sourceFile = createSourceFile(file, source, ScriptTarget.Latest, true);
  const violations: Violation[] = [];
  const push = (node: Node, rule: Violation["rule"], text: string) => {
    violations.push({ file, line: lineOf(sourceFile, node), rule, text: text.replace(/\s+/g, " ").trim().slice(0, 160) });
  };
  const checkText = (node: Node, text: string) => {
    for (const { rule, test } of TEXT_RULES) if (test(text)) push(node, rule, text);
    if (file !== DROP_OWNER && /\bstash\s+drop\s+\$\{/.test(text)) push(node, "R4", text);
  };

  const visit = (node: Node): void => {
    const text = literalText(node);
    if (text !== undefined) {
      checkText(node, text);
    } else if (isTemplateExpression(node)) {
      checkText(node, [node.head.text, ...node.templateSpans.map((span) => `${EXPR}${span.literal.text}`)].join(""));
    } else if (isArrayLiteralExpression(node)) {
      const tokens = node.elements.map((element) => literalText(element) ?? EXPR);
      const rules = checkArray(tokens);
      const startsWithStash = tokens[0] === "stash" || (tokens[0] === "git" && tokens[1] === "stash");
      if (startsWithStash && tokens[tokens.indexOf("stash") + 1] === "drop" && file !== DROP_OWNER) rules.push("R4");
      for (const rule of rules) push(node, rule, `[${tokens.join(", ")}]`);
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

function listProductionSource(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return ["__tests__", "__test-utils__", "node_modules", "dist"].includes(entry.name) ? [] : listProductionSource(path);
    }
    return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") && !/\.(test|spec)\.ts$/.test(entry.name) ? [path] : [];
  });
}

function scanPackage(packageRoot: string): Violation[] {
  const src = join(packageRoot, "src");
  // Keys are POSIX-relative to the package root so `src/merge/tagged-stash.ts` matches on win32 too.
  return listProductionSource(src).flatMap((path) => scanSource(relative(packageRoot, path).split(sep).join("/"), readFileSync(path, "utf-8")));
}

const format = (v: Violation[]): string[] => v.map((x) => `${x.file}:${x.line}: ${x.rule} ${x.text}`);

describe("no bare / position-based git stash (KB-008)", () => {
  describe("scanner self-tests", () => {
    const rulesOf = (source: string, file = "src/example.ts") => scanSource(file, source).map((v) => v.rule);

    it("R1 flags any stash pop", () => {
      expect(rulesOf(`await git(["stash", "pop"], cwd);`)).toContain("R1");
      expect(rulesOf(`await runGit(cwd, ["stash", "pop", ref]);`)).toContain("R1");
      expect(rulesOf("execAsync(`git stash pop ${ref}`);")).toContain("R1");
      expect(rulesOf(`execAsync("git stash pop");`)).toContain("R1");
    });

    it("R2 flags bare git stash, stash save, and unlabelled stash push", () => {
      expect(rulesOf(`execAsync("git stash");`)).toContain("R2");
      expect(rulesOf(`execAsync("git stash -u");`)).toContain("R2");
      expect(rulesOf(`execAsync("git stash save wip");`)).toContain("R2");
      expect(rulesOf(`git(["stash", "push", "--include-untracked"], cwd);`)).toContain("R2");
      expect(rulesOf(`execAsync("git stash push --include-untracked && git pull");`)).toContain("R2");
    });

    it("R3 flags positional refs and argument-less apply/drop", () => {
      expect(rulesOf(`git(["rev-parse", "stash@{0}"], cwd);`)).toContain("R3");
      expect(rulesOf(`execAsync("git stash apply stash@{1}");`)).toContain("R3");
      expect(rulesOf(`git(["stash", "drop", "stash@{0}"], cwd);`)).toContain("R3");
      expect(rulesOf(`execAsync("git stash apply");`)).toContain("R3");
      expect(rulesOf(`git(["stash", "drop"], cwd);`)).toContain("R3");
      expect(rulesOf(`return match?.[1] ?? "stash@{0}";`)).toContain("R3");
    });

    it("R4 flags a computed stash drop outside the tagged-stash helper only", () => {
      expect(rulesOf(`runner(cwd, ["stash", "drop", ref]);`)).toContain("R4");
      expect(rulesOf("execAsync(`git stash drop ${ref}`);")).toContain("R4");
      expect(rulesOf(`runner(cwd, ["stash", "drop", ref]);`, DROP_OWNER)).toEqual([]);
    });

    it("accepts the SHA-addressed forms, vocabulary tokens, prose, and comments", () => {
      const accepted = [
        `git(["stash", "push", "-m", label], cwd);`,
        `git(["stash", "push", ...(u ? ["--include-untracked"] : []), "-m", label], cwd);`,
        "execAsync(`git stash apply ${sha}`);",
        `git(["stash", "apply", sha], cwd);`,
        `execAsync("git stash create");`,
        "execAsync(`git stash store -m ${quote(label)} ${sha}`);",
        "execAsync(`git stash show -p ${sha}`);",
        `execAsync('git stash list --format="%H %gd"');`,
        `const kind = "stash-pull-pop"; const audit = "stash:pop"; const sync = "stash-ff-restore";`,
        "const prose = `Do NOT run \\`git add\\` or \\`git stash drop\\`.`;",
        "const rule = `**Never use \\`git stash\\`** in a task worktree`;",
        `const set = new Set(["apply", "stash", "tag"]);`,
        `// Recover with git stash pop, or stash@{0}\n/* git stash drop ${"${ref}"} */ const x = 1;`,
      ];
      for (const source of accepted) expect(rulesOf(source), source).toEqual([]);
    });
  });

  it("finds no violations in packages/engine/src or packages/cli/src production code", () => {
    const engineRoot = process.cwd();
    const cliRoot = join(engineRoot, "..", "cli");
    const violations = [...scanPackage(engineRoot), ...scanPackage(cliRoot)];
    expect(format(violations)).toEqual([]);
  });

  it("the tagged-stash helper is scanned and its push carries a label", () => {
    const helper = scanPackage(process.cwd()).filter((v) => v.file === DROP_OWNER);
    expect(helper).toEqual([]);
    expect(listProductionSource(join(process.cwd(), "src")).some((p) => p.split(sep).join("/").endsWith(DROP_OWNER))).toBe(true);
  });

  it("the executor system prompt forbids git stash in task worktrees", () => {
    const prompt = getExecutorSystemPrompt({} as never);
    expect(prompt).toContain("**Never use `git stash`** (push/pop/apply/drop) in a task worktree");
    expect(prompt).toContain("make a temporary WIP commit on your task branch");
  });
});
