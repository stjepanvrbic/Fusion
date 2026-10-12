import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => {
  type Response = { stdout: string; stderr?: string } | { error: Error & { code?: string } };
  const state: {
    respond: (args: string[]) => Response;
    topLevel: (cwd: string | undefined) => string | undefined;
  } = {
    respond: () => ({ stdout: "" }),
    topLevel: (cwd) => cwd,
  };
  const execFile = vi.fn((
    _file: string,
    args: string[],
    options: { maxBuffer?: number; cwd?: string },
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    // FNXC:EngineTests 2026-10-12-11:02: by default the fake checkout is its own git top level, as the probes' own-checkout guard requires.
    const response = args[0] === "rev-parse" && args[1] === "--show-toplevel"
      ? { stdout: `${state.topLevel(options.cwd) ?? ""}\n` }
      : state.respond(args);
    if ("error" in response) {
      callback(response.error, "", "");
      return;
    }
    const stdout = response.stdout;
    if (typeof options.maxBuffer === "number" && Buffer.byteLength(stdout) > options.maxBuffer) {
      const error = Object.assign(new Error("stdout maxBuffer length exceeded"), {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      });
      callback(error, "", "");
      return;
    }
    callback(null, stdout, response.stderr ?? "");
  });
  (execFile as unknown as Record<symbol, unknown>)[Symbol.for("nodejs.util.promisify.custom")] = (
    file: string,
    args: string[],
    options: { maxBuffer?: number },
  ) => new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
  return { execFile, state };
});

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: childProcess.execFile,
}));

import {
  computeCodeReviewInputFingerprint,
  EMPTY_REVIEW_DIFF_FINGERPRINT,
  probeReviewChangesSinceCommit,
  probeReviewDiffFingerprint,
  REVIEW_DIFF_GIT_MAX_BUFFER_BYTES,
  REVIEW_DIFF_GIT_TIMEOUT_MS,
} from "../worktree/review-diff-fingerprint.js";
import { probeReviewCheckout } from "../worktree/review-checkout-clean.js";

function isDiffOrChangesCall(call: unknown[]): boolean {
  return (call[1] as string[])[0] !== "rev-parse";
}

describe("review diff fingerprint bounded capture", () => {
  beforeEach(() => {
    childProcess.execFile.mockClear();
    childProcess.state.respond = () => ({ stdout: "" });
    childProcess.state.topLevel = (cwd) => cwd;
  });

  it("captures a two-megabyte binary diff and reuses its stable fingerprint", async () => {
    const diff = `diff --git a/large.bin b/large.bin\n${"x".repeat(2 * 1024 * 1024)}`;
    childProcess.state.respond = () => ({ stdout: diff });
    const expected = createHash("sha256").update(diff).digest("hex");

    await expect(probeReviewDiffFingerprint("/worktree", "base")).resolves.toEqual({
      state: "fingerprint",
      fingerprint: expected,
    });
    await expect(computeCodeReviewInputFingerprint("/worktree", "base")).resolves.toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    expect(childProcess.execFile).toHaveBeenCalledWith(
      "git",
      ["diff", "--binary", "base..HEAD"],
      expect.objectContaining({
        maxBuffer: REVIEW_DIFF_GIT_MAX_BUFFER_BYTES,
        timeout: REVIEW_DIFF_GIT_TIMEOUT_MS,
      }),
      expect.any(Function),
    );
  });

  it("names a diff that exceeds the explicit ten-megabyte bound", async () => {
    childProcess.state.respond = () => ({ stdout: "x".repeat(REVIEW_DIFF_GIT_MAX_BUFFER_BYTES + 1) });
    await expect(probeReviewDiffFingerprint("/worktree", "base")).resolves.toEqual({
      state: "unavailable",
      reason: "git-diff-too-large",
    });
  });

  it("keeps arbitrary child-process failures distinct from overflow", async () => {
    childProcess.state.respond = () => ({ error: new Error("spawn failed") });
    await expect(probeReviewDiffFingerprint("/worktree", "base")).resolves.toEqual({
      state: "unavailable",
      reason: "git-diff-failed",
    });
  });

  it("preserves empty-input normalization", async () => {
    await expect(probeReviewDiffFingerprint("/worktree", "base")).resolves.toEqual({ state: "empty" });
    await expect(computeCodeReviewInputFingerprint("/worktree", "base")).resolves.toBe(EMPTY_REVIEW_DIFF_FINGERPRINT);
  });

  it("preserves frozen and changed probes under the bounded options", async () => {
    childProcess.state.respond = (args) => {
      if (args[0] === "rev-list") return { stdout: "0\n" };
      return { stdout: "" };
    };
    await expect(probeReviewChangesSinceCommit("/worktree", "reviewed")).resolves.toEqual({
      state: "frozen",
      commitCount: 0,
    });

    childProcess.state.respond = (args) => {
      if (args[0] === "rev-list") return { stdout: "2\n" };
      if (args.includes("--name-only")) return { stdout: "src/a.ts\0src/b.ts\0" };
      if (args.includes("--shortstat")) return { stdout: " 2 files changed, 3 insertions(+)\n" };
      return { stdout: "" };
    };
    await expect(probeReviewChangesSinceCommit("/worktree", "reviewed")).resolves.toEqual({
      state: "changed",
      commitCount: 2,
      changedFiles: ["src/a.ts", "src/b.ts"],
      totalChangedFileCount: 2,
      shortstat: "2 files changed, 3 insertions(+)",
    });
    expect(childProcess.execFile.mock.calls.filter(isDiffOrChangesCall).every((call) => (
      (call[2] as { maxBuffer?: number }).maxBuffer === REVIEW_DIFF_GIT_MAX_BUFFER_BYTES
      && (call[2] as { timeout?: number }).timeout === REVIEW_DIFF_GIT_TIMEOUT_MS
    ))).toBe(true);
  });

  it("refuses a diff when the checkout stops being its own git top level during the command", async () => {
    let topLevelCalls = 0;
    childProcess.state.topLevel = (cwd) => (++topLevelCalls === 1 ? cwd : "/primary");
    childProcess.state.respond = () => ({ stdout: "diff --git a/task.txt b/task.txt\n+change\n" });

    await expect(probeReviewDiffFingerprint("/primary/.fusion/worktrees/kb-170", "base")).resolves.toEqual({
      state: "unavailable",
      reason: "checkout-not-own-top-level",
    });
    expect(topLevelCalls).toBe(2);
    expect(childProcess.execFile).toHaveBeenCalledWith("git", ["diff", "--binary", "base..HEAD"], expect.anything(), expect.any(Function));
  });

  it("refuses a checkout status when the checkout stops being its own git top level during the command", async () => {
    let topLevelCalls = 0;
    childProcess.state.topLevel = (cwd) => (++topLevelCalls === 1 ? cwd : "/primary");
    childProcess.state.respond = () => ({ stdout: "?? untracked.txt\0" });

    await expect(probeReviewCheckout("/primary/.fusion/worktrees/kb-170")).resolves.toEqual({ state: "unavailable" });
    expect(topLevelCalls).toBe(2);

    topLevelCalls = 0;
    childProcess.state.topLevel = (cwd) => cwd;
    await expect(probeReviewCheckout("/primary/.fusion/worktrees/kb-170")).resolves.toEqual({
      state: "dirty",
      paths: ["untracked.txt"],
    });
  });
});
