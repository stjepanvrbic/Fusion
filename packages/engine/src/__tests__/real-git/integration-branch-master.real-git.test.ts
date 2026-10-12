import { afterEach, describe, expect, it, vi } from "vitest";
import { selectIntegrationBranch } from "@fusion/core";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectBranchConflict } from "../../execution/branch-conflicts.js";
import {
  __resetIntegrationBranchCacheForTests,
  INTEGRATION_BRANCH_FALLBACK,
  resolveIntegrationBranch,
  resolveIntegrationBranchSync,
} from "../../merge/integration-branch.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

describeIfGit("integration branch resolution (real git, master)", () => {
  const repos: string[] = [];

  afterEach(() => {
    __resetIntegrationBranchCacheForTests();
    for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
  });

  function setupRepoWithoutOriginHead(initialBranch: string): string {
    const repo = mkdtempSync(path.join(os.tmpdir(), "fn-5349-"));
    repos.push(repo);
    git(repo, `git init -b ${initialBranch}`);
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test"');
    git(repo, "git commit --allow-empty -m 'init'");
    return repo;
  }

  function setupRepo(): string {
    const repo = setupRepoWithoutOriginHead("master");
    git(repo, "git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/master");
    return repo;
  }

  /** Resolves through both ladders with no settings branch and returns the two results. */
  async function resolveBoth(rootDir: string): Promise<{ asyncResolved: string; syncResolved: string }> {
    const asyncResolved = await resolveIntegrationBranch(rootDir, undefined, { logger: { warn: vi.fn() } });
    __resetIntegrationBranchCacheForTests();
    const syncResolved = resolveIntegrationBranchSync(rootDir, undefined, { logger: { warn: vi.fn() } });
    return { asyncResolved, syncResolved };
  }

  it("reads origin/HEAD the same through the async and sync ladders", async () => {
    const repo = setupRepo();

    await expect(resolveBoth(repo)).resolves.toEqual({ asyncResolved: "master", syncResolved: "master" });
  });

  /*
  FNXC:IntegrationBranchReadiness 2026-10-11-22:50:
  A project whose default branch is not a well-known name, with no configured branch and no origin/HEAD, is recognised from git's branch listing on every platform.
  The listing format contains parentheses, which a POSIX shell rejects when the command is passed as a string, so these cases read the real listing output.
  */
  it("infers a sole local branch that is not a well-known name when origin/HEAD is unset", async () => {
    const repo = setupRepoWithoutOriginHead("production");
    git(repo, "git checkout --detach");
    const expected = selectIntegrationBranch({ localBranches: ["production"], currentBranch: "", remoteBranches: [] });

    expect(expected).toEqual({ branch: "production", source: "sole-local" });
    await expect(resolveBoth(repo)).resolves.toEqual({ asyncResolved: expected?.branch, syncResolved: expected?.branch });
  });

  it("infers the checked-out local branch among several when origin/HEAD is unset", async () => {
    const repo = setupRepoWithoutOriginHead("production");
    git(repo, "git branch staging");
    const expected = selectIntegrationBranch({ localBranches: ["production", "staging"], currentBranch: "production", remoteBranches: [] });

    expect(expected).toEqual({ branch: "production", source: "current-head" });
    await expect(resolveBoth(repo)).resolves.toEqual({ asyncResolved: expected?.branch, syncResolved: expected?.branch });
  });

  it("infers the only origin remote-tracking branch when no local branch exists", async () => {
    const repo = setupRepoWithoutOriginHead("production");
    git(repo, "git update-ref refs/remotes/origin/staging HEAD");
    git(repo, "git checkout --detach");
    git(repo, "git branch -D production");
    const expected = selectIntegrationBranch({ localBranches: [], currentBranch: "", remoteBranches: ["staging"] });

    expect(expected).toEqual({ branch: "staging", source: "remote-tracking" });
    await expect(resolveBoth(repo)).resolves.toEqual({ asyncResolved: expected?.branch, syncResolved: expected?.branch });
  });

  it("falls back to main without throwing outside a repository", async () => {
    const notARepo = mkdtempSync(path.join(os.tmpdir(), "fn-5349-plain-"));
    repos.push(notARepo);

    await expect(resolveBoth(notARepo)).resolves.toEqual({
      asyncResolved: INTEGRATION_BRANCH_FALLBACK,
      syncResolved: INTEGRATION_BRANCH_FALLBACK,
    });
  });

  it("falls back to main without throwing when the directory does not exist", async () => {
    const missing = path.join(os.tmpdir(), `fn-5349-missing-${process.pid}-${Date.now()}`);

    await expect(resolveBoth(missing)).resolves.toEqual({
      asyncResolved: INTEGRATION_BRANCH_FALLBACK,
      syncResolved: INTEGRATION_BRANCH_FALLBACK,
    });
  });

  it("resolves origin/HEAD and respects explicit override", async () => {
    const repo = setupRepo();
    await expect(resolveIntegrationBranch(repo, {})).resolves.toBe("master");
    await expect(resolveIntegrationBranch(repo, { integrationBranch: "trunk" })).resolves.toBe("trunk");
  });

  it("inspects branch conflicts against master without disturbing dirty root worktree", async () => {
    const repo = setupRepo();
    git(repo, "git checkout -b fusion/fn-5349-check");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "task.txt"), "task\n", "utf-8");
    git(repo, "git add src/task.txt && git commit -m 'task change'");
    git(repo, "git checkout master");

    const conflictWorktree = path.join(repo, ".worktrees", "fn-5349-check");
    mkdirSync(path.dirname(conflictWorktree), { recursive: true });
    git(repo, `git worktree add ${JSON.stringify(conflictWorktree)} fusion/fn-5349-check`);

    writeFileSync(path.join(repo, "dirty.txt"), "dirty\n", "utf-8");
    writeFileSync(path.join(repo, "untracked.txt"), "untracked\n", "utf-8");
    const preStatus = git(repo, "git status --short");

    const result = await inspectBranchConflict({
      repoDir: repo,
      branchName: "fusion/fn-5349-check",
      conflictingWorktreePath: conflictWorktree,
      requestingTaskId: "FN-5349",
      ownerTaskId: "FN-5349",
      startPoint: "master",
      integrationRef: "master",
    });

    expect(["reclaimable", "live-foreign", "fully-subsumed", "tip-already-merged"]).toContain(result.kind);
    expect(git(repo, "git symbolic-ref --short HEAD")).toBe("master");
    expect(readFileSync(path.join(repo, "dirty.txt"), "utf-8")).toBe("dirty\n");
    expect(readFileSync(path.join(repo, "untracked.txt"), "utf-8")).toBe("untracked\n");
    expect(git(repo, "git status --short")).toBe(preStatus);
  });
});
