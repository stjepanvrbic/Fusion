import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@fusion/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const injected = vi.hoisted(() => ({ failure: null as null | Record<string, unknown> }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const exec = ((command: string, options: unknown, callback: (...cbArgs: unknown[]) => void) => {
    if (injected.failure && command.startsWith("git ")) {
      const failure = injected.failure;
      const err = Object.assign(new Error(String(failure.message ?? "git failed")), failure);
      setImmediate(() => callback(err, "", failure.stderr ?? ""));
      return undefined;
    }
    return actual.exec(command, options as never, callback as never);
  }) as typeof actual.exec;
  const { promisify } = await import("node:util");
  Object.assign(exec, {
    [promisify.custom]: (command: string, options?: unknown) =>
      new Promise((resolve, reject) => {
        exec(command, options as never, ((err: Error | null, stdout: string, stderr: string) =>
          err ? reject(err) : resolve({ stdout, stderr })) as never);
      }),
  });
  return { ...actual, exec };
});

const { resetStepsIfWorkLost } = await import("../reset-steps-if-work-lost.js");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

let repo: string;

function taskOnBranch(branch: string): Task {
  return {
    id: "FN-4990",
    title: "t",
    description: "d",
    column: "in-progress",
    dependencies: [],
    steps: [
      { name: "Step 1", status: "done" },
      { name: "Step 2", status: "in-progress" },
      { name: "Step 3", status: "pending" },
    ],
    currentStep: 1,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    branch,
  } as Task;
}

async function run(branch: string) {
  const resetLostWorkStepProgress = vi.fn(async () => {});
  await resetStepsIfWorkLost({ rootDir: repo, resetLostWorkStepProgress }, taskOnBranch(branch));
  return resetLostWorkStepProgress;
}

beforeEach(() => {
  injected.failure = null;
  repo = mkdtempSync(join(tmpdir(), "fusion-reset-steps-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
});

afterEach(() => {
  injected.failure = null;
  rmSync(repo, { recursive: true, force: true });
});

/*
FNXC:StuckRequeue 2026-10-07-19:23:
Completed steps are reset only on positive proof of lost work.
Real git proves the three verdicts; injected failure shapes prove an inconclusive probe never resets.
*/
describe("resetStepsIfWorkLost resets only on positive proof of lost work", () => {
  it("keeps completed steps when the branch holds commits beyond HEAD", async () => {
    git(repo, "branch", "fusion/fn-4990");
    git(repo, "checkout", "-q", "fusion/fn-4990");
    writeFileSync(join(repo, "b.txt"), "b\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "step work");
    git(repo, "checkout", "-q", "main");

    expect(await run("fusion/fn-4990")).not.toHaveBeenCalled();
  });

  it("resets when the branch tip equals its merge-base with HEAD", async () => {
    git(repo, "branch", "fusion/fn-4990");
    expect(await run("fusion/fn-4990")).toHaveBeenCalledWith(expect.anything(), 2, "branch had no commits");
  });

  it("resets when the branch does not exist", async () => {
    expect(await run("fusion/fn-4990")).toHaveBeenCalledWith(expect.anything(), 2, "branch does not exist");
  });

  const inconclusive: Array<[string, Record<string, unknown>]> = [
    ["cmd.exe redirect failure", { code: 1, stderr: "The system cannot find the path specified.", message: "Command failed" }],
    ["git fatal error", { code: 128, stderr: "fatal: unable to read index", message: "Command failed" }],
    ["spawn failure", { code: "ENOENT", message: "spawn git ENOENT" }],
    ["timeout", { code: null, killed: true, signal: "SIGTERM", message: "Command timed out" }],
  ];
  for (const [label, failure] of inconclusive) {
    it(`keeps completed steps on ${label}`, async () => {
      git(repo, "branch", "fusion/fn-4990");
      injected.failure = failure;
      expect(await run("fusion/fn-4990")).not.toHaveBeenCalled();
    });
  }
});
