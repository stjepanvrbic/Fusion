/*
FNXC:WorktreeCleanup 2026-10-11-11:14:
Real-git coverage for post-landing cleanup when `git worktree remove` only partly succeeds: a Windows file lock left the checkout `.git`-less and unregistered while the log said it was preserved as a deliverable.
The partial removal is simulated at the backend removal seam and the pre-existing states use only portable filesystem operations, so every case runs on every platform and for every user.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupLandedTaskWorktree } from "../merge/post-landing-worktree-cleanup.js";
import { isAuthorizedCheckoutResidue } from "../worktree/remove-checkout.js";
import { armPartialWorktreeRemoval, type PartialWorktreeRemoval, type PartialWorktreeRemovalShape } from "./_partial-worktree-removal.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.t",
};
const tracked: string[] = [];
const armed: PartialWorktreeRemoval[] = [];

afterEach(() => {
  for (const removal of armed.splice(0)) removal.restore();
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

const REGISTRATION = "branch refs/heads/fusion/fn-x";

/** Whether the task checkout is registered, read from its branch line: git prints registered paths with forward slashes on every platform. */
function isRegistered(root: string): boolean {
  return git(root, ["worktree", "list", "--porcelain"]).split(/\r?\n/).includes(REGISTRATION);
}

function armRemoval(worktree: string, shape: PartialWorktreeRemovalShape): PartialWorktreeRemoval {
  const removal = armPartialWorktreeRemoval(worktree, { shape, survivor: "locked" });
  armed.push(removal);
  return removal;
}

function auditSink() {
  return { git: vi.fn(async (_event: { type: string; target?: string; metadata?: Record<string, unknown> }) => undefined) };
}

function partialAudits(audit: ReturnType<typeof auditSink>) {
  return audit.git.mock.calls.map(([event]) => event).filter((event) => event.type === "worktree:removal-partial");
}

describe("post-landing cleanup when git removal fails partway (real git, all platforms)", () => {
  it.each<PartialWorktreeRemovalShape>(["incomplete", "unregistered"])("reports partially-removed, marks the %s residue and clears the pointer when residue remains", async (shape) => {
    const { root, worktree, landedSha } = landedTaskWorktree();
    const removal = armRemoval(worktree, shape);
    const fixture = store();
    const audit = auditSink();
    expect(isRegistered(root)).toBe(true);

    const result = await cleanupLandedTaskWorktree({
      store: fixture.store as never,
      taskId: "FN-X",
      worktreePath: worktree,
      rootDir: root,
      landedSha,
      source: "ai-merge-finalize",
      audit: audit as never,
      removeResidualDirectory: async () => ({ removed: false }),
    });

    expect(removal.fired()).toBe(true);
    expect(result).toEqual({ outcome: "partially-removed", removed: false });
    expect(fixture.store.updateTask).toHaveBeenCalledWith("FN-X", { worktree: null });
    expect(existsSync(join(worktree, "locked", "file.txt"))).toBe(true);
    expect(existsSync(join(worktree, ".git"))).toBe(shape === "unregistered");
    expect(await isAuthorizedCheckoutResidue(worktree)).toBe(true);
    expect(isRegistered(root)).toBe(false);
    expect(partialAudits(audit)).toEqual([{
      type: "worktree:removal-partial",
      target: worktree,
      metadata: { taskId: "FN-X", source: "ai-merge-finalize", classification: shape, phase: "during-removal", residual: true },
    }]);
    expect(fixture.logs.some((line) => line.includes("partially removed") && line.includes(`(${shape})`) && line.includes("residual files remain"))).toBe(true);
    expect(fixture.logs.some((line) => line.includes("cleanup preserved"))).toBe(false);
  });

  it("reports removed and clears the pointer when the engine finishes deleting the residue", async () => {
    const { root, worktree, landedSha } = landedTaskWorktree();
    const removal = armRemoval(worktree, "incomplete");
    const fixture = store();
    const audit = auditSink();
    expect(isRegistered(root)).toBe(true);

    const result = await cleanupLandedTaskWorktree({
      store: fixture.store as never,
      taskId: "FN-X",
      worktreePath: worktree,
      rootDir: root,
      landedSha,
      source: "ai-merge-finalize",
      audit: audit as never,
    });

    expect(removal.fired()).toBe(true);
    expect(result).toEqual({ outcome: "removed", removed: true });
    expect(existsSync(worktree)).toBe(false);
    expect(fixture.store.updateTask).toHaveBeenCalledWith("FN-X", { worktree: null });
    expect(isRegistered(root)).toBe(false);
    expect(partialAudits(audit)).toEqual([{
      type: "worktree:removal-partial",
      target: worktree,
      metadata: { taskId: "FN-X", source: "ai-merge-finalize", classification: "incomplete", phase: "during-removal", residual: false },
    }]);
    expect(fixture.logs.some((line) => line.includes("residual files deleted"))).toBe(true);
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
