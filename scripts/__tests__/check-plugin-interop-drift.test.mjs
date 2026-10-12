/*
FNXC:PluginInteropDrift 2026-07-31-07:35:
THE NON-FUNCTION EXPORT RULE IS WHAT KEEPS THIS CHECK CREDIBLE.

Its first run reported `TaskCard` as a function the dashboard no longer exports. It exports it as
`export const TaskCard = memo(TaskCardComponent, ...)` — present, but with an arity that belongs to a
wrapped component rather than to the export. A check whose debut finding is a false positive does not
get a second reading, so the distinction between ABSENT and NOT-COMPARABLE is pinned here.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { exportedFunctions } from "../check-plugin-interop-drift.mjs";
import { SourceParseError } from "../lib/parse-source-file.mjs";

const parse = (src) => exportedFunctions(src, "t.tsx");

test("an exported function declaration reports its arity", () => {
  const found = parse("export function f(a, b, c) { return a; }");
  assert.deepEqual(found.get("f"), { total: 3, required: 3 });
});

test("optional and defaulted parameters are not required", () => {
  const found = parse("export function f(a, b?, c = 1, ...rest) { return a; }");
  assert.deepEqual(found.get("f"), { total: 4, required: 1 });
});

test("an exported arrow function is comparable", () => {
  const found = parse("export const f = (a, b) => a + b;");
  assert.deepEqual(found.get("f"), { total: 2, required: 2 });
});

test("a memo()-wrapped export is PRESENT but not comparable", () => {
  /* The false positive the first run produced: reported as a rename. */
  const found = parse("export const TaskCard = memo(TaskCardComponent, areEqual);");
  assert.equal(found.has("TaskCard"), true);
  assert.equal(found.get("TaskCard"), null);
});

test("a non-exported function is invisible", () => {
  assert.equal(parse("function hidden(a) { return a; }").has("hidden"), false);
});

/*
FNXC:PluginInteropDrift 2026-07-31-08:20:
INTERFACES ARE ONE-DIRECTIONAL: fewer properties is correct, unknown ones are the drift.

All six mirrors declare subsets (6, 8, 7, 7, 3, 6 against the real nine) because a plugin mirrors
only the fields it uses. Demanding equality would fail every plugin for not using everything, which
is how a check gets deleted. A property the real type lacks is a rename nobody propagated — the
plugin keeps compiling and reads a field the host never sends.
*/
import { declaredInterfacesForTest } from "../check-plugin-interop-drift.mjs";

test("an interface's property names are collected", () => {
  const found = declaredInterfacesForTest("export interface P { a: string; b?: number }", "t.tsx");
  assert.deepEqual([...(found.get("P") ?? new Map()).keys()], ["a", "b"]);
});

test("a mirror declaring FEWER properties is not drift", () => {
  const real = declaredInterfacesForTest("export interface P { a: string; b?: number; c?: boolean }", "t.tsx").get("P");
  const mirrored = ["a"];
  assert.equal(mirrored.every((p) => real.has(p)), true);
});

test("a mirror declaring an UNKNOWN property is drift", () => {
  /* The live case: `TaskCardProps.workflowStepNameLookup` outlived its removal from TaskCard. */
  const real = declaredInterfacesForTest("export interface P { a: string }", "t.tsx").get("P");
  assert.equal(real.has("workflowStepNameLookup"), false);
});

/* Valid TypeScript that opens a phantom JSX element when the file is parsed as TSX. */
const GENERIC_ARROW = "const underLock = <T>(run: () => Promise<T>): Promise<T> => run();\n";
const ANGLE_ASSERTION = "declare const raw: unknown;\nconst n = <number>raw;\n";
const FUNCTION = "export function f(a: string, b?: number) { return a; }\n";
const INTERFACE = "export interface P { a: string; b?: number }\n";
const BROKEN = "export function )( {\n";

const propertiesOf = (source, fileName) => [...(declaredInterfacesForTest(source, fileName).get("P") ?? new Map()).keys()];

test("an exported function after a generic arrow in a .ts module is found", () => {
  assert.deepEqual(exportedFunctions(GENERIC_ARROW + FUNCTION, "t.ts").get("f"), { total: 2, required: 1 });
});

test("an interface after a generic arrow in a .ts module is found", () => {
  assert.deepEqual(propertiesOf(GENERIC_ARROW + INTERFACE, "t.ts"), ["a", "b"]);
});

test("an exported function and an interface after an angle-bracket assertion are found", () => {
  assert.deepEqual(exportedFunctions(ANGLE_ASSERTION + FUNCTION, "t.ts").get("f"), { total: 2, required: 1 });
  assert.deepEqual(propertiesOf(ANGLE_ASSERTION + INTERFACE, "t.ts"), ["a", "b"]);
});

test("an exported function after real JSX in a .tsx module is found", () => {
  const found = exportedFunctions(`export const el = <div>{1}</div>;\n${FUNCTION}`, "t.tsx");
  assert.deepEqual(found.get("f"), { total: 2, required: 1 });
});

test("a module that does not parse is refused instead of read as exporting nothing", () => {
  const refused = (error) => {
    assert.ok(error instanceof SourceParseError);
    assert.equal(error.file, "t.ts");
    assert.ok(error.message.includes("t.ts:1:"), error.message);
    assert.ok(error.message.includes("not inspected"), error.message);
    return true;
  };
  assert.throws(() => exportedFunctions(BROKEN + FUNCTION, "t.ts"), refused);
  assert.throws(() => declaredInterfacesForTest(BROKEN + INTERFACE, "t.ts"), refused);
});

test("importing the gate module does not run the comparison", () => {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const gateUrl = pathToFileURL(resolve(repo, "scripts/check-plugin-interop-drift.mjs")).href;
  const code = [
    'import fs from "node:fs";',
    'import { syncBuiltinESMExports } from "node:module";',
    'fs.globSync = () => { throw new Error("mirror lookup while importing the gate"); };',
    "syncBuiltinESMExports();",
    `await import(${JSON.stringify(gateUrl)});`,
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});
