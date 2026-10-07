import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isStringLiteral,
  isTemplateExpression,
  ScriptTarget,
  type Node,
} from "typescript";

/*
FNXC:WindowsShell 2026-10-07-19:23:
On Windows `exec` runs cmd.exe, which passes POSIX single quotes literally, has no `VAR=value cmd` prefix, cannot open `/dev/null`, and strips `^`.
A production engine file that builds such a command string must route it through the POSIX-shell seam (`bindPosixShell`, `withPosixShell`, `execPosix`, `resolvePosixShell`) or pass git an argv array instead.
This is a code-construct ratchet, file-granular: it inspects string and template literal text and POSIX-quoting helper calls inside templates, never comments.
The allowlist names files whose POSIX text never reaches cmd.exe; it may only shrink.
*/

const ENGINE_SRC = join(__dirname, "..");
const SEAM_BINDINGS = /\b(bindPosixShell|withPosixShell|execPosix|resolvePosixShell)\b/;
const POSIX_ONLY_TEXT: Array<[string, RegExp]> = [
  ["/dev/null redirection", /2>\s*\/dev\/null/],
  ["inline env assignment", /(^|\s)GIT_[A-Z_]+=\S/],
  ["single-quoted --format", /--format='/],
  ["single-quoted --grep", /--grep='/],
  ["single-quoted branch glob", /--list\s+'/],
  ["git pipeline", /\|\s*git\s/],
];
const POSIX_QUOTING_HELPERS = new Set(["shellQuote", "quoteShellArg", "quoteGitArg"]);

const allowlist: Record<string, string> = {
  "worktree/worktree-hooks.ts": "hook script bodies are executed by git's own shell, never by exec",
};

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...productionFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function posixConstructs(source: string, file: string): string[] {
  const found = new Set<string>();
  const sf = createSourceFile(file, source, ScriptTarget.Latest, true);
  const checkText = (text: string) => {
    for (const [label, pattern] of POSIX_ONLY_TEXT) if (pattern.test(text)) found.add(label);
  };
  const visit = (node: Node, inTemplate: boolean): void => {
    if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) checkText(node.text);
    if (isTemplateExpression(node)) {
      checkText([node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" "));
      forEachChild(node, (child) => visit(child, true));
      return;
    }
    if (inTemplate && isCallExpression(node) && isIdentifier(node.expression) && POSIX_QUOTING_HELPERS.has(node.expression.text)) {
      found.add(`${node.expression.text}() inside a command template`);
    }
    forEachChild(node, (child) => visit(child, inTemplate));
  };
  visit(sf, false);
  return [...found].sort();
}

describe("engine POSIX shell syntax is seam-bound", () => {
  const files = productionFiles(ENGINE_SRC).map((full) => ({
    rel: relative(ENGINE_SRC, full).split(sep).join("/"),
    source: readFileSync(full, "utf-8"),
  }));

  it("every file that builds POSIX-only command text binds the POSIX-shell seam", () => {
    const violations = files
      .filter(({ rel }) => !(rel in allowlist))
      .map(({ rel, source }) => ({ rel, constructs: posixConstructs(source, rel), bound: SEAM_BINDINGS.test(source) }))
      .filter(({ constructs, bound }) => constructs.length > 0 && !bound)
      .map(({ rel, constructs }) => `${rel}: ${constructs.join(", ")}`);
    expect(violations).toEqual([]);
  });

  it("allowlisted files still exist and still need their exemption", () => {
    const stale = Object.keys(allowlist).filter((rel) => {
      const file = files.find((candidate) => candidate.rel === rel);
      return !file || posixConstructs(file.source, rel).length === 0;
    });
    expect(stale).toEqual([]);
  });

  it("detects the constructs it guards", () => {
    const sample = [
      "const a = `git merge-base \"${b}\" HEAD 2>/dev/null`;",
      "const c = \"GIT_EDITOR=true git rebase --continue\";",
      "const d = \"git branch --list 'fusion/*'\";",
      "const e = `git rev-parse --verify ${shellQuote(ref)}`;",
      "// 2>/dev/null in a comment is ignored",
    ].join("\n");
    expect(posixConstructs(sample, "sample.ts")).toEqual([
      "/dev/null redirection",
      "inline env assignment",
      "shellQuote() inside a command template",
      "single-quoted branch glob",
    ]);
  });
});
