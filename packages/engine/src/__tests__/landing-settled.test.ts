import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MergeDetails, Task } from "@fusion/core";
import { isLandingSettled } from "../merge/landing-settled.js";

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function task(branch: string | null, mergeDetails?: MergeDetails): Pick<Task, "id" | "branch" | "branchContext" | "mergeDetails"> {
  return { id: "KB-900", branch: branch ?? undefined, mergeDetails } as Pick<Task, "id" | "branch" | "branchContext" | "mergeDetails">;
}

describe("isLandingSettled (real git)", () => {
  let repo = "";
  let baseSha = "";
  let branchTipSha = "";

  beforeAll(() => {
    repo = mkdtempSync(path.join(os.tmpdir(), "fn-landing-settled-"));
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    writeFileSync(path.join(repo, "a.txt"), "one\n", "utf-8");
    git(repo, ["add", "a.txt"]);
    git(repo, ["commit", "-q", "-m", "base"]);
    baseSha = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["branch", "fusion/kb-moved", baseSha]);
    git(repo, ["checkout", "-q", "-b", "fusion/kb-at-pin"]);
    writeFileSync(path.join(repo, "a.txt"), "two\n", "utf-8");
    git(repo, ["commit", "-q", "-am", "work"]);
    branchTipSha = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "-q", "main"]);
    git(repo, ["branch", "-f", "fusion/kb-moved", branchTipSha]);
  });

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  const confirmed = (extra: Partial<MergeDetails> = {}): MergeDetails => ({ mergeConfirmed: true, commitSha: "f".repeat(40), mergeTargetBranch: "main", ...extra });

  it("is not settled without merge details", async () => {
    expect(await isLandingSettled(task("fusion/kb-at-pin"), repo)).toBe(false);
  });

  it("is not settled when a commit is recorded without confirmation", async () => {
    expect(await isLandingSettled(task("fusion/kb-at-pin", { mergeConfirmed: false, commitSha: "f".repeat(40) }), repo)).toBe(false);
  });

  it("is settled when the branch still points at the landed pin", async () => {
    expect(await isLandingSettled(task("fusion/kb-at-pin", confirmed({ landedBranchTipSha: branchTipSha })), repo)).toBe(true);
  });

  it("is not settled when the branch moved past the landed pin", async () => {
    expect(await isLandingSettled(task("fusion/kb-moved", confirmed({ landedBranchTipSha: baseSha })), repo)).toBe(false);
  });

  it("is settled when the pinned branch was deleted", async () => {
    expect(await isLandingSettled(task("fusion/kb-deleted", confirmed({ landedBranchTipSha: baseSha })), repo)).toBe(true);
  });

  it("is settled for a confirmed no-op landing without a pin", async () => {
    expect(await isLandingSettled(task("fusion/kb-moved", confirmed({ noOpMerge: true, commitSha: undefined })), repo)).toBe(true);
  });

  it("is settled for a confirmed row with neither pin nor branch field", async () => {
    expect(await isLandingSettled(task(null, { mergeConfirmed: true }), repo)).toBe(true);
  });

  it("is settled when a pin is recorded but the task has no branch field and its canonical branch is absent", async () => {
    expect(await isLandingSettled(task(null, confirmed({ landedBranchTipSha: baseSha })), repo)).toBe(true);
  });
});
