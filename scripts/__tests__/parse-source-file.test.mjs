import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

import { SourceParseError, parseSourceFileStrict, scriptKindForFile } from "../lib/parse-source-file.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PARSER_URL = pathToFileURL(resolve(REPO, "scripts/lib/parse-source-file.mjs")).href;

/* Valid TypeScript that opens a phantom JSX element when the file is parsed as TSX. */
const GENERIC_ARROW = "const underLock = <T>(run: () => Promise<T>): Promise<T> => run();\n";
const ANGLE_ASSERTION = "declare const raw: unknown;\nconst n = <number>raw;\n";
const DECLARATION = [
  "export function isThing(task: { column: string }, reviewColumns?: ReadonlySet<string>): boolean {",
  '  return reviewColumns ? reviewColumns.has(task.column) : task.column === "in-review";',
  "}",
  "",
].join("\n");
const BROKEN = "export function )( {\nexport const x = 1;\n";

function declaresFunction(sourceFile, name) {
  let found = false;
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = true;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function runInChild(body) {
  const code = `import { failClosedOnParseError, parseSourceFileStrict } from ${JSON.stringify(PARSER_URL)};\n${body}`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: REPO, encoding: "utf8" });
}

test("the parse mode follows the file extension", () => {
  const expected = {
    "a.ts": ts.ScriptKind.TS,
    "a.tsx": ts.ScriptKind.TSX,
    "a.jsx": ts.ScriptKind.JSX,
    "a.mjs": ts.ScriptKind.JS,
    "a.cjs": ts.ScriptKind.JS,
    "a.js": ts.ScriptKind.JS,
    "a.d.ts": ts.ScriptKind.TS,
    "a.mts": ts.ScriptKind.TS,
    "a.cts": ts.ScriptKind.TS,
    noextension: ts.ScriptKind.TS,
  };
  for (const [file, kind] of Object.entries(expected)) {
    assert.equal(scriptKindForFile(file), kind, file);
  }
});

test("a .ts file keeps every construct after a generic arrow function", () => {
  const sourceFile = parseSourceFileStrict("probe.ts", GENERIC_ARROW + DECLARATION);
  assert.equal(declaresFunction(sourceFile, "isThing"), true);
});

test("the same source under a .tsx name is refused, which is why the extension decides", () => {
  assert.throws(() => parseSourceFileStrict("probe.tsx", GENERIC_ARROW + DECLARATION), SourceParseError);
});

test("a .ts file keeps every construct after an angle-bracket type assertion", () => {
  const sourceFile = parseSourceFileStrict("probe.ts", ANGLE_ASSERTION + DECLARATION);
  assert.equal(declaresFunction(sourceFile, "isThing"), true);
});

test("a .tsx file with real JSX still parses as TSX", () => {
  const sourceFile = parseSourceFileStrict("probe.tsx", `export const el = <div>{1}</div>;\n${DECLARATION}`);
  assert.equal(declaresFunction(sourceFile, "isThing"), true);
});

test("a file with a syntax error is refused with its name and line", () => {
  assert.throws(
    () => parseSourceFileStrict("packages/x/src/broken.ts", BROKEN),
    (error) => {
      assert.ok(error instanceof SourceParseError);
      assert.equal(error.name, "SourceParseError");
      assert.equal(error.file, "packages/x/src/broken.ts");
      assert.equal(error.line, 1);
      assert.ok(error.diagnosticCount > 0);
      assert.equal(typeof error.detail, "string");
      assert.ok(error.message.includes("packages/x/src/broken.ts:1:"), error.message);
      assert.ok(error.message.includes("not inspected"), error.message);
      return true;
    },
  );
});

test("empty source parses", () => {
  const sourceFile = parseSourceFileStrict("empty.ts", "");
  assert.equal(sourceFile.statements.length, 0);
});

test("an entry point that meets an unparseable file exits 1 with a readable message and no stack trace", () => {
  const result = runInChild(
    `failClosedOnParseError("probe", () => parseSourceFileStrict("packages/x/src/broken.ts", ${JSON.stringify(BROKEN)}));`,
  );
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes("[probe] packages/x/src/broken.ts:1:"), result.stderr);
  assert.ok(result.stderr.includes("not inspected"), result.stderr);
  assert.equal(result.stderr.split("\n").some((line) => line.startsWith("    at ")), false, result.stderr);
  assert.equal(result.stdout, "");
});

test("an entry point leaves every other error untouched", () => {
  const result = runInChild('failClosedOnParseError("probe", () => { throw new Error("boom"); });');
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("boom"), result.stderr);
  assert.equal(result.stderr.includes("not inspected"), false, result.stderr);
});

test("an entry point that parses cleanly returns its result and exits 0", () => {
  const result = runInChild(
    'const value = failClosedOnParseError("probe", () => 7);\nif (value !== 7) process.exit(3);',
  );
  assert.equal(result.status, 0, result.stderr);
});

/** Repository scripts, outside the script tests, that call the TypeScript parser themselves. */
function scriptsCallingTheParserDirectly() {
  const callers = [];
  const testsDirectory = resolve(REPO, "scripts", "__tests__");
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (full !== testsDirectory && entry.name !== "node_modules") walk(full);
        continue;
      }
      if (![".mjs", ".cjs", ".js"].some((extension) => entry.name.endsWith(extension))) continue;
      const file = relative(REPO, full).split("\\").join("/");
      let callsParser = false;
      const visit = (node) => {
        if (ts.isCallExpression(node)) {
          const callee = node.expression;
          const name = ts.isIdentifier(callee) ? callee.text
            : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
          if (name === "createSourceFile") callsParser = true;
        }
        ts.forEachChild(node, visit);
      };
      visit(parseSourceFileStrict(file, readFileSync(full, "utf8")));
      if (callsParser) callers.push(file);
    }
  };
  walk(resolve(REPO, "scripts"));
  return callers.sort();
}

test("no script outside the known set calls the TypeScript parser directly", () => {
  const known = [
    "scripts/check-inert-sync-lane-conversions.mjs",
    "scripts/check-move-target-literals.mjs",
    "scripts/lib/capacity-pool-id-check.mjs",
    "scripts/lib/lane-wiring-census.mjs",
    "scripts/lib/parse-source-file.mjs",
  ];
  assert.deepEqual(
    scriptsCallingTheParserDirectly(),
    known,
    "Parse through parseSourceFileStrict in scripts/lib/parse-source-file.mjs instead of calling createSourceFile. "
      + "This list may only shrink.",
  );
});
