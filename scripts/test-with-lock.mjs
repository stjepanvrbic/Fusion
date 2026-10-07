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
 * waiting it prints the PID and worktree path of the lock holder so the
 * developer knows who is blocking.
 *
 * Usage:  pnpm test:locked [extra args passed to pnpm test:full]
 * e.g.:   pnpm test:locked --filter @fusion/core
 */

/*
FNXC:TestLockOwnership 2026-10-07-18:03:
The lock must stay mutually exclusive across cancellation. A waiter that receives Ctrl-C must exit without touching the holder's lock or metadata; before, its signal handler unlinked the lock file and the meta file unconditionally, so a third runner could start a second full suite while the first was still running.
Release is owner-only and idempotent: only the acquisition that created the lock removes it, after checking the lock file still carries its own token.
A holder that is signalled while its test child runs forwards the signal and releases only after the child has exited.
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
 * }} options
 */
export function createTestLock({ lockFile, metaFile, fsImpl = fs, platform = process.platform, pid = process.pid, cwd = process.cwd(), token = randomUUID() }) {
  const isMacOS = platform === "darwin";
  const ownerRecord = `${pid}\n${cwd}\n${token}`;
  let lockFd = -1;
  let owned = false;

  function readHolder() {
    try {
      const [pidStr, ...rest] = fsImpl.readFileSync(metaFile, "utf8").trim().split("\n");
      return { pid: Number(pidStr), worktree: rest[0] || "(unknown)" };
    } catch {
      return null;
    }
  }

  /** Try once to take the lock. Returns true only when THIS handle now owns it. */
  function tryAcquire() {
    if (owned) return true;
    fsImpl.mkdirSync(path.dirname(lockFile), { recursive: true });
    try {
      lockFd = isMacOS
        ? fsImpl.openSync(lockFile, fsImpl.constants.O_CREAT | fsImpl.constants.O_RDWR | O_EXLOCK | fsImpl.constants.O_NONBLOCK)
        : fsImpl.openSync(lockFile, fsImpl.constants.O_CREAT | fsImpl.constants.O_EXCL | fsImpl.constants.O_RDWR);
    } catch (err) {
      if (err?.code === "EEXIST" || err?.code === "EWOULDBLOCK" || err?.code === "EAGAIN") return false;
      throw err;
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

  return { tryAcquire, release, readHolder, isOwned: () => owned };
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
      log(holder
        ? `[test-with-lock] waiting for test lock held by PID ${holder.pid} (worktree: ${holder.worktree})`
        : "[test-with-lock] waiting for test lock…");
      waited = true;
    }
    await sleep(pollMs);
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
