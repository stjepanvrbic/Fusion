import {afterEach, describe, expect, it, vi} from "vitest";
import {mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  ArchiveWorkspaceDisposalError,
  ArchiveWorkspaceDisposalIncompleteError,
  ArchiveWorkspaceWorktreeDisposerMissingError,
  getArchiveWorkspaceWorktreeDisposer,
  registerArchiveWorkspaceWorktreeDisposer,
  registerArchiveWorktreeDisposer,
  type TaskStore,
} from "../index.js";
import {buildWorkspaceDisposalPlan, disposeArchivedWorktree} from "../task-store/archive-lifecycle.js";

describe("workspace archive worktree disposer seam", () => {
  it("is store scoped and identity-guarded during executor replacement", async () => {
    const storeA = {} as TaskStore;
    const storeB = {} as TaskStore;
    const baseline = async () => ({removed: [], failed: []});
    const executor = async () => ({removed: [], failed: []});
    const removeBaseline = registerArchiveWorkspaceWorktreeDisposer(storeA, baseline);
    registerArchiveWorkspaceWorktreeDisposer(storeB, executor);
    const removeExecutor = registerArchiveWorkspaceWorktreeDisposer(storeA, executor);

    removeBaseline();
    expect(getArchiveWorkspaceWorktreeDisposer(storeA)).toBe(executor);
    expect(getArchiveWorkspaceWorktreeDisposer(storeB)).toBe(executor);
    removeExecutor();
    expect(getArchiveWorkspaceWorktreeDisposer(storeA)).toBeUndefined();
    expect(getArchiveWorkspaceWorktreeDisposer(storeB)).toBe(executor);
  });

  it("retains typed outcome identity for incomplete and missing removal handling", () => {
    expect(new ArchiveWorkspaceDisposalError("partial", ["repo-a"], [{repoRel: "repo-b", error: new Error("failed")}]).removed).toEqual(["repo-a"]);
    expect(new ArchiveWorkspaceDisposalIncompleteError("repo-c").message).toContain("repo-c");
    expect(new ArchiveWorkspaceWorktreeDisposerMissingError("repo-d").message).toContain("repo-d");
  });

  it("builds one deterministic plan entry for aliases and a colliding singular path", async () => {
    const rootDir = "/workspace";
    const shared = join(rootDir, ".worktrees", "shared");
    const task = {
      worktree: shared,
      workspaceWorktrees: {
        "repo-b": {worktreePath: shared, branch: "fusion/b"},
        "repo-a": {worktreePath: shared, branch: "fusion/a"},
      },
    } as never;

    const {plan, singularDeduplicated} = await buildWorkspaceDisposalPlan({rootDir} as TaskStore, task);

    expect(plan).toEqual([{
      repoRel: "repo-a",
      worktreePath: shared,
      branch: "fusion/a",
      repoRootDir: join(rootDir, "repo-a"),
      aliasRepoRels: ["repo-b", "__singular_worktree__"],
    }]);
    expect(singularDeduplicated).toBe(true);
  });

  describe("path identity", () => {
    const dirs: string[] = [];
    afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true}); });
    function hostRoot(): {rootDir: string; alias: string} {
      const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "fusion-archive-identity-")));
      dirs.push(dir);
      const rootDir = join(dir, "Project");
      mkdirSync(join(rootDir, ".fusion", "worktrees", "shared"), {recursive: true});
      const alias = join(dir, "project-alias");
      symlinkSync(rootDir, alias, process.platform === "win32" ? "junction" : "dir");
      return {rootDir, alias};
    }
    function spellingsOf(rootDir: string, alias: string): string[] {
      const relative = join(".fusion", "worktrees", "shared");
      const spellings = [join(alias, relative), `${join(rootDir, relative)}${process.platform === "win32" ? "\\" : "/"}`];
      if (process.platform === "win32") spellings.push(join(rootDir, relative).toUpperCase(), `\\\\?\\${join(rootDir, relative)}`);
      return spellings;
    }

    it("deduplicates every spelling of one physical workspace worktree into one plan entry", async () => {
      const {rootDir, alias} = hostRoot();
      const shared = join(rootDir, ".fusion", "worktrees", "shared");
      const aliases = spellingsOf(rootDir, alias);
      const task = {
        worktree: aliases[aliases.length - 1],
        workspaceWorktrees: Object.fromEntries([shared, ...aliases].map((worktreePath, index) => [`repo-${index}`, {worktreePath, branch: `fusion/${index}`}])),
      } as never;

      const {plan, singularDeduplicated} = await buildWorkspaceDisposalPlan({rootDir} as TaskStore, task);

      expect(plan).toHaveLength(1);
      expect(plan[0]!.repoRel).toBe("repo-0");
      expect(plan[0]!.aliasRepoRels).toEqual([...aliases.map((_, index) => `repo-${index + 1}`), "__singular_worktree__"]);
      expect(singularDeduplicated).toBe(true);
    });

    it("never disposes a singular worktree that is a spelling of the project root", async () => {
      const {rootDir, alias} = hostRoot();
      const rootSpellings = [alias, `${rootDir}${process.platform === "win32" ? "\\" : "/"}`];
      if (process.platform === "win32") rootSpellings.push(rootDir.toLowerCase(), `\\\\?\\${rootDir}`);
      for (const worktree of rootSpellings) {
        const store = {rootDir, getSettings: async () => ({})} as unknown as TaskStore;
        const disposer = vi.fn(async () => undefined);
        registerArchiveWorktreeDisposer(store, disposer);
        await expect(disposeArchivedWorktree(store, {id: "FN-1", worktree} as never)).resolves.toEqual({refusedLive: false});
        expect(disposer).not.toHaveBeenCalled();
      }
    });
  });
});
