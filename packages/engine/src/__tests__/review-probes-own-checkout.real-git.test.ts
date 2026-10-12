import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { isSamePath, type Task } from "@fusion/core";
import { captureMergeContentDescriptor } from "../merge/merge-content-capture.js";
import { probeReviewCheckout } from "../worktree/review-checkout-clean.js";
import {
  computeCodeReviewInputFingerprint,
  probeReviewDiffFingerprint,
  resolveContentReviewInputProof,
} from "../worktree/review-diff-fingerprint.js";

/*
FNXC:ReviewInputProof 2026-10-12-10:58:
Post-landing cleanup can delete a task worktree's `.git` link and leave its directory inside the primary checkout.
git then walks up and answers for the primary repository, so the review probes reported a clean checkout and the primary branch's fingerprint.
These real-git cases pin that both probes, and the merge-content capture built on them, answer only for the checkout they were given.
*/

const execFileAsync = promisify(execFile);
const directories: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function nestedWorktreeFixture() {
  const root = await mkdtemp(join(tmpdir(), "fusion-own-checkout-"));
  directories.push(root);
  const primary = join(root, "primary");
  await mkdir(primary);
  await git(primary, ["init", "-b", "main"]);
  await git(primary, ["config", "user.email", "test@example.test"]);
  await git(primary, ["config", "user.name", "Test"]);
  await git(primary, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(primary, "base.txt"), "base\n");
  await git(primary, ["add", "."]);
  await git(primary, ["commit", "-m", "base"]);
  const base = (await git(primary, ["rev-parse", "HEAD"])).trim();
  await writeFile(join(primary, ".gitignore"), ".fusion/\n");
  await git(primary, ["add", "."]);
  await git(primary, ["commit", "-m", "ignore task worktrees"]);
  const worktree = join(primary, ".fusion", "worktrees", "kb-170");
  await git(primary, ["worktree", "add", "-b", "fusion/kb-170", worktree, base]);
  await writeFile(join(worktree, "task.txt"), "task change\n");
  await git(worktree, ["add", "."]);
  await git(worktree, ["commit", "-m", "task change"]);
  const worktreeDiff = await git(worktree, ["diff", "--binary", `${base}..HEAD`]);
  const primaryDiff = await git(primary, ["diff", "--binary", `${base}..HEAD`]);
  return { primary, worktree, base, worktreeDiff, primaryDiff };
}

/** Deletes the worktree's `.git` link and proves git now answers for the primary checkout from the leftover directory. */
async function halfRemove(fixture: Awaited<ReturnType<typeof nestedWorktreeFixture>>) {
  await rm(join(fixture.worktree, ".git"));
  const topLevel = (await git(fixture.worktree, ["rev-parse", "--show-toplevel"])).trim();
  expect(isSamePath(topLevel, fixture.primary)).toBe(true);
  const leakedDiff = await git(fixture.worktree, ["diff", "--binary", `${fixture.base}..HEAD`]);
  expect(leakedDiff).not.toBe("");
  expect(leakedDiff).toBe(fixture.primaryDiff);
  expect(leakedDiff).not.toBe(fixture.worktreeDiff);
}

function singularTask(worktree: string, base: string): Task {
  return { id: "KB-170", worktree, baseCommitSha: base } as Task;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("review probes answer only for their own checkout", () => {
  it("yields an intact nested worktree's own fingerprint and checkout state", async () => {
    const fixture = await nestedWorktreeFixture();
    expect(fixture.worktreeDiff).not.toBe(fixture.primaryDiff);

    await expect(probeReviewDiffFingerprint(fixture.worktree, fixture.base)).resolves.toEqual({
      state: "fingerprint",
      fingerprint: sha256(fixture.worktreeDiff),
    });
    await expect(probeReviewCheckout(fixture.worktree)).resolves.toEqual({ state: "clean" });
    await expect(captureMergeContentDescriptor(singularTask(fixture.worktree, fixture.base), {
      workspaceRootDir: fixture.primary,
      settings: {},
    })).resolves.toEqual({ kind: "singular", diff: { state: "fingerprint", fingerprint: sha256(fixture.worktreeDiff) } });

    await writeFile(join(fixture.worktree, "untracked.txt"), "dirty\n");
    await expect(probeReviewCheckout(fixture.worktree)).resolves.toEqual({ state: "dirty", paths: ["untracked.txt"] });
  });

  it("returns unavailable for a half-removed nested worktree instead of the primary checkout's state", async () => {
    const fixture = await nestedWorktreeFixture();
    await halfRemove(fixture);

    await expect(probeReviewCheckout(fixture.worktree)).resolves.toEqual({ state: "unavailable" });
    await expect(probeReviewDiffFingerprint(fixture.worktree, fixture.base)).resolves.toEqual({
      state: "unavailable",
      reason: "checkout-not-own-top-level",
    });
    await expect(computeCodeReviewInputFingerprint(fixture.worktree, fixture.base)).resolves.toBeUndefined();
    await expect(resolveContentReviewInputProof(fixture.worktree, fixture.base)).resolves.toEqual({
      kind: "unprovable",
      reason: "checkout-not-own-top-level",
    });
  });

  it("captures an unavailable merge-content descriptor for a half-removed worktree in both task shapes", async () => {
    const fixture = await nestedWorktreeFixture();
    await halfRemove(fixture);

    const singular = await captureMergeContentDescriptor(singularTask(fixture.worktree, fixture.base), {
      workspaceRootDir: fixture.primary,
      settings: {},
    });
    expect(singular).toMatchObject({ kind: "singular", diff: { state: "unavailable" } });

    const workspaceTask = {
      id: "KB-170",
      workspaceWorktrees: {
        app: { worktreePath: fixture.worktree, branch: "fusion/kb-170", baseCommitSha: fixture.base },
      },
    } as unknown as Task;
    await expect(captureMergeContentDescriptor(workspaceTask, {
      workspaceRootDir: fixture.primary,
      settings: {},
    })).resolves.toEqual({
      kind: "workspace",
      repositories: { state: "unavailable", reason: "review-checkout-unavailable:app" },
    });
  });

  it("accepts checkout roots and their alias spellings but refuses a subdirectory", async () => {
    const fixture = await nestedWorktreeFixture();

    await expect(probeReviewDiffFingerprint(fixture.primary, fixture.base)).resolves.toEqual({
      state: "fingerprint",
      fingerprint: sha256(fixture.primaryDiff),
    });
    await expect(probeReviewCheckout(fixture.primary)).resolves.toEqual({ state: "clean" });

    const subdirectory = join(fixture.worktree, "nested");
    await mkdir(subdirectory);
    await expect(probeReviewDiffFingerprint(subdirectory, fixture.base)).resolves.toEqual({
      state: "unavailable",
      reason: "checkout-not-own-top-level",
    });
    await expect(probeReviewCheckout(subdirectory)).resolves.toEqual({ state: "unavailable" });

    let alias: string;
    if (process.platform === "win32") {
      alias = fixture.worktree.replace(/kb-170$/, "KB-170");
      expect(alias).not.toBe(fixture.worktree);
    } else {
      alias = join(fixture.primary, "..", "worktree-link");
      await symlink(fixture.worktree, alias, "dir");
    }
    await expect(probeReviewDiffFingerprint(alias, fixture.base)).resolves.toEqual({
      state: "fingerprint",
      fingerprint: sha256(fixture.worktreeDiff),
    });
    await expect(probeReviewCheckout(alias)).resolves.toEqual({ state: "clean" });
  });

  it("returns unavailable once the worktree directory is gone", async () => {
    const fixture = await nestedWorktreeFixture();
    await rm(fixture.worktree, { recursive: true, force: true });

    await expect(probeReviewCheckout(fixture.worktree)).resolves.toEqual({ state: "unavailable" });
    await expect(probeReviewDiffFingerprint(fixture.worktree, fixture.base)).resolves.toEqual({
      state: "unavailable",
      reason: "checkout-not-own-top-level",
    });
  });
});
