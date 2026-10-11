/*
FNXC:TestInfraWindows 2026-10-11-07:02:
The non-durable cluster script runs in every Windows Full Suite leg. It must issue each ALTER SYSTEM separately before the reload, wait out reload lag, fail loudly naming a setting that never takes effect, and refuse to run without --throwaway or a server URL.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NON_DURABLE_SETTINGS, makeClusterNonDurable } from "../pg-test-cluster-non-durable.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = path.join(repoRoot, "scripts", "pg-test-cluster-non-durable.mjs");

/** Fake query that records statements; `showAnswers[name]` lists successive SHOW answers, the last one repeating. */
function fakeServer(showAnswers = {}) {
  const statements = [];
  const showCounts = {};
  const query = async (statement) => {
    statements.push(statement);
    const show = /^SHOW (\w+)$/.exec(statement);
    if (show) {
      const name = show[1];
      const answers = showAnswers[name] ?? ["off"];
      const index = Math.min(showCounts[name] ?? 0, answers.length - 1);
      showCounts[name] = (showCounts[name] ?? 0) + 1;
      return [{ [name]: answers[index] }];
    }
    if (statement === "SELECT version()") return [{ version: "PostgreSQL 17.11" }];
    return [];
  };
  return { query, statements, showCounts };
}

test("issues each ALTER SYSTEM separately, in order, before the reload, and returns the effective values", async () => {
  const server = fakeServer();
  const sleeps = [];
  const result = await makeClusterNonDurable({ query: server.query, sleep: async (ms) => { sleeps.push(ms); } });

  assert.deepEqual(server.statements.slice(0, 4), [
    "ALTER SYSTEM SET fsync = off",
    "ALTER SYSTEM SET synchronous_commit = off",
    "ALTER SYSTEM SET full_page_writes = off",
    "SELECT pg_reload_conf()",
  ]);
  assert.deepEqual(result, {
    version: "PostgreSQL 17.11",
    settings: { fsync: "off", synchronous_commit: "off", full_page_writes: "off" },
  });
  assert.deepEqual(NON_DURABLE_SETTINGS, ["fsync", "synchronous_commit", "full_page_writes"]);
  assert.deepEqual(sleeps, []);
});

test("waits out reload lag until every setting reads off", async () => {
  const server = fakeServer({ fsync: ["on", "on", "off"] });
  const sleeps = [];
  const result = await makeClusterNonDurable({ query: server.query, sleep: async (ms) => { sleeps.push(ms); } });

  assert.equal(result.settings.fsync, "off");
  assert.equal(server.showCounts.fsync, 3);
  assert.equal(sleeps.length, 2);
});

test("rejects naming the setting that never takes effect, after a bounded number of polls", async () => {
  const server = fakeServer({ fsync: ["on"] });
  let sleepCount = 0;
  await assert.rejects(
    makeClusterNonDurable({ query: server.query, sleep: async () => { sleepCount += 1; }, maxPolls: 4 }),
    (error) => {
      assert.match(error.message, /fsync=on/);
      assert.doesNotMatch(error.message, /synchronous_commit|full_page_writes/);
      return true;
    },
  );
  assert.equal(server.showCounts.fsync, 4);
  assert.equal(sleepCount, 3);
  assert.ok(!server.statements.includes("SELECT version()"));
});

function runScript(args, env) {
  const childEnv = { ...process.env, ...env };
  if (env.FUSION_PG_TEST_URL_BASE === undefined) delete childEnv.FUSION_PG_TEST_URL_BASE;
  return spawnSync(process.execPath, [scriptPath, ...args], { cwd: repoRoot, env: childEnv, encoding: "utf8" });
}

test("refuses with exit code 2 without --throwaway", () => {
  const run = runScript([], { FUSION_PG_TEST_URL_BASE: "postgresql://postgres@127.0.0.1:1" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--throwaway/);
});

test("refuses with exit code 2 when FUSION_PG_TEST_URL_BASE is not set", () => {
  const run = runScript(["--throwaway"], { FUSION_PG_TEST_URL_BASE: undefined });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /FUSION_PG_TEST_URL_BASE/);
});
