import { afterEach, describe, expect, it, vi } from "vitest";

import {
  filesystemRetryPolicyFor,
  isBenignAbsentRemovalError,
  isRetryableRemovalError,
  removeDirectoryWithRetry,
  retryTransientFilesystemOperation,
} from "../worktree/worktree-removal-retry.js";

function codedError(code: string, message = code): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("removeDirectoryWithRetry", () => {
  it("retries transient EBUSY failures with injected backoff", async () => {
    const rm = vi.fn()
      .mockRejectedValueOnce(codedError("EBUSY"))
      .mockRejectedValueOnce(codedError("EBUSY"))
      .mockResolvedValueOnce(undefined);
    const sleep = vi.fn();

    await expect(removeDirectoryWithRetry({ path: "/clean-room", rm, sleep, backoffMs: 1 })).resolves.toMatchObject({ removed: true, attempts: 3, benignAbsent: false });
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("clears Windows read-only attributes before retrying EPERM", async () => {
    const rm = vi.fn().mockRejectedValueOnce(codedError("EPERM")).mockResolvedValueOnce(undefined);
    const chmod = vi.fn().mockResolvedValue(undefined);

    await expect(removeDirectoryWithRetry({ path: "/clean-room", rm, chmod, sleep: vi.fn(), platform: "win32" })).resolves.toMatchObject({ removed: true, attempts: 2 });
    expect(chmod).toHaveBeenCalledWith("/clean-room", 0o700);
  });

  it("reports a residual path after exhausting the configured retry budget", async () => {
    const rm = vi.fn().mockRejectedValue(codedError("EBUSY", "busy"));

    await expect(removeDirectoryWithRetry({ path: "/clean-room", rm, sleep: vi.fn(), attempts: 3 })).resolves.toMatchObject({ removed: false, attempts: 3, lastCode: "EBUSY" });
    expect(rm).toHaveBeenCalledTimes(3);
  });

  it("treats ENOENT as a one-attempt idempotent removal", async () => {
    const rm = vi.fn().mockRejectedValue(codedError("ENOENT"));

    await expect(removeDirectoryWithRetry({ path: "/missing", rm, sleep: vi.fn() })).resolves.toMatchObject({ removed: true, benignAbsent: true, attempts: 1 });
    expect(rm).toHaveBeenCalledTimes(1);
  });

  it("does not clear attributes on Linux while still retrying errno failures", async () => {
    const rm = vi.fn().mockRejectedValueOnce(codedError("EPERM")).mockResolvedValueOnce(undefined);
    const chmod = vi.fn();

    await removeDirectoryWithRetry({ path: "/clean-room", rm, chmod, sleep: vi.fn(), platform: "linux" });
    expect(chmod).not.toHaveBeenCalled();
  });

  it("keeps stale-registration and transient filesystem classifiers distinct", () => {
    const staleRegistration = Object.assign(new Error("git failed"), { stderr: "fatal: '/clean-room' is not a working tree" });
    expect(isBenignAbsentRemovalError(staleRegistration)).toBe(true);
    expect(isBenignAbsentRemovalError(codedError("ENOENT"))).toBe(true);
    for (const code of ["EBUSY", "EPERM", "ENOTEMPTY"]) {
      expect(isBenignAbsentRemovalError(codedError(code))).toBe(false);
      expect(isRetryableRemovalError(codedError(code))).toBe(true);
    }
  });
});

/*
FNXC:WorktreeCleanup 2026-10-07-15:11:
Windows can hold a deleted checkout's handles for seconds (antivirus, indexer, exiting agent children),
so the former ~1s retry window left residue on every AI merge. Win32 now waits up to ~10s with
exponential backoff while POSIX stays at its ~1s window; sleeps are injected or faked, never real.
*/
describe("removeDirectoryWithRetry platform budgets", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps retrying EBUSY across the longer Windows budget and then succeeds", async () => {
    const rm = vi.fn();
    for (let i = 0; i < 7; i++) rm.mockRejectedValueOnce(codedError("EBUSY"));
    rm.mockResolvedValueOnce(undefined);
    const delays: number[] = [];

    await expect(removeDirectoryWithRetry({ path: "/clean-room", rm, sleep: (ms) => { delays.push(ms); }, platform: "win32", chmod: vi.fn() }))
      .resolves.toMatchObject({ removed: true, attempts: 8 });
    expect(delays).toEqual([100, 200, 400, 800, 1600, 2000, 2000]);
  });

  it("exhausts a bounded Windows budget on persistent ENOTEMPTY and reports the residue", async () => {
    const rm = vi.fn().mockRejectedValue(codedError("ENOTEMPTY", "Directory not empty"));
    const delays: number[] = [];

    const result = await removeDirectoryWithRetry({ path: "/clean-room", rm, sleep: (ms) => { delays.push(ms); }, platform: "win32" });

    expect(result).toMatchObject({ removed: false, lastCode: "ENOTEMPTY", attempts: rm.mock.calls.length });
    const waited = delays.reduce((sum, ms) => sum + ms, 0);
    expect(waited).toBeLessThanOrEqual(filesystemRetryPolicyFor("win32").budgetMs);
    expect(waited).toBeGreaterThan(filesystemRetryPolicyFor("linux").budgetMs * 5);
  });

  it("keeps the POSIX window short", async () => {
    const rm = vi.fn().mockRejectedValue(codedError("EBUSY"));
    const delays: number[] = [];

    await expect(removeDirectoryWithRetry({ path: "/clean-room", rm, sleep: (ms) => { delays.push(ms); }, platform: "linux" }))
      .resolves.toMatchObject({ removed: false, attempts: 5 });
    expect(delays.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(1_100);
  });

  it("waits on timers rather than spinning when no sleep is injected", async () => {
    vi.useFakeTimers();
    const rm = vi.fn()
      .mockRejectedValueOnce(codedError("EBUSY"))
      .mockRejectedValueOnce(codedError("EBUSY"))
      .mockResolvedValueOnce(undefined);
    let settled = false;
    const pending = removeDirectoryWithRetry({ path: "/clean-room", rm, platform: "win32", chmod: vi.fn() }).finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(201);
    await expect(pending).resolves.toMatchObject({ removed: true, attempts: 3 });
  });
});

describe("retryTransientFilesystemOperation", () => {
  it("retries only classified errors and returns the final value", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(codedError("EPERM"))
      .mockResolvedValueOnce("renamed");

    await expect(retryTransientFilesystemOperation({ operation, isRetryable: isRetryableRemovalError, sleep: vi.fn(), platform: "win32" }))
      .resolves.toEqual({ ok: true, value: "renamed", attempts: 2 });
  });

  it("stops immediately on a non-retryable error", async () => {
    const exdev = codedError("EXDEV");
    const operation = vi.fn().mockRejectedValue(exdev);

    await expect(retryTransientFilesystemOperation({ operation, isRetryable: isRetryableRemovalError, sleep: vi.fn(), platform: "win32" }))
      .resolves.toEqual({ ok: false, error: exdev, attempts: 1 });
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
