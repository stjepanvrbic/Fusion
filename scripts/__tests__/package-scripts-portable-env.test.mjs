import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, globSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

/*
FNXC:WindowsTestScripts 2026-10-08-05:03:
cmd.exe, the npm-script shell on Windows, rejects POSIX `NAME=value command` syntax, so no workspace package.json script may set an env var that way.
Env-setting scripts route through scripts/run-with-env.mjs instead; this test is the ratchet that keeps the bare prefix from coming back.
*/

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const ASSIGNMENT_AT_START = /^[A-Za-z_][A-Za-z0-9_]*=\S*(\s|$)/;

/** Workspace package globs from pnpm-workspace.yaml's `packages:` list. */
function workspaceGlobs() {
  const lines = readFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8").split(/\r?\n/);
  const start = lines.findIndex((line) => /^packages:\s*$/.test(line));
  assert.notEqual(start, -1, "pnpm-workspace.yaml must declare packages:");
  const globs = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^\s+-\s+["']?([^"'#]+?)["']?\s*$/.exec(line);
    if (!match) {
      if (/^\S/.test(line)) break;
      continue;
    }
    globs.push(match[1]);
  }
  return globs;
}

function workspaceManifests() {
  const manifests = ["package.json"];
  for (const pattern of workspaceGlobs()) {
    for (const dir of globSync(pattern, { cwd: repoRoot })) {
      const manifest = path.join(dir, "package.json");
      if (existsSync(path.join(repoRoot, manifest))) manifests.push(manifest);
    }
  }
  return [...new Set(manifests)].sort();
}

/** Command segments that start a new command: split on `&&`, `||` and `;`. */
export function findEnvPrefixSegments(script) {
  return script.split(/&&|\|\||;/).map((segment) => segment.trim()).filter((segment) => ASSIGNMENT_AT_START.test(segment));
}

function scriptsOf(manifest) {
  return JSON.parse(readFileSync(path.join(repoRoot, manifest), "utf8")).scripts ?? {};
}

test("the detector flags env prefixes and ignores flags and inline code", () => {
  assert.deepEqual(findEnvPrefixSegments("A=1 vitest"), ["A=1 vitest"]);
  assert.deepEqual(findEnvPrefixSegments("pnpm build && B=2 vitest"), ["B=2 vitest"]);
  assert.deepEqual(findEnvPrefixSegments("x || C=3 y; D=4 z"), ["C=3 y", "D=4 z"]);
  assert.deepEqual(findEnvPrefixSegments("node run.mjs --heap=6144 vitest"), []);
  assert.deepEqual(findEnvPrefixSegments("node -e \"process.env.X='1'\""), []);
  assert.deepEqual(findEnvPrefixSegments("node scripts/run-with-env.mjs A=1 -- pnpm test:full"), []);
});

test("no workspace package.json script uses POSIX NAME=value command syntax", () => {
  const manifests = workspaceManifests();
  assert.ok(manifests.includes(path.join("packages", "dashboard", "package.json")), "the dashboard manifest is enumerated");
  const offenders = [];
  for (const manifest of manifests) {
    for (const [name, script] of Object.entries(scriptsOf(manifest))) {
      if (typeof script === "string" && findEnvPrefixSegments(script).length > 0) offenders.push(`${manifest} → ${name}: ${script}`);
    }
  }
  assert.deepEqual(offenders, [], "use `node scripts/run-with-env.mjs NAME=value -- command` instead");
});

test("the env-setting test scripts route through run-with-env with their assignments", () => {
  const root = scriptsOf("package.json");
  const dashboard = scriptsOf(path.join("packages", "dashboard", "package.json"));
  const expected = [
    [root["test:serial"], "node scripts/run-with-env.mjs FUSION_TEST_CONCURRENCY=1 FUSION_TEST_WORKSPACE_CONCURRENCY=1 -- pnpm test:full", []],
    [root["test:fast"], "node scripts/run-with-env.mjs FUSION_TEST_CONCURRENCY=4 FUSION_TEST_WORKSPACE_CONCURRENCY=4 -- pnpm test:full", []],
    [dashboard["test:app"], "node ../../scripts/run-with-env.mjs FUSION_DASHBOARD_DEEP=1 -- vitest run", ["--project dashboard-app"]],
    [dashboard["test:api"], "node ../../scripts/run-with-env.mjs FUSION_DASHBOARD_DEEP=1 -- vitest run", ["--project dashboard-api"]],
    [dashboard["test:deep"], "node ../../scripts/run-with-env.mjs FUSION_DASHBOARD_DEEP=1 -- vitest run", ["--project dashboard-app", "--project dashboard-api"]],
    [dashboard["test:build"], "pnpm build && node ../../scripts/run-with-env.mjs FUSION_DASHBOARD_DEEP=1 -- vitest run", ["--project dashboard-app", "--project dashboard-api"]],
  ];
  for (const [script, prefix, projects] of expected) {
    assert.ok(script?.startsWith(prefix), `${script} must start with ${prefix}`);
    for (const project of projects) assert.ok(script.includes(project), `${script} must keep ${project}`);
    assert.ok(!script.includes("'"), `${script} must not use single quotes, which cmd.exe passes literally`);
  }
});
