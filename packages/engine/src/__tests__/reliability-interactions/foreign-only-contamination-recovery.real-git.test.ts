import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitFixture } from "../../../../core/src/__test-utils__/git-fixture";
import { recoverForeignOnlyContamination } from "../../recovery/foreign-only-contamination.js";
import { activeSessionRegistry } from "../../agents/active-session-registry.js";

describe("reliability interaction: foreign-only contamination recovery", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function setupRepo() {
    const repoDir = await mkdtemp(path.join(tmpdir(), "fn-4887-ri-"));
    dirs.push(repoDir);
    await gitFixture(repoDir, ["init", "-b", "main"]);
    await gitFixture(repoDir, ["config", "user.email", "test@example.com"]);
    await gitFixture(repoDir, ["config", "user.name", "Test User"]);
    await writeFile(path.join(repoDir, "note.txt"), "base\n", "utf-8");
    await gitFixture(repoDir, ["add", "note.txt"]);
    await gitFixture(repoDir, ["commit", "-m", "chore: base"]);
    const baseSha = await gitFixture(repoDir, ["rev-parse", "HEAD"]);

    await gitFixture(repoDir, ["checkout", "-b", "fusion/fn-y"]);
    await appendFile(path.join(repoDir, "note.txt"), "foreign-1\n", "utf-8");
    await gitFixture(repoDir, ["add", "note.txt"]);
    await gitFixture(repoDir, ["commit", "-m", "feat(FN-7001): y1", "-m", "Fusion-Task-Id: FN-7001"]);
    await appendFile(path.join(repoDir, "note.txt"), "foreign-2\n", "utf-8");
    await gitFixture(repoDir, ["add", "note.txt"]);
    await gitFixture(repoDir, ["commit", "-m", "fix(FN-7001): y2", "-m", "Fusion-Task-Id: FN-7001"]);

    await gitFixture(repoDir, ["checkout", "-b", "fusion/fn-x"]);
    await gitFixture(repoDir, ["checkout", "main"]);
    const worktreePath = path.join(repoDir, "wt-fn-x");
    await gitFixture(repoDir, ["worktree", "add", worktreePath, "fusion/fn-x"]);
    dirs.push(worktreePath);
    return { repoDir, baseSha, worktreePath };
  }

  it("reanchors foreign-only branch and preserves foreign branch commits", async () => {
    const { repoDir, baseSha, worktreePath } = await setupRepo();
    const store = {
      getTask: vi.fn(async () => ({ column: "in-review" })),
      logEntry: vi.fn(async () => {}),
      moveTask: vi.fn(async () => {}),
      updateTask: vi.fn(async () => {}),
    } as any;
    const runAudit = { database: vi.fn(async () => {}), git: vi.fn(), filesystem: vi.fn(), sandbox: vi.fn() } as any;

    const result = await recoverForeignOnlyContamination({
      id: "FN-8001",
      branch: "fusion/fn-x",
      worktree: worktreePath,
      baseCommitSha: baseSha,
      baseBranch: "main",
      executionStartBranch: "fusion/fn-y",
      /*
      FNXC:LifecycleContainment 2026-09-22-14:05:
      A recovery snapshot can become stale while its real-git repair awaits. The persisted column
      must remain the authority so a concurrent operator move is never rebound from this old value.
      */
      column: "todo",
    } as any, { repoDir, taskStore: store, runAudit, integrationBranch: "main" });

    expect(result.recovered).toBe(true);
    expect(store.getTask).toHaveBeenCalledWith("FN-8001");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-8001",
      expect.stringContaining("'in-review'"),
    );
    expect(["reanchor", "branch-discard"]).toContain(result.subtype);
    if (result.subtype === "reanchor") {
      expect(await gitFixture(repoDir, ["rev-parse", "fusion/fn-x"])).toBe(baseSha);
    }
    expect(await gitFixture(repoDir, ["rev-list", "--count", "main..fusion/fn-y"])).toBe("2");
    expect(runAudit.database).toHaveBeenCalledWith(expect.objectContaining({ type: "task:auto-recover-foreign-only-contamination" }));
  });

  it("refuses discard path when active session is present", async () => {
    const { repoDir, baseSha } = await setupRepo();
    const store = {
      moveTask: vi.fn(async () => {}),
      updateTask: vi.fn(async () => {}),
    } as any;
    const runAudit = { database: vi.fn(async () => {}), git: vi.fn(), filesystem: vi.fn(), sandbox: vi.fn() } as any;

    const missingWorktree = path.join(repoDir, "missing-worktree");
    vi.spyOn(activeSessionRegistry, "isPathActive").mockReturnValue(true);

    const result = await recoverForeignOnlyContamination({
      id: "FN-8002",
      branch: "fusion/fn-x",
      worktree: missingWorktree,
      baseCommitSha: baseSha,
      baseBranch: "main",
      executionStartBranch: "fusion/fn-y",
    } as any, { repoDir, taskStore: store, runAudit, integrationBranch: "main" });

    expect(result.recovered).toBe(false);
    expect(result.reason).toBe("active-session");
    expect(store.moveTask).not.toHaveBeenCalled();
  });
});
