#!/usr/bin/env node
/**
 * test-with-lock.mjs
 *
 * Serializes `pnpm test:full` across concurrent git-worktree agent sessions so
 * multiple Claude Code instances don't saturate the machine with vitest forks.
 *
 * Acquires an exclusive lock at ~/.fusion/test.lock before running the
 * underlying test command, then releases it on exit. macOS uses an O_EXLOCK
 * file lock; Linux and Windows use an atomic O_CREAT|O_EXCL create. While
 * waiting it prints the PID and worktree path of the lock holder and the lock
 * file path so the developer knows who is blocking.
 *
 * Stale locks: on Linux and Windows a runner killed with SIGKILL leaves its
 * lock file behind. A waiter reclaims it only when the recorded runner PID and
 * the recorded test-child PID are both dead, under a `test.lock.reclaim` guard,
 * and deletes only the exact record it judged dead.
 *
 * Usage:  pnpm test:locked [extra args passed to pnpm test:full]
 * e.g.:   pnpm test:locked --filter @fusion/core
 */

/*
FNXC:TestLockOwnership 2026-10-07-18:03:
The lock must stay mutually exclusive across cancellation. A waiter that receives Ctrl-C must exit without touching the holder's lock or metadata; before, its signal handler unlinked the lock file and the meta file unconditionally, so a third runner could start a second full suite while the first was still running.
Release is owner-only and idempotent: only the acquisition that created the lock removes it, after checking the lock file still carries its own token.
A holder that is signalled while its test child runs forwards the signal and releases only after the child has exited.

FNXC:TestLockOwnership 2026-10-08-05:12:
SIGKILL bypasses the signal handlers, so an O_EXCL lock file can outlive its runner and every later `pnpm test:locked` waited forever.
A lock is reclaimable only when the runner AND its recorded test child are both dead; the child PID is recorded as a fourth line once spawned, so a second suite never starts beside an orphaned `pnpm test:full`.
An unparseable lock (creator between create and write, or died before writing) is reclaimable only after a grace period; a parseable record is never reclaimed by age alone.
Reclaim runs under an exclusive `.reclaim` guard and deletes only the exact record it judged dead, so two waiters cannot both reclaim and neither can delete a fresh successor's lock.
A guard left by a dead waiter is removed (only if unchanged) and the reclaim retried on a later poll.
Known limit: PID reuse makes a dead owner look alive, so the waiter keeps waiting, which is the safe direction; the waiting message names the lock path so a human can remove it.
macOS keeps O_EXLOCK, whose flock the kernel drops on process death, so no reclaim runs there.
*/

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import { isEntryPoint } from "./lib/is-entry-point.mjs";
import { describeSpawnFailure, resolveCommandInvocation } from "./lib/pnpm-invocation.mjs";

const POLL_MS = 1_500;
// O_EXLOCK is a BSD/Darwin extension; value 0x20 on macOS.
const O_EXLOCK = 0x20;
const MALFORMED_GRACE_MS = 30_000;

/**
 * Whether `pid` names a live process. Errors other than ESRCH count as alive, so an unknown state never triggers a reclaim.
 *
 * @param {number} pid
 * @param {{ kill?: (pid: number, signal: number) => unknown }} [options]
 * @returns {boolean}
 */
export function isProcessAlive(pid, { kill = process.kill } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== "ESRCH";
  }
}

/**
 * Parse an owner record `pid\ncwd\ntoken[\nchildPid]`.
 *
 * @param {string} text
 * @returns {{ pid: number, worktree: string, token: string, childPid: number | null } | null}
 */
export function parseLockRecord(text) {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n");
  if (lines.length < 3) return null;
  const pid = Number(lines[0]);
  const token = lines[2].trim();
  if (!Number.isInteger(pid) || pid <= 0 || token === "") return null;
  const childPid = lines.length > 3 && /^\d+$/.test(lines[3].trim()) ? Number(lines[3].trim()) : null;
  return { pid, worktree: lines[1] || "(unknown)", token, childPid: childPid && childPid > 0 ? childPid : null };
}

/**
 * Create one lock handle. Each handle represents at most one acquisition.
 *
 * @param {{
 *   lockFile: string,
 *   metaFile: string,
 *   fsImpl?: typeof fs,
 *   platform?: NodeJS.Platform,
 *   pid?: number,
 *   cwd?: string,
 *   token?: string,
 *   isProcessAlive?: (pid: number) => boolean,
 *   now?: () => number,
 *   malformedGraceMs?: number,
 * }} options
 */
export function createTestLock({
  lockFile,
  metaFile,
  fsImpl = fs,
  platform = process.platform,
  pid = process.pid,
  cwd = process.cwd(),
  token = randomUUID(),
  isProcessAlive: alive = (candidate) => isProcessAlive(candidate),
  now = Date.now,
  malformedGraceMs = MALFORMED_GRACE_MS,
}) {
  const isMacOS = platform === "darwin";
  const guardFile = `${lockFile}.reclaim`;
  let ownerRecord = `${pid}\n${cwd}\n${token}`;
  let lockFd = -1;
  let owned = false;
  let lastReclaimInfo = null;

  function readOrNull(file) {
    try {
      return fsImpl.readFileSync(file, "utf8");
    } catch (err) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
  }

  function readHolder() {
    try {
      const record = parseLockRecord(fsImpl.readFileSync(metaFile, "utf8").trim());
      return record ? { pid: record.pid, worktree: record.worktree } : null;
    } catch {
      return null;
    }
  }

  /** Whether `file`'s mtime is older than the malformed-content grace period. Missing counts as old. */
  function olderThanGrace(file) {
    try {
      return now() - fsImpl.statSync(file).mtimeMs > malformedGraceMs;
    } catch {
      return true;
    }
  }

  /** Remove a guard left by a dead or never-finished waiter, only if its content is unchanged. */
  function clearDeadGuard() {
    const guardText = readOrNull(guardFile);
    if (guardText === null) return;
    const [guardPidText, guardToken] = guardText.replace(/\r/g, "").split("\n");
    const guardPid = Number(guardPidText);
    const parseable = Number.isInteger(guardPid) && guardPid > 0 && Boolean(guardToken);
    const dead = parseable ? !alive(guardPid) : olderThanGrace(guardFile);
    if (!dead) return;
    if (readOrNull(guardFile) === guardText) {
      try { fsImpl.unlinkSync(guardFile); } catch { /* already gone */ }
    }
  }

  /**
   * Remove the lock when its owner is provably dead.
   * Returns "gone" when no lock exists, "reclaimed" after removing a dead lock, or false when the lock must be left alone.
   */
  function reclaimIfStale() {
    const observed = readOrNull(lockFile);
    if (observed === null) return "gone";
    const record = parseLockRecord(observed);
    const stale = record
      ? !alive(record.pid) && (record.childPid === null || !alive(record.childPid))
      : olderThanGrace(lockFile);
    if (!stale) return false;

    const guardRecord = `${pid}\n${token}`;
    let guardFd;
    try {
      guardFd = fsImpl.openSync(guardFile, fsImpl.constants.O_CREAT | fsImpl.constants.O_EXCL | fsImpl.constants.O_RDWR);
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      // Another waiter is reclaiming; back off this poll, clearing its guard only if that waiter is dead.
      clearDeadGuard();
      return false;
    }
    try {
      fsImpl.writeFileSync(guardFd, guardRecord, "utf8");
      const current = readOrNull(lockFile);
      if (current === null) return "gone";
      if (current !== observed) return false;
      try { fsImpl.unlinkSync(lockFile); } catch { /* already gone */ }
      if (readOrNull(metaFile) === observed) {
        try { fsImpl.unlinkSync(metaFile); } catch { /* already gone */ }
      }
      lastReclaimInfo = record ? { pid: record.pid, worktree: record.worktree } : { pid: null, worktree: "(unknown)" };
      return "reclaimed";
    } finally {
      try { fsImpl.closeSync(guardFd); } catch { /* ignore */ }
      if (readOrNull(guardFile) === guardRecord) {
        try { fsImpl.unlinkSync(guardFile); } catch { /* already gone */ }
      }
    }
  }

  function openLock() {
    return isMacOS
      ? fsImpl.openSync(lockFile, fsImpl.constants.O_CREAT | fsImpl.constants.O_RDWR | O_EXLOCK | fsImpl.constants.O_NONBLOCK)
      : fsImpl.openSync(lockFile, fsImpl.constants.O_CREAT | fsImpl.constants.O_EXCL | fsImpl.constants.O_RDWR);
  }

  function isContention(err) {
    return err?.code === "EEXIST" || err?.code === "EWOULDBLOCK" || err?.code === "EAGAIN";
  }

  /** Try once to take the lock. Returns true only when THIS handle now owns it. */
  function tryAcquire() {
    if (owned) return true;
    fsImpl.mkdirSync(path.dirname(lockFile), { recursive: true });
    lastReclaimInfo = null;
    try {
      lockFd = openLock();
    } catch (err) {
      if (!isContention(err)) throw err;
      if (isMacOS) return false;
      let reclaim;
      try {
        reclaim = reclaimIfStale();
      } catch {
        // An unreadable lock or guard is never proof of a dead owner; keep waiting.
        reclaim = false;
      }
      if (!reclaim) return false;
      try {
        lockFd = openLock();
      } catch (retryErr) {
        if (isContention(retryErr)) {
          // Another waiter won the freed lock; the reclaim is not ours to report.
          lastReclaimInfo = null;
          return false;
        }
        throw retryErr;
      }
    }
    owned = true;
    if (!isMacOS) fsImpl.writeFileSync(lockFd, ownerRecord, "utf8");
    fsImpl.writeFileSync(metaFile, ownerRecord, "utf8");
    return true;
  }

  function stillOurs(file) {
    try {
      return fsImpl.readFileSync(file, "utf8") === ownerRecord;
    } catch {
      return false;
    }
  }

  /** Extend the owner record with the test child's PID so a SIGKILLed runner's live child still holds the lock. */
  function recordChild(childPid) {
    if (!owned || !Number.isInteger(childPid) || childPid <= 0) return false;
    const next = `${pid}\n${cwd}\n${token}\n${childPid}`;
    if (!isMacOS && lockFd >= 0 && stillOurs(lockFile)) {
      // Rewrite through the held fd so the lock inode never changes.
      fsImpl.writeSync(lockFd, next, 0, "utf8");
      fsImpl.ftruncateSync(lockFd, Buffer.byteLength(next, "utf8"));
    }
    if (stillOurs(metaFile)) fsImpl.writeFileSync(metaFile, next, "utf8");
    ownerRecord = next;
    return true;
  }

  /** Release this handle's acquisition. A no-op when it never acquired or already released. */
  function release() {
    if (!owned) return false;
    owned = false;
    // Remove only what this acquisition wrote; close the fd last so the macOS flock covers the cleanup.
    if (!isMacOS && stillOurs(lockFile)) {
      try { fsImpl.unlinkSync(lockFile); } catch { /* already gone */ }
    }
    if (stillOurs(metaFile)) {
      try { fsImpl.unlinkSync(metaFile); } catch { /* already gone */ }
    }
    if (lockFd >= 0) {
      try { fsImpl.closeSync(lockFd); } catch { /* ignore */ }
      lockFd = -1;
    }
    return true;
  }

  return {
    tryAcquire,
    release,
    readHolder,
    recordChild,
    lastReclaim: () => lastReclaimInfo,
    isOwned: () => owned,
    lockFile,
  };
}

/**
 * Wait for the lock, run the test child, and exit with its status.
 *
 * @param {{
 *   lock: ReturnType<typeof createTestLock>,
 *   args?: string[],
 *   spawnChild?: (command: string, args: string[], options: object) => import("node:child_process").ChildProcess,
 *   proc?: Pick<NodeJS.Process, "on" | "removeListener" | "exit">,
 *   log?: (message: string) => void,
 *   errorLog?: (message: string) => void,
 *   sleep?: (ms: number) => Promise<void>,
 *   pollMs?: number,
 * }} options
 */
export async function runLocked({
  lock,
  args = [],
  spawnChild = spawn,
  proc = process,
  log = console.log,
  errorLog = console.error,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollMs = POLL_MS,
}) {
  let child = null;
  let finished = false;

  const onExit = () => lock.release();
  const signalHandlers = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => {
    const handler = () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        // The holder keeps the lock until its child has actually exited; the close handler releases.
        try { child.kill(signal); } catch { /* already gone */ }
        return;
      }
      // A waiter, or a holder whose child already exited: release only what we own, then exit.
      lock.release();
      proc.exit(signal === "SIGINT" ? 130 : 1);
    };
    proc.on(signal, handler);
    return [signal, handler];
  });
  proc.on("exit", onExit);

  const finish = (code) => {
    if (finished) return;
    finished = true;
    lock.release();
    for (const [signal, handler] of signalHandlers) proc.removeListener(signal, handler);
    proc.removeListener("exit", onExit);
    proc.exit(code);
  };

  let waited = false;
  while (!lock.tryAcquire()) {
    if (!waited) {
      const holder = lock.readHolder();
      const where = lock.lockFile ? ` (lock file: ${lock.lockFile})` : "";
      log(holder
        ? `[test-with-lock] waiting for test lock held by PID ${holder.pid} (worktree: ${holder.worktree})${where}`
        : `[test-with-lock] waiting for test lock…${where}`);
      waited = true;
    }
    await sleep(pollMs);
  }
  const reclaimed = lock.lastReclaim?.();
  if (reclaimed) {
    log(`[test-with-lock] reclaimed stale test lock from dead PID ${reclaimed.pid ?? "(unknown)"} (worktree: ${reclaimed.worktree})`);
  }
  if (waited) log("[test-with-lock] lock acquired, starting tests.");

  const invocation = resolveCommandInvocation("pnpm", ["test:full", ...args]);
  try {
    child = spawnChild(invocation.command, invocation.args, {
      stdio: "inherit",
      shell: false,
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
  } catch (err) {
    errorLog(`[test-with-lock] failed to spawn pnpm: ${err?.message ?? err}`);
    finish(1);
    return;
  }
  if (Number.isInteger(child?.pid) && child.pid > 0) lock.recordChild(child.pid);
  child.on("close", (code) => finish(code ?? 1));
  child.on("error", (err) => {
    errorLog(`[test-with-lock] failed to spawn pnpm: ${describeSpawnFailure({ status: null, error: err })}`);
    finish(1);
  });
}

if (isEntryPoint(import.meta.url)) {
  const lockDir = path.join(os.homedir(), ".fusion");
  await runLocked({
    lock: createTestLock({ lockFile: path.join(lockDir, "test.lock"), metaFile: path.join(lockDir, "test.lock.meta") }),
    args: process.argv.slice(2),
  });
}
