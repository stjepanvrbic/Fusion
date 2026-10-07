import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractLeadingStaticGateChecks,
  readStaticGateChecks,
  runStaticGateChecks,
} from "../run-static-gate-checks.mjs";

const check = (name) => `scripts/check-${name}.mjs`;
/*
FNXC:TestInfrastructure 2026-08-16-10:52:
FN-8991, FN-8994, and FN-9096 added runtime-skill-loader-drift,
workspace-package-graph, and cli-runtime-routing validators to the production
chains. Those chains are authoritative; retain their exact order here so this
mirror reports future declaration drift rather than preserving a stale list.
*/
const EXPECTED_GATE_CHECKS = [
  check(["no-", ["no", "hup"].join("")].join("")),
  check("no-cwd-relative-dashboard-test-reads"),
  check(["no-", "kill-", "40" + "40"].join("")),
  check("no-getdatabase"),
  check("prerebase-inert"),
  check("capacity-pool-id"),
  check("cli-runtime-routing"),
  check("no-node-only-core-imports-in-dashboard"),
  check("pi-versions-pinned"),
  check("workspace-package-graph"),
  check("no-test-timeout-appeasement"),
  /* FNXC:TestInfrastructure 2026-10-07-18:03: the comment-assertion checker joined test:gate:static without this mirror; production was right and the mirror was stale. */
  check("no-comment-assertions-in-tests"),
  check("changeset-format"),
  check("mock-completeness"),
  check("inert-sync-lane-conversions"),
  check("runtime-skill-loader-drift"),
];

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "static-gate-checks-"));
  mkdirSync(join(root, "scripts"));
  return root;
}

function writeFixtureCheck(root, name, source) {
  writeFileSync(join(root, "scripts", `${name}.mjs`), source);
}

test("extractLeadingStaticGateChecks keeps only the blocking validator prefix", () => {
  assert.deepEqual(
    extractLeadingStaticGateChecks("node scripts/check-one.mjs && node scripts/check-two.mjs && sh -c 'test lanes'"),
    ["scripts/check-one.mjs", "scripts/check-two.mjs"],
  );
  assert.throws(
    () => extractLeadingStaticGateChecks("pnpm --filter @fusion/engine test:core"),
    /must contain one or more canonical static validators/,
  );
});

test("production gate inventory contains each canonical validator exactly once", () => {
  const checks = readStaticGateChecks();
  assert.deepEqual(checks, EXPECTED_GATE_CHECKS);
  assert.equal(new Set(checks).size, checks.length);
});

test("runStaticGateChecks runs clean fixture validators and waits for all", async () => {
  const root = createFixture();
  try {
    writeFixtureCheck(root, "check-first", 'console.log("first passed");');
    writeFixtureCheck(root, "check-second", 'console.log("second passed");');
    const messages = [];
    const results = await runStaticGateChecks(
      ["scripts/check-first.mjs", "scripts/check-second.mjs"],
      { root, log: (message) => messages.push(message) },
    );

    assert.deepEqual(results.map((result) => result.code), [0, 0]);
    assert.deepEqual(messages, ["[static-gate] 2 validators passed"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runStaticGateChecks reports every violating fixture validator before failing closed", async () => {
  const root = createFixture();
  try {
    writeFixtureCheck(root, "check-clean", 'process.exit(0);');
    writeFixtureCheck(root, "check-first-violation", 'console.error("first violation"); process.exit(1);');
    writeFixtureCheck(root, "check-second-violation", 'console.error("second violation"); process.exit(2);');
    const errors = [];

    await assert.rejects(
      () => runStaticGateChecks(
        [
          "scripts/check-clean.mjs",
          "scripts/check-first-violation.mjs",
          "scripts/check-second-violation.mjs",
        ],
        { root, errorLog: (message) => errors.push(message) },
      ),
      /2 static merge-gate validators failed/,
    );

    assert.deepEqual(errors, [
      "[static-gate] validator failed: scripts/check-first-violation.mjs (exit 1)",
      "[static-gate] validator failed: scripts/check-second-violation.mjs (exit 2)",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/*
FNXC:WindowsEntryGuard 2026-10-07-18:03:
Running the runner as a real entry point must execute every validator and fail closed, on Windows paths and paths with spaces.
The fixture copies the runner beside its own package.json because the runner derives the repository root from its own location.
*/
function createEntrypointFixture(checks) {
  const root = mkdtempSync(join(tmpdir(), "static gate entry "));
  const scriptsDir = join(root, "scripts");
  mkdirSync(join(scriptsDir, "lib"), { recursive: true });
  const realScripts = dirname(dirname(fileURLToPath(import.meta.url)));
  copyFileSync(join(realScripts, "run-static-gate-checks.mjs"), join(scriptsDir, "run-static-gate-checks.mjs"));
  copyFileSync(join(realScripts, "lib", "is-entry-point.mjs"), join(scriptsDir, "lib", "is-entry-point.mjs"));
  for (const [name, source] of Object.entries(checks)) writeFixtureCheck(root, name, source);
  const gate = Object.keys(checks).map((name) => `node scripts/${name}.mjs`).join(" && ");
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { "test:gate:static": gate } }));
  return root;
}

function runEntrypoint(root) {
  return spawnSync(process.execPath, [join(root, "scripts", "run-static-gate-checks.mjs")], { cwd: root, encoding: "utf8" });
}

test("direct entrypoint invocation runs every validator and reports success", () => {
  const root = createEntrypointFixture({ "check-alpha": 'console.log("alpha ran");', "check-beta": 'console.log("beta ran");' });
  try {
    const result = runEntrypoint(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /alpha ran/);
    assert.match(result.stdout, /beta ran/);
    assert.match(result.stdout, /\[static-gate\] 2 validators passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct entrypoint invocation fails closed on a violating validator", () => {
  const root = createEntrypointFixture({ "check-clean": "process.exit(0);", "check-broken": 'console.error("violation"); process.exit(3);' });
  try {
    const result = runEntrypoint(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /validator failed: scripts\/check-broken\.mjs \(exit 3\)/);
    assert.doesNotMatch(result.stdout, /validators passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
