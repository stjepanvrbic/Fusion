/*
FNXC:LifecycleColumnCensus 2026-07-30-23:45 (#2851 review — greptile, "call classification lacks
regression coverage"):

THE RULES THAT DECIDE WHICH CALLS COUNT, PINNED ONE AT A TIME.

`isRelevantCallSite` answers "is this recorded call actually a call to THIS seam?", and every clause
in it was added to fix a specific failure the gate had already shipped. None had a test. Both
directions matter and they fail differently:

  - A clause that stops excluding turns the gate RED on correct code. It cried wolf on main over two
    valid call sites, and a guard that does that teaches its readers to skip the line that matters.
  - A clause that over-excludes turns the gate GREEN on a real offender. Comparing module basenames
    once dropped every barrel-imported call, so four engine sites omitting a required argument became
    invisible while the report read "supplied by 5/6".

The second is the worse one and the harder to notice, so each exclusion below is paired with the
inclusion it must not swallow.

WHY THE SITES ARE HAND-BUILT rather than parsed from fixture source: the recorded-site shape IS the
contract between the walk and the classifier. Driving it through the walk would test the walk too, and
a failure would not say which half broke.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

import {
  collectImportBindings,
  collectSeamData,
  isRelevantCallSite,
  effectiveArgCount,
} from "../check-inert-flag-seams.mjs";
import { SourceParseError, parseSourceFileStrict } from "../lib/parse-source-file.mjs";

const DECLARING = "packages/core/src/near-duplicate-canonical.ts";

/** A recorded call site with the defaults of the ordinary case: bare identifier, imported by name. */
function site(overrides = {}) {
  return {
    file: "packages/engine/src/self-healing.ts",
    args: 2,
    shadowed: false,
    from: "@fusion/core",
    viaProperty: false,
    isTest: false,
    ...overrides,
  };
}

test("a barrel/package import COUNTS — the regression that hid four engine call sites", () => {
  /*
  Engine and CLI reach core through `import { ... } from "@fusion/core"`, whose basename is "core"
  and never matches a module name like `near-duplicate-canonical`. Excluding on basename therefore
  dropped the entire cross-package surface this gate exists to watch. Unresolved must mean COUNTED: an
  over-counted seam produces a report somebody investigates, an under-counted one produces silence.
  */
  assert.equal(isRelevantCallSite(site({ from: "@fusion/core" }), DECLARING), true);
});

test("a relative import of the SAME module counts", () => {
  assert.equal(isRelevantCallSite(site({ from: "./near-duplicate-canonical.js" }), DECLARING), true);
});

test("a relative import of a DIFFERENT module does not", () => {
  /* The imported-shadow case: a same-named function from another module is not this seam. */
  assert.equal(isRelevantCallSite(site({ from: "./taskSorting.js" }), DECLARING), false);
});

test("a PROPERTY call is excluded — `store.enqueueMergeQueue(...)` is not the module function", () => {
  /*
  The false positive that turned main red. `store.enqueueMergeQueue(taskId, opts)` is a 2-arg TaskStore
  METHOD that resolves the review columns internally; the module function it shares a name with takes
  5. Counting the method's calls reported the module seam as under-supplied over two correct sites.
  */
  assert.equal(isRelevantCallSite(site({ viaProperty: true }), DECLARING), false);
});

test("a BARE call from the same file is still counted — the exclusion is property-access only", () => {
  /*
  The paired inclusion. If `viaProperty` ever widened to "any call in a file that also has method
  calls", every seam with a store wrapper would go silently unwatched.
  */
  assert.equal(isRelevantCallSite(site({ viaProperty: false }), DECLARING), true);
});

test("a call in the seam's OWN file counts even when the file declares it locally", () => {
  /* The declaring file always declares the function; excluding it as a shadow would drop the
     seam's own internal callers. */
  assert.equal(isRelevantCallSite(site({ file: DECLARING, shadowed: true, from: undefined }), DECLARING), true);
});

test("a LOCAL same-named function shadows the seam", () => {
  assert.equal(isRelevantCallSite(site({ shadowed: true, from: undefined }), DECLARING), false);
});

test("an unimported, unshadowed call counts — ambiguous resolves toward counting", () => {
  /*
  Same argument as the barrel case: this classifier's errors must land on the noisy side, because
  the quiet side is a seam nobody is watching.
  */
  assert.equal(isRelevantCallSite(site({ from: undefined }), DECLARING), true);
});

test("a TEST call site is classified as relevant here — suppression happens later, on purpose", () => {
  /*
  Worth pinning because it looks like an omission. `isTest` is deliberately NOT an exclusion: the
  caller splits production from test sites afterwards, so tests can be REPORTED ("3 test call sites")
  without ever CLEARING a seam. Excluding them here would erase that signal; counting them as
  suppliers would instead hide an inert production seam.
  */
  assert.equal(isRelevantCallSite(site({ isTest: true }), DECLARING), true);
});

test("a .tsx declaring file resolves its module name the same way", () => {
  /* The basename strip handles both extensions; a dashboard component seam must not be misclassified
     against every relative importer. */
  const declaring = "packages/dashboard/app/components/taskSorting.tsx";
  assert.equal(isRelevantCallSite(site({ from: "./taskSorting.js" }), declaring), true);
  assert.equal(isRelevantCallSite(site({ from: "./other.js" }), declaring), false);
});

/*
FNXC:LifecycleColumnCensus 2026-07-31-00:05 (#2851 review — the alias half of the finding):

THE DIRECTION IS THE RISK, so these assert it explicitly rather than just "the map is populated".

For `import { a as b }` the TypeScript AST puts the EXPORTED name in `propertyName` and the LOCAL name
in `name`. Reading them the other way round still yields a populated map and still runs — it just maps
backwards, and the gate then attributes calls to a name nothing declares, leaving the real seam
looking unsupplied. That is the shape that produced `enqueueMergeQueue() — best call passes 2 of 5`
while its only production caller passed all five through the alias.
*/
test("a renamed import maps LOCAL name -> EXPORTED name, not the reverse", () => {
  const sf = ts.createSourceFile(
    "t.ts",
    'import { enqueueMergeQueue as enqueueMergeQueueAsync } from "./async-merge-coordination.js";',
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const { localAlias, importedFrom } = collectImportBindings(sf);

  /* The call site spells the LOCAL name, so that must be the key. */
  assert.equal(localAlias.get("enqueueMergeQueueAsync"), "enqueueMergeQueue");
  assert.equal(localAlias.get("enqueueMergeQueue"), undefined);
  /* And the module specifier is recorded under the local name too, for the same reason. */
  assert.equal(importedFrom.get("enqueueMergeQueueAsync"), "./async-merge-coordination.js");
});

test("a plain import records no alias", () => {
  /* The paired negative: an unrenamed import must not enter the alias map, or every bare call would
     be remapped onto itself and mask a genuine rename regression. */
  const sf = ts.createSourceFile(
    "t.ts",
    'import { enqueueMergeQueue } from "@fusion/core";',
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const { localAlias, importedFrom } = collectImportBindings(sf);

  assert.equal(localAlias.size, 0);
  assert.equal(importedFrom.get("enqueueMergeQueue"), "@fusion/core");
});

/*
FNXC:LifecycleColumnCensus 2026-07-30-23:55:
`undefined` IS NOT AN ANSWER, and counting raw arguments treated it as one.

`f("KB-1", undefined)` passes the arity check while the callee receives exactly what it received
before. The seam stays inert and the board keeps reading the legacy vocabulary — the gate just stops
saying so. This is what a partial wiring-up produces when the flags are threaded through an
intermediate that has none, and what a mechanical positional edit produces.

The negatives are the half that keeps this honest: a MIDDLE undefined still positions the real
argument after it, so trimming must stop at the first non-undefined from the right.
*/
function argsOf(source) {
  const sf = parseSourceFileStrict("t.ts", source);
  let found = null;
  const visit = (node) => {
    if (!found && ts.isCallExpression(node)) found = node.arguments;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

test("a trailing `undefined` argument supplies nothing", () => {
  assert.equal(effectiveArgCount(argsOf('f("KB-1", undefined);')), 1);
});

test("`void 0` is the same omission spelled differently", () => {
  assert.equal(effectiveArgCount(argsOf('f("KB-1", void 0);')), 1);
});

test("several trailing undefineds all collapse", () => {
  assert.equal(effectiveArgCount(argsOf('f("KB-1", undefined, undefined);')), 1);
});

test("a real trailing argument still counts", () => {
  assert.equal(effectiveArgCount(argsOf('f("KB-1", flags);')), 2);
});

test("a MIDDLE undefined positions the argument after it, which is real", () => {
  assert.equal(effectiveArgCount(argsOf('f("KB-1", undefined, flags);')), 3);
});

test("a call with no arguments is unchanged", () => {
  assert.equal(effectiveArgCount(argsOf("f();")), 0);
});

/* Valid TypeScript that opens a phantom JSX element when the file is parsed as TSX. */
const GENERIC_ARROW = "const underLock = <T>(work: () => Promise<T>): Promise<T> => work();\n";
const ANGLE_ASSERTION = "declare const raw: unknown;\nconst n = <number>raw;\n";

const THING = "packages/x/src/thing.ts";
const THING_SOURCE = [
  GENERIC_ARROW,
  "export function isThing(task: Task, columnFlags?: Flags): boolean {\n",
  '  return columnFlags ? columnFlags.wip : task.column === "in-progress";\n',
  "}\n",
].join("");

/** Walk in-memory files, keyed by repository-relative name, through the scan the gate runs. */
function seamData(fileMap) {
  const absolute = Object.fromEntries(Object.entries(fileMap).map(([file, source]) => [`/repo/${file}`, source]));
  return collectSeamData(Object.keys(absolute), { repoRoot: "/repo", readFile: (file) => absolute[file] });
}

/** The recorded calls the gate attributes to the `isThing` seam. */
function isThingSites(fileMap) {
  const { callSites } = seamData({ [THING]: THING_SOURCE, ...fileMap });
  return (callSites.get("isThing") ?? []).filter((site) => isRelevantCallSite(site, THING));
}

test("a seam and an omitting call that both follow a generic arrow in .ts files are recorded", () => {
  const caller = "packages/x/src/caller.ts";
  const fileMap = {
    [caller]: `import { isThing } from "./thing.js";\n${GENERIC_ARROW}export function check(task: Task): boolean {\n  return isThing(task);\n}\n`,
  };

  assert.deepEqual(seamData({ [THING]: THING_SOURCE, ...fileMap }).declared.get("isThing"), { file: THING, arity: 2 });
  assert.deepEqual(isThingSites(fileMap), [
    { file: caller, args: 1, shadowed: false, from: "./thing.js", viaProperty: false, isTest: false },
  ]);
});

test("the same call passing the flags is recorded with both arguments", () => {
  const sites = isThingSites({
    "packages/x/src/caller.ts": `import { isThing } from "./thing.js";\n${GENERIC_ARROW}export function check(task: Task, flags: Flags): boolean {\n  return isThing(task, flags);\n}\n`,
  });
  assert.deepEqual(sites.map((site) => site.args), [2]);
});

test("a call after an angle-bracket type assertion in a .ts file is recorded", () => {
  const sites = isThingSites({
    "packages/x/src/caller.ts": `import { isThing } from "./thing.js";\n${ANGLE_ASSERTION}export function check(task: Task): boolean {\n  return isThing(task);\n}\n`,
  });
  assert.deepEqual(sites.map((site) => [site.file, site.args]), [["packages/x/src/caller.ts", 1]]);
});

test("a call after real JSX in a .tsx file is recorded", () => {
  const sites = isThingSites({
    "packages/x/src/View.tsx": 'import { isThing } from "./thing.js";\nexport const el = <div>{1}</div>;\nexport function check(task: Task): boolean {\n  return isThing(task);\n}\n',
  });
  assert.deepEqual(sites.map((site) => [site.file, site.args]), [["packages/x/src/View.tsx", 1]]);
});

test("a call in a test file is recorded as a test call site", () => {
  const sites = isThingSites({
    "packages/x/src/__tests__/caller.test.ts": 'import { isThing } from "../thing.js";\nisThing(task, flags);\n',
  });
  assert.deepEqual(sites.map((site) => [site.file, site.args, site.isTest]), [
    ["packages/x/src/__tests__/caller.test.ts", 2, true],
  ]);
});

test("a file that does not parse stops the scan instead of being reported as checked", () => {
  assert.throws(
    () => seamData({ [THING]: THING_SOURCE, "packages/x/src/broken.ts": "export function )( {\nisThing(task);\n" }),
    (error) => {
      assert.ok(error instanceof SourceParseError);
      assert.equal(error.file, "packages/x/src/broken.ts");
      assert.ok(error.message.includes("packages/x/src/broken.ts:1:"), error.message);
      assert.ok(error.message.includes("not inspected"), error.message);
      return true;
    },
  );
});

test("importing the gate module does not walk the repository", () => {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const gateUrl = pathToFileURL(resolve(repo, "scripts/check-inert-flag-seams.mjs")).href;
  const code = [
    'import fs from "node:fs";',
    'import { syncBuiltinESMExports } from "node:module";',
    'fs.readdirSync = () => { throw new Error("directory read while importing the gate"); };',
    "syncBuiltinESMExports();",
    `await import(${JSON.stringify(gateUrl)});`,
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});
