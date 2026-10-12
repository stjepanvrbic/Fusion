import test from "node:test";
import assert from "node:assert/strict";

import { findUnwiredLaneParameters } from "../lib/unwired-lane-parameter.mjs";
import { SourceParseError } from "../lib/parse-source-file.mjs";

/* Valid TypeScript that opens a phantom JSX element when the file is parsed as TSX. */
const GENERIC_ARROW = "const underLock = <T>(run: () => Promise<T>): Promise<T> => run();\n";
const ANGLE_ASSERTION = "declare const raw: unknown;\nconst n = <number>raw;\n";
const DECLARATION = [
  "export function isThing(task: { column: string }, reviewColumns?: ReadonlySet<string>): boolean {",
  '  return reviewColumns ? reviewColumns.has(task.column) : task.column === "in-review";',
  "}",
  "",
].join("\n");

const THING = "/repo/packages/core/src/thing.ts";
const CALLER = "/repo/packages/core/src/caller.ts";

function unwired(fileMap) {
  return findUnwiredLaneParameters(Object.keys(fileMap), (file) => fileMap[file]);
}

test("an unwired lane parameter declared after a generic arrow in a .ts file is reported", () => {
  const found = unwired({
    [THING]: GENERIC_ARROW + DECLARATION,
    [CALLER]: 'import { isThing } from "./thing.js";\nexport const result = isThing({ column: "todo" });\n',
  });
  assert.deepEqual(found, [{ file: THING, line: 2, parameter: "reviewColumns", owner: "isThing" }]);
});

test("the same declaration is not reported when a caller supplies the parameter", () => {
  const found = unwired({
    [THING]: GENERIC_ARROW + DECLARATION,
    [CALLER]: [
      'import { isThing } from "./thing.js";',
      'const reviewColumns = new Set(["in-review"]);',
      'export const result = isThing({ column: "todo" }, reviewColumns);',
      "",
    ].join("\n"),
  });
  assert.deepEqual(found, []);
});

test("an unwired interface property declared after an angle-bracket assertion is reported", () => {
  const found = unwired({
    [THING]: `${ANGLE_ASSERTION}export interface ThingOptions { reviewColumns?: ReadonlySet<string> }\n`,
    [CALLER]: 'import type { ThingOptions } from "./thing.js";\nexport const options: ThingOptions = {};\n',
  });
  assert.deepEqual(found, [{ file: THING, line: 3, parameter: "reviewColumns", owner: "ThingOptions" }]);
});

test("an unwired lane parameter declared after real JSX in a .tsx file is reported", () => {
  const view = "/repo/packages/dashboard/app/View.tsx";
  const found = unwired({
    [view]: `export const el = <div>{1}</div>;\n${DECLARATION}`,
    [CALLER]: 'import { isThing } from "./View.js";\nexport const result = isThing({ column: "todo" });\n',
  });
  assert.deepEqual(found, [{ file: view, line: 2, parameter: "reviewColumns", owner: "isThing" }]);
});

test("a file that does not parse stops the scan instead of being reported as checked", () => {
  const broken = "/repo/packages/core/src/broken.ts";
  assert.throws(
    () => unwired({ [THING]: DECLARATION, [broken]: `export function )( {\n${DECLARATION}` }),
    (error) => {
      assert.ok(error instanceof SourceParseError);
      assert.equal(error.file, broken);
      assert.ok(error.message.includes(`${broken}:1:`), error.message);
      assert.ok(error.message.includes("not inspected"), error.message);
      return true;
    },
  );
});
