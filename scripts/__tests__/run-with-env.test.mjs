import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";

import { USAGE, parseRunWithEnvArgs, runWithEnv } from "../run-with-env.mjs";

/*
FNXC:WindowsTestScripts 2026-10-08-05:03:
The env wrapper replaces POSIX `VAR=1 cmd` script syntax, which cmd.exe rejects; it must set the variables, never use a shell, and mirror the child's exit status and signals.
*/

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function fakeProc() {
  const proc = new EventEmitter();
  proc.pid = 9999;
  proc.exits = [];
  proc.kills = [];
  proc.exit = (code) => proc.exits.push(code);
  proc.kill = (pid, signal) => proc.kills.push([pid, signal]);
  return proc;
}

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = [];
  child.kill = (signal) => child.killed.push(signal);
  return child;
}

function run(argv, { env = { PARENT: "p" } } = {}) {
  const proc = fakeProc();
  const child = fakeChild();
  const spawned = [];
  const resolved = [];
  const errors = [];
  runWithEnv({
    argv,
    env,
    proc,
    errorLog: (m) => errors.push(m),
    resolve: (command, args, options) => { resolved.push({ command, args, options }); return { command, args, windowsVerbatimArguments: false }; },
    spawnChild: (command, args, options) => { spawned.push({ command, args, options }); return child; },
  });
  return { proc, child, spawned, resolved, errors };
}

test("parses assignments, values containing '=', duplicate keys and forwarded args", () => {
  assert.deepEqual(parseRunWithEnvArgs(["A=1", "B=x=y", "A=2", "--", "cmd", "--flag", "--", "rest"]), {
    assignments: { A: "2", B: "x=y" },
    command: "cmd",
    args: ["--flag", "--", "rest"],
  });
  assert.deepEqual(parseRunWithEnvArgs(["EMPTY=", "--", "cmd"]).assignments, { EMPTY: "" });
});

test("rejects malformed input with the usage line", () => {
  for (const argv of [["A=1", "cmd"], ["A=1", "--"], ["--", "cmd"], ["1BAD=x", "--", "cmd"], ["NOEQ", "--", "cmd"]]) {
    assert.throws(() => parseRunWithEnvArgs(argv), (err) => err.message.includes(USAGE), JSON.stringify(argv));
  }
});

test("a usage error exits 2 without spawning", () => {
  const { proc, spawned, errors } = run(["A=1", "cmd"]);
  assert.deepEqual(proc.exits, [2]);
  assert.equal(spawned.length, 0);
  assert.match(errors[0], /^\[run-with-env\]/);
});

test("spawns shell-free with the merged env, which the resolver also sees", () => {
  const { spawned, resolved } = run(["X=1", "Y=2", "--", "vitest", "run", "--exclude", "**/a.test.ts"]);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, "vitest");
  assert.deepEqual(spawned[0].args, ["run", "--exclude", "**/a.test.ts"]);
  assert.equal(spawned[0].options.shell, false);
  assert.equal(spawned[0].options.stdio, "inherit");
  assert.equal(spawned[0].options.windowsVerbatimArguments, undefined);
  assert.deepEqual(spawned[0].options.env, { PARENT: "p", X: "1", Y: "2" });
  assert.deepEqual(resolved[0].options.env, { PARENT: "p", X: "1", Y: "2" });
});

test("passes windowsVerbatimArguments through only when the invocation sets it", () => {
  const proc = fakeProc();
  const spawned = [];
  runWithEnv({
    argv: ["X=1", "--", "vitest"],
    env: {},
    proc,
    resolve: () => ({ command: "cmd.exe", args: ["/d", "/s", "/c", "\"vitest.cmd\""], windowsVerbatimArguments: true }),
    spawnChild: (command, args, options) => { spawned.push(options); return fakeChild(); },
  });
  assert.equal(spawned[0].windowsVerbatimArguments, true);
  assert.equal(spawned[0].shell, false);
});

test("propagates the child's exit code", () => {
  const { proc, child } = run(["X=1", "--", "cmd"]);
  child.emit("close", 3, null);
  assert.deepEqual(proc.exits, [3]);
  assert.equal(proc.listenerCount("SIGINT"), 0);
});

test("re-raises the child's terminating signal after detaching forwarders", () => {
  const { proc, child } = run(["X=1", "--", "cmd"]);
  child.emit("close", null, "SIGTERM");
  assert.deepEqual(proc.kills, [[9999, "SIGTERM"]]);
  assert.deepEqual(proc.exits, []);
  assert.equal(proc.listenerCount("SIGTERM"), 0);
});

test("a spawn error exits 1", () => {
  const { proc, child, errors } = run(["X=1", "--", "missing-cmd"]);
  child.emit("error", new Error("spawn missing-cmd ENOENT"));
  assert.deepEqual(proc.exits, [1]);
  assert.match(errors[0], /\[run-with-env\].*ENOENT/);
});

test("forwards signals to a running child", () => {
  const { proc, child } = run(["X=1", "--", "cmd"]);
  proc.emit("SIGINT");
  assert.deepEqual(child.killed, ["SIGINT"]);
  child.exitCode = 130;
  proc.emit("SIGTERM");
  assert.deepEqual(child.killed, ["SIGINT"], "an exited child is not signalled again");
});

test("the real wrapper sets the variable for a real child on the host OS", () => {
  const result = spawnSync(process.execPath, [
    "scripts/run-with-env.mjs",
    "KB037_PROBE=ok",
    "--",
    process.execPath,
    "-e",
    "process.exit(process.env.KB037_PROBE==='ok'?0:7)",
  ], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
