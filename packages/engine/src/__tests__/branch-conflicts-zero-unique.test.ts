// Real-git wallclock under parallel CI load; do not lower per-test timeouts
// without re-measuring under pnpm test:full. (FN-4839)
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, appendFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitFixture } from "../../../core/src/__test-utils__/git-fixture";
import { inspectBareBranchCollision, inspectBranchConflict, listUniqueBranchCommits } from "../execution/branch-conflicts.js";

describe("inspectBranchConflict zero-unique behavior", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function setupRepo() {
    const repoDir = await mkdtemp(path.join(tmpdir(), "fn-4500-branch-conflict-"));
    dirs.push(repoDir);
    await gitFixture(repoDir, ["init", "-b", "main"]);
    await gitFixture(repoDir, ["config", "user.email", "test@example.com"]);
    await gitFixture(repoDir, ["config", "user.name", "Test User"]);
    await writeFile(path.join(repoDir, "note.txt"), "base\n", "utf-8");
    await gitFixture(repoDir, ["add", "note.txt"]);
    await gitFixture(repoDir, ["commit", "-m", "chore: base"]);
    return repoDir;
  }

  it("returns tip-already-merged when branch tip is ancestor of main", async () => {
    const repoDir = await setupRepo();
    await gitFixture(repoDir, ["checkout", "-b", "fusion/fn-9001"]);
    await gitFixture(repoDir, ["checkout", "main"]);
    const livePath = path.join(repoDir, "wt-live-9001");
    await gitFixture(repoDir, ["worktree", "add", livePath, "fusion/fn-9001"]);
    const stalePath = path.join(repoDir, "wt-stale-9001");
    await mkdir(stalePath, { recursive: true });

    const result = await inspectBranchConflict({ repoDir, branchName: "fusion/fn-9001", conflictingWorktreePath: stalePath, requestingTaskId: "FN-9001", ownerTaskId: "FN-9001", startPoint: "main" });
    expect(result.kind).toBe("tip-already-merged");
  }, 20_000);

  it("classifies branch patch already existing upstream as merged/subsumed", async () => {
    const repoDir = await setupRepo();
    await gitFixture(repoDir, ["checkout", "-b", "fusion/fn-9001"]);
    await appendFile(path.join(repoDir, "note.txt"), "change\n", "utf-8");
    await gitFixture(repoDir, ["add", "note.txt"]);
    await gitFixture(repoDir, ["commit", "-m", "feat(FN-9001): change", "-m", "Fusion-Task-Id: FN-9001"]);
    const branchCommit = await gitFixture(repoDir, ["rev-parse", "HEAD"]);
    await gitFixture(repoDir, ["checkout", "main"]);
    await gitFixture(repoDir, ["cherry-pick", branchCommit]);

    const livePath = path.join(repoDir, "wt-live-9001-upstream");
    await gitFixture(repoDir, ["worktree", "add", livePath, "fusion/fn-9001"]);
    const stalePath = path.join(repoDir, "wt-stale-9001-upstream");
    await mkdir(stalePath, { recursive: true });

    const result = await inspectBranchConflict({ repoDir, branchName: "fusion/fn-9001", conflictingWorktreePath: stalePath, requestingTaskId: "FN-9001", ownerTaskId: "FN-9001", startPoint: "main" });
    expect(["tip-already-merged", "fully-subsumed"]).toContain(result.kind);
  }, 20_000);

  it("uses the current integration branch rather than an old task base", async () => {
    const repoDir = await setupRepo();
    const oldBase = await gitFixture(repoDir, ["rev-parse", "HEAD"]);
    await gitFixture(repoDir, ["checkout", "-b", "fusion/fn-9001"]);
    await appendFile(path.join(repoDir, "note.txt"), "task change\n", "utf-8");
    await gitFixture(repoDir, ["add", "note.txt"]);
    await gitFixture(repoDir, ["commit", "-m", "feat(FN-9001): task change", "-m", "Fusion-Task-Id: FN-9001"]);
    const taskTip = await gitFixture(repoDir, ["rev-parse", "HEAD"]);
    await gitFixture(repoDir, ["checkout", "main"]);
    await gitFixture(repoDir, ["merge", "--no-ff", taskTip, "-m", "merge task work"]);

    const livePath = path.join(repoDir, "wt-live-9001-current-base");
    await gitFixture(repoDir, ["worktree", "add", livePath, "fusion/fn-9001"]);
    const stalePath = path.join(repoDir, "wt-stale-9001-current-base");
    await mkdir(stalePath, { recursive: true });

    const unique = await listUniqueBranchCommits(repoDir, "main", "fusion/fn-9001");
    expect(unique.commits).toHaveLength(0);
    const result = await inspectBranchConflict({
      repoDir,
      branchName: "fusion/fn-9001",
      conflictingWorktreePath: stalePath,
      requestingTaskId: "FN-9001",
      ownerTaskId: "FN-9001",
      startPoint: oldBase,
      integrationRef: "main",
    });
    expect(result.kind).toBe("tip-already-merged");
    await gitFixture(repoDir, ["worktree", "remove", "--force", livePath]);

    const bare = await inspectBareBranchCollision({
      repoDir,
      branchName: "fusion/fn-9001",
      conflictingWorktreePath: path.join(repoDir, "absent-9001"),
      requestingTaskId: "FN-9001",
      startPoint: oldBase,
      integrationRef: "main",
    });
    expect(bare.kind).toBe("tip-already-merged");
  }, 20_000);

  it("returns reclaimable when branch still has unique commit", async () => {
    const repoDir = await setupRepo();
    await gitFixture(repoDir, ["checkout", "-b", "fusion/fn-9001"]);
    await appendFile(path.join(repoDir, "note.txt"), "unique\n", "utf-8");
    await gitFixture(repoDir, ["add", "note.txt"]);
    await gitFixture(repoDir, ["commit", "-m", "feat(FN-9001): unique", "-m", "Fusion-Task-Id: FN-9001"]);
    await gitFixture(repoDir, ["checkout", "main"]);

    const livePath = path.join(repoDir, "wt-live-9001-unique");
    await gitFixture(repoDir, ["worktree", "add", livePath, "fusion/fn-9001"]);
    const stalePath = path.join(repoDir, "wt-stale-9001-unique");
    await mkdir(stalePath, { recursive: true });

    const result = await inspectBranchConflict({ repoDir, branchName: "fusion/fn-9001", conflictingWorktreePath: stalePath, requestingTaskId: "FN-9001", ownerTaskId: "FN-9001", startPoint: "main" });
    expect(result.kind).toBe("reclaimable");
  }, 20_000);

  it("keeps zero-attributed foreign branch as live-foreign", async () => {
    const repoDir = await setupRepo();
    await gitFixture(repoDir, ["checkout", "-b", "topic/other"]);
    await appendFile(path.join(repoDir, "note.txt"), "other\n", "utf-8");
    await gitFixture(repoDir, ["add", "note.txt"]);
    await gitFixture(repoDir, ["commit", "-m", "chore: other work"]);
    await gitFixture(repoDir, ["checkout", "main"]);

    const livePath = path.join(repoDir, "wt-live-other");
    await gitFixture(repoDir, ["worktree", "add", livePath, "topic/other"]);
    const stalePath = path.join(repoDir, "wt-stale-other");
    await mkdir(stalePath, { recursive: true });

    const result = await inspectBranchConflict({ repoDir, branchName: "topic/other", conflictingWorktreePath: stalePath, requestingTaskId: "FN-9001", ownerTaskId: "FN-9001", startPoint: "main" });
    expect(result.kind).toBe("live-foreign");
  }, 20_000);
});
