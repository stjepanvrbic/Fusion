// @vitest-environment node

/*
FNXC:PathIdentity 2026-10-11-01:06:
Worktree git routes and terminal cwd authorization accept an outside-root path only when it is, or lies inside, a git-registered worktree.
Git reports registered worktrees in their native long spelling, so a Windows 8.3 alias spelling (`C:\Users\RUNNER~1\...`) of the same worktree must be accepted, while an unregistered directory must stay rejected.
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertWorktreePathSafe, isAuthorizedProjectOrRegisteredWorktreePath } from "../git-worktree-safety.js";
import { nativeRealPath, shortAliasForTest } from "./short-alias.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
}

let base: string;
let projectRoot: string;
let registeredWorktree: string;
let unregisteredDir: string;

beforeAll(() => {
  base = nativeRealPath(mkdtempSync(join(tmpdir(), "kb095-worktree-safety-")));
  projectRoot = join(base, "project-checkout");
  registeredWorktree = join(base, "registered-outside-worktree");
  unregisteredDir = join(base, "unregistered-outside-dir");
  mkdirSync(projectRoot);
  mkdirSync(unregisteredDir);
  git(projectRoot, "init", "--initial-branch=main");
  git(projectRoot, "config", "user.email", "kb-tests@example.com");
  git(projectRoot, "config", "user.name", "KB Tests");
  writeFileSync(join(projectRoot, "README.md"), "# Test Repo\n");
  git(projectRoot, "add", "README.md");
  git(projectRoot, "commit", "-m", "Initial commit");
  git(projectRoot, "worktree", "add", "-b", "kb-095-outside", registeredWorktree, "HEAD");
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

const storeFor = (rootDir: string) => ({ getRootDir: () => rootDir });

describe("assertWorktreePathSafe", () => {
  it("accepts an outside-root registered worktree and a file inside it in long and 8.3 short spelling", async () => {
    const shortWorktree = shortAliasForTest(registeredWorktree, "assertWorktreePathSafe registered worktree");
    for (const candidate of [registeredWorktree, shortWorktree, join(shortWorktree, "README.md")]) {
      await expect(assertWorktreePathSafe(storeFor(projectRoot), candidate, new Map())).resolves.toBe(candidate);
    }
  });

  it("accepts a short-alias path inside the project root", async () => {
    const shortProjectFile = join(shortAliasForTest(projectRoot, "assertWorktreePathSafe project root"), "README.md");
    await expect(assertWorktreePathSafe(storeFor(projectRoot), shortProjectFile, new Map())).resolves.toBe(shortProjectFile);
  });

  it("rejects an unregistered directory outside the project in either spelling", async () => {
    const shortUnregistered = shortAliasForTest(unregisteredDir, "assertWorktreePathSafe unregistered dir");
    for (const candidate of [unregisteredDir, shortUnregistered]) {
      await expect(assertWorktreePathSafe(storeFor(projectRoot), candidate, new Map())).rejects.toThrow("worktreePath outside project");
    }
  });
});

describe("isAuthorizedProjectOrRegisteredWorktreePath", () => {
  it("authorizes an outside-root registered worktree and a file inside it in long and 8.3 short spelling", async () => {
    const shortWorktree = shortAliasForTest(registeredWorktree, "terminal cwd registered worktree");
    for (const candidate of [registeredWorktree, shortWorktree, join(shortWorktree, "README.md")]) {
      await expect(isAuthorizedProjectOrRegisteredWorktreePath(projectRoot, candidate)).resolves.toBe(true);
    }
  });

  it("authorizes a short-alias path inside the project root", async () => {
    const shortProjectRoot = shortAliasForTest(projectRoot, "terminal cwd project root");
    await expect(isAuthorizedProjectOrRegisteredWorktreePath(projectRoot, join(shortProjectRoot, "README.md"))).resolves.toBe(true);
    await expect(isAuthorizedProjectOrRegisteredWorktreePath(shortProjectRoot, join(shortProjectRoot, "README.md"))).resolves.toBe(true);
  });

  it("refuses an unregistered directory outside the project in either spelling", async () => {
    const shortUnregistered = shortAliasForTest(unregisteredDir, "terminal cwd unregistered dir");
    for (const candidate of [unregisteredDir, shortUnregistered]) {
      await expect(isAuthorizedProjectOrRegisteredWorktreePath(projectRoot, candidate)).resolves.toBe(false);
    }
  });
});
