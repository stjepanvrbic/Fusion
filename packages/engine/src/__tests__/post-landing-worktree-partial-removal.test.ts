/*
FNXC:WorktreeCleanup 2026-10-07-05:29:
KB-003 real-git coverage for post-landing cleanup when `git worktree remove` only partly succeeds
(KB-001: a Windows file lock left the checkout `.git`-less and unregistered while the log said
"preserved … deliverable"). The chmod reproduction runs on POSIX as a non-root user; the simulated
pre-existing states use only portable filesystem operations and run on every platform.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupLandedTaskWorktree } from "../merge/post-landing-worktree-cleanup.js";
import { canonicalizePath } from "../worktree/worktree-pool.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.t",
};
const tracked: string[] = [];
const lockedDirs: string[] = [];

afterEach(() => {
  for (const dir of lockedDirs.splice(0)) {
    try { chmodSync(dir, 0o755); } catch { /* already removed */ }
  }
  for (const dir of tracked.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", env: GIT_ENV, stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** A repo on `main` with a landed task worktree at `<root>/.fusion/worktrees/fn-x` on `fusion/fn-x`. */
function landedTaskWorktree(): { root: string; worktree: string; landedSha: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fusion-kb003-cleanup-")));
  tracked.push(root);
  git(root, ["init", "-q", "-b", "main"]);
  writeFileSync(join(root, "base.txt"), "base\n");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "base"]);
  const worktree = join(root, ".fusion", "worktrees", "fn-x");
  mkdirSync(join(root, ".fusion", "worktrees"), { recursive: true });
  git(root, ["worktree", "add", "-q", "-b", "fusion/fn-x", worktree, "main"]);
  mkdirSync(join(worktree, "locked"), { recursive: true });
  writeFileSync(join(worktree, "locked", "file.txt"), "tracked\n");
  writeFileSync(join(worktree, "feature.txt"), "feature\n");
  git(worktree, ["add", "-A"]);
  git(worktree, ["commit", "-q", "-m", "feat: work"]);
  git(root, ["merge", "-q", "--ff-only", "fusion/fn-x"]);
  return { root, worktree, landedSha: git(root, ["rev-parse", "main"]) };
}

function store() {
  const logs: string[] = [];
  return {
    logs,
    store: {
      getSettings: async () => ({}),
      updateTask: vi.fn(async () => ({})),
      logEntry: vi.fn(async (_id: string, title: string, detail?: string) => { logs.push(`${title} ${detail ?? ""}`); }),
    },
  };
}

function registeredPaths(root: string): string[] {
  return git(root, ["worktree", "list", "--porcelain"])
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => canonicalizePath(line.slice("worktree ".length)));
}

const canChmodLock = process.platform !== "win32" && process.getuid?.() !== 0;

describe.skipIf(!canChmodLock)("post-landing cleanup when git removal fails partway (real git, POSIX)", () => {
  it("reports removed or partially-removed, unregisters the checkout and clears the pointer", async () => {
    const { root, worktree, landedSha } = landedTaskWorktree();
    const locked = join(worktree, "locked");
    chmodSync(locked, 0o555);
    lockedDirs.push(locked);
    const fixture = store();

    const result = await cleanupLandedTaskWorktree({
      store: fixture.store as never,
      taskId: "FN-X",
      worktreePath: worktree,
      rootDir: root,
      landedSha,
      source: "ai-merge-finalize",
      removeResidualDirectory: async () => ({ removed: false }),
    });

    expect(["removed", "partially-removed"]).toContain(result.outcome);
    expect(result.outcome.startsWith("preserved")).toBe(false);
    expect(registeredPaths(root)).not.toContain(canonicalizePath(worktree));
    expect(fixture.store.updateTask).toHaveBeenCalledWith("FN-X", { worktree: null });
    expect(fixture.logs.some((line) => line.includes("cleanup preserved"))).toBe(false);
  });
});

describe("post-landing cleanup of an already unusable checkout (real git, all platforms)", () => {
  it("leaves a pre-existing .git-less folder untouched and clears the pointer", async () => {
    const { root, worktree, landedSha } = landedTaskWorktree();
    mkdirSync(join(worktree, "node_modules", "pkg"), { recursive: true });
    rmSync(join(worktree, ".git"), { force: true });
    git(root, ["worktree", "prune"]);
    const fixture = store();

    const result = await cleanupLandedTaskWorktree({
      store: fixture.store as never,
      taskId: "FN-X",
      worktreePath: worktree,
      rootDir: root,
      landedSha,
      source: "self-healing-completion-convergence",
    });

    expect(result).toEqual({ outcome: "residual-unusable", removed: false });
    expect(existsSync(join(worktree, "feature.txt"))).toBe(true);
    expect(existsSync(join(worktree, "node_modules", "pkg"))).toBe(true);
    expect(fixture.store.updateTask).toHaveBeenCalledWith("FN-X", { worktree: null });
    expect(fixture.logs.some((line) => line.includes("already unusable (incomplete)"))).toBe(true);
  });

  it("leaves a pre-existing unregistered folder untouched and clears the pointer", async () => {
    const { root, worktree, landedSha } = landedTaskWorktree();
    rmSync(join(root, ".git", "worktrees", "fn-x"), { recursive: true, force: true });
    const fixture = store();

    const result = await cleanupLandedTaskWorktree({
      store: fixture.store as never,
      taskId: "FN-X",
      worktreePath: worktree,
      rootDir: root,
      landedSha,
      source: "ai-merge-finalize",
    });

    expect(result).toEqual({ outcome: "residual-unusable", removed: false });
    expect(existsSync(join(worktree, ".git"))).toBe(true);
    expect(existsSync(join(worktree, "feature.txt"))).toBe(true);
    expect(fixture.store.updateTask).toHaveBeenCalledWith("FN-X", { worktree: null });
    expect(fixture.logs.some((line) => line.includes("already unusable (unregistered)"))).toBe(true);
  });
});
