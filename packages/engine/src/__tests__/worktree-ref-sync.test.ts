import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const injected = vi.hoisted(() => ({ failWhen: null as null | ((args: readonly string[]) => boolean) }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFile = ((file: string, args: readonly string[], options: unknown, callback: (...cbArgs: unknown[]) => void) => {
    if (file === "git" && injected.failWhen?.(args)) {
      const err = Object.assign(new Error(`injected git failure: ${args.join(" ")}`), { code: 128, stderr: "fatal: injected" });
      setImmediate(() => callback(err, "", "fatal: injected"));
      return undefined;
    }
    return actual.execFile(file, args, options as never, callback as never);
  }) as typeof actual.execFile;
  return { ...actual, execFile };
});

const { syncWorktreeToHead } = await import("../worktree/worktree-ref-sync.js");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

let repo: string;
let previousSha: string;
let newSha: string;

/**
 * Simulates the merger's `update-ref` advance: the worktree's branch ref moves to a new commit
 * while the index and files stay at the previous tip.
 */
function advanceRefBehindWorktree(extraTracked: Record<string, string> = {}): void {
  const indexDir = mkdtempSync(join(tmpdir(), "fusion-ref-sync-index-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(indexDir, "index") };
  const run = (args: string[], input?: string) => execFileSync("git", args, { cwd: repo, env, encoding: "utf-8", input }).trim();
  try {
    run(["read-tree", previousSha]);
    for (const [rel, body] of Object.entries({ "landed.txt": "landed\n", ...extraTracked })) {
      const blob = run(["hash-object", "-w", "--stdin"], body);
      run(["update-index", "--add", "--cacheinfo", `100644,${blob},${rel}`]);
    }
    const tree = run(["write-tree"]);
    newSha = run(["commit-tree", tree, "-p", previousSha, "-m", "landed"]);
    git(repo, "update-ref", "refs/heads/main", newSha);
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  injected.failWhen = null;
  repo = mkdtempSync(join(tmpdir(), "fusion-ref-sync-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  previousSha = git(repo, "rev-parse", "HEAD");
});

afterEach(() => {
  injected.failWhen = null;
  rmSync(repo, { recursive: true, force: true });
});

const isDirtyProbe = (args: readonly string[]) => args.includes("diff") && args.includes("--name-only") && !args.includes("--diff-filter=U");
const isUntrackedProbe = (args: readonly string[]) => args.includes("ls-files") && args.includes("--others");
const isTrackedAtHeadProbe = (args: readonly string[]) => args.includes("ls-tree");
const isReset = (args: readonly string[]) => args.includes("reset");

describe("syncWorktreeToHead fails closed on an inconclusive dirty-state probe", () => {
  /*
  FNXC:MergeAdvanceSync 2026-10-07-19:23:
  Unknown worktree state must never count as clean: a failed dirty or untracked probe returns `failed` before any `reset --hard`.
  Covers both sync modes and tracked, staged, and untracked operator edits.
  */
  for (const mode of ["ff-only", "stash-and-ff"] as const) {
    const cases = [
      ["dirty-file", isDirtyProbe, "tracked"],
      ["dirty-file", isDirtyProbe, "staged"],
      ["untracked-file", isUntrackedProbe, "untracked"],
    ] as const;
    for (const [probeName, probe, editKind] of cases) {
      it(`${mode}: ${probeName} probe failure with ${editKind} edits returns failed and keeps bytes`, async () => {
        const editPath = editKind === "untracked" ? join(repo, "notes.txt") : join(repo, "tracked.txt");
        writeFileSync(editPath, "operator edit\n");
        if (editKind === "staged") git(repo, "add", "tracked.txt");
        advanceRefBehindWorktree();

        const resetCalls: string[][] = [];
        injected.failWhen = (args) => {
          if (isReset(args)) resetCalls.push([...args]);
          return probe(args);
        };

        const result = await syncWorktreeToHead({ worktreePath: repo, integrationBranch: "main", previousSha, newSha, mode });

        expect(result).toMatchObject({ kind: "failed", stage: "snapshot" });
        expect(resetCalls).toEqual([]);
        expect(readFileSync(editPath, "utf-8")).toBe("operator edit\n");
      });
    }
  }

  it("stash-and-ff: an unreadable tracked-at-HEAD listing never overwrites a newly tracked collision and preserves the saved bytes", async () => {
    writeFileSync(join(repo, "collide.txt"), "operator untracked bytes\n");
    advanceRefBehindWorktree({ "collide.txt": "landed tracked content\n" });
    injected.failWhen = isTrackedAtHeadProbe;

    const result = await syncWorktreeToHead({ worktreePath: repo, integrationBranch: "main", previousSha, newSha, mode: "stash-and-ff" });

    expect(result).toMatchObject({ kind: "failed", stage: "untracked-restore" });
    expect(readFileSync(join(repo, "collide.txt"), "utf-8")).toBe("landed tracked content\n");
    const savedDir = (result as { error: string }).error.match(/(\S*fusion-worktree-sync-[^\\/\s]+)/)?.[1];
    expect(savedDir).toBeDefined();
    expect(readFileSync(join(savedDir!, "untracked", "collide.txt"), "utf-8")).toBe("operator untracked bytes\n");
    rmSync(savedDir!, { recursive: true, force: true });
  });

  it("a genuinely clean worktree still snaps forward", async () => {
    advanceRefBehindWorktree();
    const result = await syncWorktreeToHead({ worktreePath: repo, integrationBranch: "main", previousSha, newSha, mode: "ff-only" });
    expect(result.kind).toBe("clean-sync");
    expect(existsSync(join(repo, "landed.txt"))).toBe(true);
  });
});

describe("syncWorktreeToHead with a nested checkout under the worktree", () => {
  /*
  FNXC:MergeAdvanceSync 2026-10-07-23:45:
  A project root commonly holds Fusion's own task worktrees under `.fusion/worktrees/`. Git lists a nested checkout as one
  untracked directory entry ending in `/`; it is a separate repository that `reset --hard` never touches, so it is not an
  operator edit to snapshot. Copying it as a file failed (EISDIR/EPERM), aborted the sync, and left the root showing the
  landed commit as a staged reversal. Ordinary untracked files are still snapshotted and preserved.
  */
  it.each(["stash-and-ff", "ff-only"] as const)("%s: snaps the root forward past a nested worktree entry", async (mode) => {
    git(repo, "worktree", "add", "-q", "--detach", join(repo, ".fusion", "worktrees", "fn-1"), "HEAD");
    if (mode === "stash-and-ff") writeFileSync(join(repo, "operator-note.txt"), "keep me\n");
    advanceRefBehindWorktree();

    const result = await syncWorktreeToHead({ worktreePath: repo, integrationBranch: "main", previousSha, newSha, mode, taskId: "FN-1" });

    expect(result.kind).not.toBe("failed");
    expect(git(repo, "status", "--porcelain", "--", "landed.txt")).toBe("");
    expect(readFileSync(join(repo, "landed.txt"), "utf-8")).toBe("landed\n");
    if (mode === "stash-and-ff") expect(readFileSync(join(repo, "operator-note.txt"), "utf-8")).toBe("keep me\n");
    expect(existsSync(join(repo, ".fusion", "worktrees", "fn-1", ".git"))).toBe(true);
  });
});
