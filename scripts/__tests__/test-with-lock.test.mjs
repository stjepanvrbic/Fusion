import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { createTestLock, isProcessAlive, parseLockRecord, runLocked } from "../test-with-lock.mjs";
import { resolveCommandInvocation } from "../lib/pnpm-invocation.mjs";

/*
FNXC:TestLockOwnership 2026-10-07-18:03:
Mutual exclusion must survive cancellation: a cancelled waiter never removes the holder's lock, release is owner-only and idempotent, and a holder releases only after its test child exits.

FNXC:TestLockOwnership 2026-10-08-05:12:
A lock whose runner and recorded test child are both dead is reclaimed under a guard; a live owner's lock, or a lock replaced since it was judged dead, is never removed.
The ownership fixtures use fake PIDs that are dead on the host, so they pin the liveness probe to "alive" through liveLock to keep testing ownership rather than reclaim.
*/

/** A lock handle whose owners all look alive, so these cases exercise ownership without dead-owner reclaim. */
function liveLock(options) {
  return createTestLock({ isProcessAlive: () => true, ...options });
}

function writeRecord(files, record) {
  writeFileSync(files.lockFile, record);
  writeFileSync(files.metaFile, record);
}

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
  const holder = liveLock({ ...files, platform: "linux", pid: 101, token: "holder" });
  assert.equal(holder.tryAcquire(), true);
  const holderLock = readFileSync(files.lockFile, "utf8");
  const holderMeta = readFileSync(files.metaFile, "utf8");

  const proc = fakeProc();
  const waiter = liveLock({ ...files, platform: "linux", pid: 202, token: "waiter" });
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
  const first = liveLock({ ...files, platform: "linux", pid: 1, token: "first" });
  assert.equal(first.tryAcquire(), true);
  assert.equal(first.release(), true);
  assert.equal(existsSync(files.lockFile), false);

  const successor = liveLock({ ...files, platform: "linux", pid: 2, token: "successor" });
  assert.equal(successor.tryAcquire(), true);
  assert.equal(first.release(), false);
  assert.equal(first.tryAcquire(), false, "the first handle cannot steal the successor's lock");
  assert.match(readFileSync(files.lockFile, "utf8"), /successor$/);
  assert.match(readFileSync(files.metaFile, "utf8"), /successor$/);
});

test("release leaves a lock file that no longer carries this acquisition's token", (t) => {
  const files = lockDir(t);
  const lock = liveLock({ ...files, platform: "win32", pid: 3, token: "mine" });
  assert.equal(lock.tryAcquire(), true);
  rmSync(files.lockFile);
  const other = liveLock({ ...files, platform: "win32", pid: 4, token: "theirs" });
  assert.equal(other.tryAcquire(), true);
  assert.equal(lock.release(), true);
  assert.match(readFileSync(files.lockFile, "utf8"), /theirs$/);
});

test("a waiter acquires once the holder releases, then runs the resolved pnpm test:full", async (t) => {
  const files = lockDir(t);
  const holder = liveLock({ ...files, platform: "linux", pid: 10, token: "holder" });
  assert.equal(holder.tryAcquire(), true);

  const proc = fakeProc();
  const waiter = liveLock({ ...files, platform: "linux", pid: 20, token: "waiter" });
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
  const lock = liveLock({ ...files, platform: "linux", pid: 30, token: "holder" });
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
  const lock = liveLock({ ...files, platform: "linux", pid: 40, token: "holder" });
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
  const lock = liveLock({ lockFile: "/l/test.lock", metaFile: "/l/test.lock.meta", fsImpl, platform: "darwin", pid: 5, token: "mac" });
  assert.equal(lock.tryAcquire(), true);
  assert.equal(calls[0][2] & 0x20, 0x20, "macOS opens with O_EXLOCK");
  assert.equal(lock.release(), true);
  assert.deepEqual(calls.slice(1), [["unlink", "/l/test.lock.meta"], ["close", 7]]);
  assert.equal(lock.release(), false);
});

test("a dead owner's lock is reclaimed and replaced with this handle's record", (t) => {
  const files = lockDir(t);
  writeRecord(files, "111\n/dead/worktree\ndead-token");
  const lock = createTestLock({ ...files, platform: "linux", pid: 222, token: "fresh", isProcessAlive: () => false });
  assert.equal(lock.tryAcquire(), true);
  assert.match(readFileSync(files.lockFile, "utf8"), /fresh$/);
  assert.match(readFileSync(files.metaFile, "utf8"), /fresh$/);
  assert.deepEqual(lock.lastReclaim(), { pid: 111, worktree: "/dead/worktree" });
  assert.equal(existsSync(`${files.lockFile}.reclaim`), false);
  assert.equal(lock.release(), true);
  assert.equal(existsSync(files.lockFile), false);
  assert.equal(existsSync(files.metaFile), false);
});

test("a live owner's lock is never reclaimed", (t) => {
  const files = lockDir(t);
  writeRecord(files, "111\n/live\nlive-token");
  const lock = createTestLock({ ...files, platform: "linux", pid: 222, token: "fresh", isProcessAlive: () => true });
  assert.equal(lock.tryAcquire(), false);
  assert.equal(readFileSync(files.lockFile, "utf8"), "111\n/live\nlive-token");
  assert.equal(readFileSync(files.metaFile, "utf8"), "111\n/live\nlive-token");
  assert.equal(lock.lastReclaim(), null);
});

test("a dead runner whose recorded test child is alive keeps the lock; both dead reclaims", (t) => {
  const files = lockDir(t);
  writeRecord(files, "111\n/w\ntok\n333");
  const childAlive = createTestLock({ ...files, platform: "linux", pid: 222, token: "a", isProcessAlive: (pid) => pid === 333 });
  assert.equal(childAlive.tryAcquire(), false);
  assert.equal(readFileSync(files.lockFile, "utf8"), "111\n/w\ntok\n333");

  const bothDead = createTestLock({ ...files, platform: "linux", pid: 222, token: "b", isProcessAlive: () => false });
  assert.equal(bothDead.tryAcquire(), true);
  assert.match(readFileSync(files.lockFile, "utf8"), /\nb$/);
});

test("an unparseable lock is reclaimed only after the grace period", (t) => {
  const files = lockDir(t);
  writeFileSync(files.lockFile, "");
  const fresh = createTestLock({ ...files, platform: "linux", pid: 222, token: "a", isProcessAlive: () => false });
  assert.equal(fresh.tryAcquire(), false, "a creator may still be writing its record");
  assert.equal(readFileSync(files.lockFile, "utf8"), "");

  const old = new Date(Date.now() - 60_000);
  utimesSync(files.lockFile, old, old);
  const later = createTestLock({ ...files, platform: "linux", pid: 222, token: "b", isProcessAlive: () => false });
  assert.equal(later.tryAcquire(), true);
  assert.match(readFileSync(files.lockFile, "utf8"), /\nb$/);
});

test("a lock replaced after it was judged dead is not deleted", (t) => {
  const files = lockDir(t);
  const successor = "222\n/successor\nsuccessor-token";
  writeRecord(files, successor);
  let firstRead = true;
  const fsImpl = {
    ...fs,
    readFileSync: (file, ...rest) => {
      if (file === files.lockFile && firstRead) {
        firstRead = false;
        return "111\n/dead\ndead-token";
      }
      return fs.readFileSync(file, ...rest);
    },
  };
  const lock = createTestLock({ ...files, fsImpl, platform: "linux", pid: 333, token: "waiter", isProcessAlive: (pid) => pid === 222 });
  assert.equal(lock.tryAcquire(), false);
  assert.equal(readFileSync(files.lockFile, "utf8"), successor);
  assert.equal(readFileSync(files.metaFile, "utf8"), successor);
  assert.equal(existsSync(`${files.lockFile}.reclaim`), false);
});

test("a live reclaim guard defers reclaim; a dead guard is cleared and reclaim happens next poll", (t) => {
  const files = lockDir(t);
  const guardFile = `${files.lockFile}.reclaim`;
  writeRecord(files, "111\n/dead\ndead-token");
  writeFileSync(guardFile, "777\nother-waiter");
  const lock = createTestLock({ ...files, platform: "linux", pid: 222, token: "mine", isProcessAlive: (pid) => pid === 777 });
  assert.equal(lock.tryAcquire(), false);
  assert.equal(readFileSync(files.lockFile, "utf8"), "111\n/dead\ndead-token");
  assert.equal(readFileSync(guardFile, "utf8"), "777\nother-waiter");

  writeFileSync(guardFile, "888\ndead-waiter");
  assert.equal(lock.tryAcquire(), false, "the dead guard is only cleared on this poll");
  assert.equal(existsSync(guardFile), false);
  assert.equal(readFileSync(files.lockFile, "utf8"), "111\n/dead\ndead-token");
  assert.equal(lock.tryAcquire(), true);
  assert.match(readFileSync(files.lockFile, "utf8"), /mine$/);
  assert.equal(existsSync(guardFile), false);
});

test("isProcessAlive maps kill(pid, 0) outcomes conservatively", () => {
  const throwing = (code) => () => { throw Object.assign(new Error(code), { code }); };
  assert.equal(isProcessAlive(123, { kill: throwing("ESRCH") }), false);
  assert.equal(isProcessAlive(123, { kill: throwing("EPERM") }), true);
  assert.equal(isProcessAlive(123, { kill: throwing("EINVAL") }), true);
  assert.equal(isProcessAlive(123, { kill: () => true }), true);
  assert.equal(isProcessAlive(0, { kill: () => true }), false);
  assert.equal(isProcessAlive(Number.NaN, { kill: () => true }), false);
  assert.equal(isProcessAlive(-5, { kill: () => true }), false);
});

test("parseLockRecord reads the owner record and rejects malformed content", () => {
  assert.deepEqual(parseLockRecord("1\n/w\ntok"), { pid: 1, worktree: "/w", token: "tok", childPid: null });
  assert.deepEqual(parseLockRecord("1\n/w\ntok\n42"), { pid: 1, worktree: "/w", token: "tok", childPid: 42 });
  assert.equal(parseLockRecord(""), null);
  assert.equal(parseLockRecord("1\n/w"), null);
  assert.equal(parseLockRecord("x\n/w\ntok"), null);
  assert.equal(parseLockRecord("1\n/w\n"), null);
});

test("runLocked reclaims a dead lock without waiting and records the test child's PID", async (t) => {
  const files = lockDir(t);
  writeRecord(files, "111\n/dead/worktree\ndead-token");
  const proc = fakeProc();
  const lock = createTestLock({ ...files, platform: "linux", pid: 222, cwd: "/me", token: "mine", isProcessAlive: () => false });
  const child = fakeChild();
  child.pid = 4242;
  const spawned = [];
  const logs = [];
  let slept = false;
  await runLocked({
    lock,
    proc,
    log: (m) => logs.push(m),
    spawnChild: (...call) => { spawned.push(call); return child; },
    sleep: async () => { slept = true; },
  });

  assert.equal(slept, false);
  assert.equal(spawned.length, 1);
  assert.ok(logs.some((m) => /reclaimed stale test lock from dead PID 111 \(worktree: \/dead\/worktree\)/.test(m)), logs.join("\n"));
  assert.equal(readFileSync(files.lockFile, "utf8"), "222\n/me\nmine\n4242");
  assert.equal(readFileSync(files.metaFile, "utf8"), "222\n/me\nmine\n4242");

  child.emit("close", 0);
  assert.equal(await proc.exited, 0);
  assert.equal(existsSync(files.lockFile), false);
  assert.equal(existsSync(files.metaFile), false);
});

test("the waiting message names the lock file", async (t) => {
  const files = lockDir(t);
  const holder = liveLock({ ...files, platform: "linux", pid: 10, token: "holder" });
  assert.equal(holder.tryAcquire(), true);
  const proc = fakeProc();
  const logs = [];
  await runLocked({
    lock: liveLock({ ...files, platform: "linux", pid: 20, token: "waiter" }),
    proc,
    log: (m) => logs.push(m),
    spawnChild: () => fakeChild(),
    sleep: async () => { holder.release(); },
  });
  assert.ok(logs[0].includes(files.lockFile), logs[0]);
});

test("symptom: a lock left by a genuinely dead process is reclaimed with the real liveness probe", async (t) => {
  const files = lockDir(t);
  const victim = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore" });
  const exited = new Promise((resolve) => victim.once("exit", resolve));
  victim.kill("SIGKILL");
  await exited;
  writeRecord(files, `${victim.pid}\n/killed/runner\nkilled-token`);

  const lock = createTestLock({ ...files, platform: "linux", pid: process.pid, token: "survivor" });
  assert.equal(lock.tryAcquire(), true);
  assert.match(readFileSync(files.lockFile, "utf8"), /survivor$/);
  assert.match(readFileSync(files.metaFile, "utf8"), /survivor$/);
  assert.equal(lock.lastReclaim().pid, victim.pid);
  assert.equal(existsSync(`${files.lockFile}.reclaim`), false);
  lock.release();
});

test("macOS never runs the dead-owner reclaim", () => {
  const unlinked = [];
  const record = "111\n/dead\ndead-token";
  const files = new Map([["/l/test.lock", record], ["/l/test.lock.meta", record]]);
  const fsImpl = {
    constants: { O_CREAT: 0x200, O_RDWR: 0x2, O_NONBLOCK: 0x4, O_EXCL: 0x800 },
    mkdirSync: () => {},
    openSync: () => { throw Object.assign(new Error("EWOULDBLOCK"), { code: "EWOULDBLOCK" }); },
    writeFileSync: (file, data) => { files.set(file, data); },
    readFileSync: (file) => { if (!files.has(file)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return files.get(file); },
    unlinkSync: (file) => { unlinked.push(file); files.delete(file); },
    closeSync: () => {},
  };
  const lock = createTestLock({ lockFile: "/l/test.lock", metaFile: "/l/test.lock.meta", fsImpl, platform: "darwin", pid: 5, token: "mac", isProcessAlive: () => false });
  assert.equal(lock.tryAcquire(), false);
  assert.deepEqual(unlinked, []);
  assert.equal(lock.lastReclaim(), null);
});
