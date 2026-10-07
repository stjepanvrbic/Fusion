import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers";

import { CONCURRENT_GATE_LANES, FINAL_GATE_LANE, runTestGate } from "../run-test-gate.mjs";

/*
FNXC:MergeGateWindows 2026-10-07-18:03:
The gate orchestrator must launch every concurrent lane before awaiting any, wait for all of them, run ci-shape only after all passed, and fail closed on any static or lane failure.
*/

function laneName(args) {
  const joined = args.join(" ");
  const all = [...CONCURRENT_GATE_LANES, FINAL_GATE_LANE];
  return all.find((lane) => joined.endsWith(lane.args.join(" ")))?.name ?? joined;
}

/** A spawn double whose children close only when the test says so. */
function controllableSpawn() {
  const children = new Map();
  const launches = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.kill = () => {};
    const name = laneName(args);
    children.set(name, child);
    launches.push({ name, command, args, options });
    return child;
  };
  const close = (name, code) => children.get(name).emit("close", code, null);
  return { spawnImpl, launches, close };
}

const quiet = { log: () => {}, errorLog: () => {}, platform: "linux" };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("launches all three concurrent lanes before any finishes, then ci-shape after all pass", async () => {
  const { spawnImpl, launches, close } = controllableSpawn();
  const env = { FUSION_PG_TEST_URL_BASE: "postgresql://x@localhost:1", PATH: "/bin" };
  const gate = runTestGate({ ...quiet, runStatic: async () => {}, spawnImpl, env, cwd: "/repo" });
  await tick();

  assert.deepEqual(launches.map((launch) => launch.name), ["engine-core", "pg-gate", "unit-gate"]);
  for (const launch of launches) {
    assert.equal(launch.command, "pnpm");
    assert.equal(launch.options.shell, false);
    assert.equal(launch.options.env, env, "lanes inherit the caller environment");
    assert.equal(launch.options.cwd, "/repo");
  }

  close("unit-gate", 0);
  close("engine-core", 0);
  await tick();
  assert.equal(launches.length, 3, "ci-shape must wait for every concurrent lane");
  close("pg-gate", 0);
  await tick();
  assert.deepEqual(launches.map((launch) => launch.name), ["engine-core", "pg-gate", "unit-gate", "ci-shape"]);
  close("ci-shape", 0);
  const results = await gate;
  assert.deepEqual(results.map((result) => [result.name, result.code]), [["engine-core", 0], ["pg-gate", 0], ["unit-gate", 0], ["ci-shape", 0]]);
});

test("one failed lane waits for the others, reports it, and skips ci-shape", async () => {
  const { spawnImpl, launches, close } = controllableSpawn();
  const errors = [];
  const gate = runTestGate({ ...quiet, errorLog: (m) => errors.push(m), runStatic: async () => {}, spawnImpl });
  let settled = false;
  gate.catch(() => {}).finally(() => { settled = true; });
  await tick();

  close("pg-gate", 1);
  await tick();
  assert.equal(settled, false, "the gate must keep waiting for the remaining lanes");
  close("engine-core", 0);
  close("unit-gate", 0);
  await assert.rejects(gate, /1 gate lane failed; ci-shape not run/);
  assert.deepEqual(errors, ["[test-gate] lane failed: pg-gate (exit code 1)"]);
  assert.equal(launches.some((launch) => launch.name === "ci-shape"), false);
});

test("multiple failed lanes are all reported", async () => {
  const { spawnImpl, close } = controllableSpawn();
  const errors = [];
  const gate = runTestGate({ ...quiet, errorLog: (m) => errors.push(m), runStatic: async () => {}, spawnImpl });
  await tick();
  close("engine-core", 2);
  close("pg-gate", 0);
  close("unit-gate", 3);
  await assert.rejects(gate, /2 gate lanes failed/);
  assert.deepEqual(errors, ["[test-gate] lane failed: engine-core (exit code 2)", "[test-gate] lane failed: unit-gate (exit code 3)"]);
});

test("a lane that cannot launch fails the gate", async () => {
  const errors = [];
  const spawnImpl = (command, args) => {
    const child = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (laneName(args) === "engine-core") child.emit("error", new Error("spawn pnpm ENOENT"));
      else child.emit("close", 0, null);
    });
    return child;
  };
  await assert.rejects(runTestGate({ ...quiet, errorLog: (m) => errors.push(m), runStatic: async () => {}, spawnImpl }), /1 gate lane failed/);
  assert.deepEqual(errors, ["[test-gate] lane failed: engine-core (spawn error: spawn pnpm ENOENT)"]);
});

test("a failed ci-shape lane fails the gate", async () => {
  const { spawnImpl, close } = controllableSpawn();
  const gate = runTestGate({ ...quiet, runStatic: async () => {}, spawnImpl });
  await tick();
  for (const lane of CONCURRENT_GATE_LANES) close(lane.name, 0);
  await tick();
  close("ci-shape", 1);
  await assert.rejects(gate, /gate lane ci-shape failed/);
});

test("a static validator failure launches no test lane", async () => {
  const { spawnImpl, launches } = controllableSpawn();
  await assert.rejects(
    runTestGate({ ...quiet, runStatic: async () => { throw new Error("1 static merge-gate validator failed"); }, spawnImpl }),
    /static merge-gate validator failed/,
  );
  assert.deepEqual(launches, []);
});

test("on win32 the lanes launch through the resolved pnpm entry, not a shell", async () => {
  const { spawnImpl, launches, close } = controllableSpawn();
  const cli = String.raw`C:\npm\node_modules\pnpm\bin\pnpm.cjs`;
  const gate = runTestGate({ ...quiet, platform: "win32", env: { npm_execpath: cli }, runStatic: async () => {}, spawnImpl });
  await tick();
  for (const launch of launches) {
    assert.equal(launch.command, process.execPath);
    assert.equal(launch.args[0], cli);
    assert.equal(launch.options.shell, false);
  }
  for (const lane of CONCURRENT_GATE_LANES) close(lane.name, 0);
  await tick();
  close("ci-shape", 0);
  await gate;
});
