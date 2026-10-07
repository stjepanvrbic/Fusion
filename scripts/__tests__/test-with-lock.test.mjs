import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createTestLock, runLocked } from "../test-with-lock.mjs";
import { resolveCommandInvocation } from "../lib/pnpm-invocation.mjs";

/*
FNXC:TestLockOwnership 2026-10-07-18:03:
Mutual exclusion must survive cancellation: a cancelled waiter never removes the holder's lock, release is owner-only and idempotent, and a holder releases only after its test child exits.
*/

function lockDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "test-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { lockFile: path.join(dir, "test.lock"), metaFile: path.join(dir, "test.lock.meta") };
}

/** A process double that records handlers and turns exit() into a resolved promise. */
function fakeProc() {
  const proc = new EventEmitter();
  let resolveExit;
  proc.exited = new Promise((resolve) => { resolveExit = resolve; });
  proc.exit = (code) => resolveExit(code);
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

test("a cancelled waiter exits without touching the holder's lock or metadata", async (t) => {
  const files = lockDir(t);
  const holder = createTestLock({ ...files, platform: "linux", pid: 101, token: "holder" });
  assert.equal(holder.tryAcquire(), true);
  const holderLock = readFileSync(files.lockFile, "utf8");
  const holderMeta = readFileSync(files.metaFile, "utf8");

  const proc = fakeProc();
  const waiter = createTestLock({ ...files, platform: "linux", pid: 202, token: "waiter" });
  const spawned = [];
  void runLocked({
    lock: waiter,
    proc,
    log: () => {},
    spawnChild: (...call) => { spawned.push(call); return fakeChild(); },
    sleep: async () => { proc.emit("SIGINT"); await new Promise(() => {}); },
  });

  assert.equal(await proc.exited, 130);
  proc.emit("exit");
  assert.equal(readFileSync(files.lockFile, "utf8"), holderLock, "the holder's lock file must survive");
  assert.equal(readFileSync(files.metaFile, "utf8"), holderMeta, "the holder's metadata must survive");
  assert.equal(waiter.release(), false, "a handle that never acquired releases nothing");
  assert.deepEqual(spawned, []);
  assert.equal(holder.release(), true);
  assert.equal(existsSync(files.lockFile), false);
});

test("release is idempotent and never removes a successor's lock", (t) => {
  const files = lockDir(t);
  const first = createTestLock({ ...files, platform: "linux", pid: 1, token: "first" });
  assert.equal(first.tryAcquire(), true);
  assert.equal(first.release(), true);
  assert.equal(existsSync(files.lockFile), false);

  const successor = createTestLock({ ...files, platform: "linux", pid: 2, token: "successor" });
  assert.equal(successor.tryAcquire(), true);
  assert.equal(first.release(), false);
  assert.equal(first.tryAcquire(), false, "the first handle cannot steal the successor's lock");
  assert.match(readFileSync(files.lockFile, "utf8"), /successor$/);
  assert.match(readFileSync(files.metaFile, "utf8"), /successor$/);
});

test("release leaves a lock file that no longer carries this acquisition's token", (t) => {
  const files = lockDir(t);
  const lock = createTestLock({ ...files, platform: "win32", pid: 3, token: "mine" });
  assert.equal(lock.tryAcquire(), true);
  rmSync(files.lockFile);
  const other = createTestLock({ ...files, platform: "win32", pid: 4, token: "theirs" });
  assert.equal(other.tryAcquire(), true);
  assert.equal(lock.release(), true);
  assert.match(readFileSync(files.lockFile, "utf8"), /theirs$/);
});

test("a waiter acquires once the holder releases, then runs the resolved pnpm test:full", async (t) => {
  const files = lockDir(t);
  const holder = createTestLock({ ...files, platform: "linux", pid: 10, token: "holder" });
  assert.equal(holder.tryAcquire(), true);

  const proc = fakeProc();
  const waiter = createTestLock({ ...files, platform: "linux", pid: 20, token: "waiter" });
  const child = fakeChild();
  const spawned = [];
  const logs = [];
  await runLocked({
    lock: waiter,
    args: ["--filter", "@fusion/core"],
    proc,
    log: (m) => logs.push(m),
    spawnChild: (command, args, options) => { spawned.push({ command, args, options }); return child; },
    sleep: async () => { holder.release(); },
  });

  const expected = resolveCommandInvocation("pnpm", ["test:full", "--filter", "@fusion/core"]);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, expected.command);
  assert.deepEqual(spawned[0].args, expected.args);
  assert.equal(spawned[0].options.shell, false);
  assert.match(logs[0], /waiting for test lock held by PID 10/);
  assert.match(readFileSync(files.lockFile, "utf8"), /waiter$/);

  child.emit("close", 0);
  assert.equal(await proc.exited, 0);
  assert.equal(existsSync(files.lockFile), false);
});

test("a signalled holder forwards the signal and keeps the lock until its child exits", async (t) => {
  const files = lockDir(t);
  const proc = fakeProc();
  const lock = createTestLock({ ...files, platform: "linux", pid: 30, token: "holder" });
  const child = fakeChild();
  await runLocked({ lock, proc, log: () => {}, spawnChild: () => child, sleep: async () => {} });

  proc.emit("SIGTERM");
  assert.deepEqual(child.killed, ["SIGTERM"]);
  assert.equal(existsSync(files.lockFile), true, "the lock is held while the test child is still running");

  child.exitCode = 143;
  child.emit("close", 143);
  assert.equal(await proc.exited, 143);
  assert.equal(existsSync(files.lockFile), false);
  assert.equal(proc.listenerCount("SIGTERM"), 0);
});

test("a spawn error releases the lock and exits nonzero", async (t) => {
  const files = lockDir(t);
  const proc = fakeProc();
  const errors = [];
  const lock = createTestLock({ ...files, platform: "linux", pid: 40, token: "holder" });
  const child = fakeChild();
  await runLocked({ lock, proc, log: () => {}, errorLog: (m) => errors.push(m), spawnChild: () => child, sleep: async () => {} });
  child.emit("error", new Error("spawn pnpm ENOENT"));
  assert.equal(await proc.exited, 1);
  assert.match(errors[0], /spawn pnpm ENOENT/);
  assert.equal(existsSync(files.lockFile), false);
});

test("macOS keeps the persistent lock file and releases by closing its flock fd", () => {
  const calls = [];
  const files = new Map();
  const fsImpl = {
    constants: { O_CREAT: 0x200, O_RDWR: 0x2, O_NONBLOCK: 0x4, O_EXCL: 0x800 },
    mkdirSync: () => {},
    openSync: (file, flags) => { calls.push(["open", file, flags]); return 7; },
    writeFileSync: (file, data) => { files.set(file, data); },
    readFileSync: (file) => { if (!files.has(file)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return files.get(file); },
    unlinkSync: (file) => { calls.push(["unlink", file]); files.delete(file); },
    closeSync: (fd) => calls.push(["close", fd]),
  };
  const lock = createTestLock({ lockFile: "/l/test.lock", metaFile: "/l/test.lock.meta", fsImpl, platform: "darwin", pid: 5, token: "mac" });
  assert.equal(lock.tryAcquire(), true);
  assert.equal(calls[0][2] & 0x20, 0x20, "macOS opens with O_EXLOCK");
  assert.equal(lock.release(), true);
  assert.deepEqual(calls.slice(1), [["unlink", "/l/test.lock.meta"], ["close", 7]]);
  assert.equal(lock.release(), false);
});
