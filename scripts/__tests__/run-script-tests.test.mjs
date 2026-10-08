/*
FNXC:CI 2026-10-08-10:42:
KB-062's Windows scripts lane forwards node:test reporter flags through run-script-tests.mjs; every other argument must stay a test file, exactly as before.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { splitForwardedArgs } from "../run-script-tests.mjs";

test("no arguments yields no reporter args and no files", () => {
  assert.deepEqual(splitForwardedArgs([]), { reporterArgs: [], files: [] });
});

test("drops the -- separator and keeps file arguments", () => {
  assert.deepEqual(splitForwardedArgs(["--", "scripts/__tests__/a.test.mjs"]), { reporterArgs: [], files: ["scripts/__tests__/a.test.mjs"] });
});

test("separates --flag=value reporter flags in order from files", () => {
  const argv = [
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=./scripts/lib/node-test-json-reporter.mjs",
    "--test-reporter-destination=.windows-lane/scripts.json",
    "scripts/__tests__/a.test.mjs",
  ];
  assert.deepEqual(splitForwardedArgs(argv), { reporterArgs: argv.slice(0, 4), files: ["scripts/__tests__/a.test.mjs"] });
});

test("separates the space-separated --flag value form", () => {
  assert.deepEqual(splitForwardedArgs(["--test-reporter", "spec", "--test-reporter-destination", "stdout", "a.test.mjs"]), {
    reporterArgs: ["--test-reporter", "spec", "--test-reporter-destination", "stdout"],
    files: ["a.test.mjs"],
  });
});
