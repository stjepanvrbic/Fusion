/*
FNXC:WorktreeCleanup 2026-10-07-15:11:
Defensive `removeWorktree` (force:false) used to rethrow every git failure, so callers kept their task
pointer to whatever `git worktree remove` left behind. On Windows a locked file makes git exit non-zero
after it already deleted `.git` and the admin entry. These tests drive the real removeWorktree against a
real temp folder with a scripted git, covering: half-deleted (`.git` gone), dangling pointer, residue that
cannot be finished, a still-usable refusal, an independent repository, a checkout that was already
unusable before removal, and two callers (pre-execution release and post-landing cleanup) clearing their
pointer only when the checkout is really gone.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ExecResult = { stdout: string; stderr: string };

const gitScript = vi.hoisted(() => ({
  onRemove: undefined as undefined | ((command: string) => void),
  commands: [] as string[],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const run = (command: string): ExecResult => {
    gitScript.commands.push(command);
    if (command.startsWith("git worktree remove")) {
      gitScript.onRemove?.(command);
      return { stdout: "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  const settle = (command: string, callback?: (error: unknown, stdout: string, stderr: string) => void) => {
    try {
      const result = run(command);
      queueMicrotask(() => callback?.(null, result.stdout, result.stderr));
    } catch (error) {
      queueMicrotask(() => callback?.(error, "", String((error as { stderr?: unknown }).stderr ?? "")));
    }
  };
  const exec: any = (command: string, options: unknown, callback?: any) => {
    settle(command, typeof options === "function" ? options as any : callback);
    return {} as never;
  };
  const execFile: any = (file: string, args: string[], options: unknown, callback?: any) => {
    settle([file, ...(args ?? [])].join(" "), typeof options === "function" ? options as any : callback);
    return {} as never;
  };
  const promised = (command: string) => new Promise<ExecResult>((resolvePromise, reject) => {
    try {
      resolvePromise(run(command));
    } catch (error) {
      reject(error);
    }
  });
  exec[promisify.custom] = (command: string) => promised(command);
  execFile[promisify.custom] = (file: string, args: string[] = []) => promised([file, ...args].join(" "));
  return { ...actual, exec, execFile };
});

import { removeWorktree, RemovalReason } from "../worktree/worktree-backend.js";
import { releasePreExecutionWorktree } from "../executor/release-pre-execution-worktree.js";
import { cleanupLandedTaskWorktree } from "../merge/post-landing-worktree-cleanup.js";
import { activeSessionRegistry } from "../agents/active-session-registry.js";
import { isAuthorizedCheckoutResidue } from "../worktree/remove-checkout.js";
import { installBaselineArchiveWorktreeDisposer } from "../healing/archive-worktree-disposer-install.js";
import { getArchiveWorktreeDisposer, type TaskStore } from "@fusion/core";

const tracked: string[] = [];

function gitFailure(stderr: string): Error {
  return Object.assign(new Error(`Command failed: git worktree remove\n${stderr}`), { stderr, code: 128 });
}

/** A project root with a linked-worktree-shaped checkout and its admin entry. */
function fixture(): { root: string; worktree: string; adminDir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fusion-defensive-partial-")));
  tracked.push(root);
  const adminDir = join(root, ".git", "worktrees", "fn-x");
  mkdirSync(adminDir, { recursive: true });
  const worktree = join(root, ".fusion", "worktrees", "fn-x");
  mkdirSync(join(worktree, "locked"), { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${adminDir}\n`);
  writeFileSync(join(worktree, "feature.txt"), "feature\n");
  writeFileSync(join(worktree, "locked", "file.txt"), "held open\n");
  return { root, worktree, adminDir };
}

/** Simulates git deleting the work tree and admin entry, then failing on one locked file. */
function halfDelete(worktree: string, adminDir: string): void {
  rmSync(join(worktree, ".git"), { force: true });
  rmSync(join(worktree, "feature.txt"), { force: true });
  rmSync(adminDir, { recursive: true, force: true });
  throw gitFailure(`error: failed to delete '${worktree}': Directory not empty`);
}

function partialAudits(audit: { git: ReturnType<typeof vi.fn> }) {
  return audit.git.mock.calls.map(([event]) => event).filter((event) => event.type === "worktree:removal-partial");
}

beforeEach(() => {
  gitScript.onRemove = undefined;
  gitScript.commands = [];
  activeSessionRegistry.clear();
});

afterEach(() => {
  for (const dir of tracked.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
  }
});

describe("defensive removeWorktree settles a failure that left the checkout half-deleted", () => {
  it("finishes the residue, prunes, audits, and reports a partial removal", async () => {
    const { root, worktree, adminDir } = fixture();
    gitScript.onRemove = () => halfDelete(worktree, adminDir);
    const audit = { git: vi.fn(async () => undefined) };

    const outcome = await removeWorktree({
      rootDir: root, worktreePath: worktree, settings: {}, taskId: "FN-X", audit, reason: RemovalReason.SelfHealingReclaim,
    });

    expect(outcome).toMatchObject({ removed: true, classification: "partially-removed", checkoutState: "incomplete", residualRemoved: true });
    expect(existsSync(worktree)).toBe(false);
    expect(gitScript.commands).toContain("git worktree prune");
    expect(partialAudits(audit)).toEqual([{
      type: "worktree:removal-partial",
      target: worktree,
      metadata: { taskId: "FN-X", source: RemovalReason.SelfHealingReclaim, classification: "incomplete", phase: "during-removal", residual: false },
    }]);
  });

  it("classifies a surviving dangling gitdir pointer as unregistered residue", async () => {
    const { root, worktree, adminDir } = fixture();
    gitScript.onRemove = () => {
      rmSync(join(worktree, "feature.txt"), { force: true });
      rmSync(adminDir, { recursive: true, force: true });
      throw gitFailure(`error: failed to delete '${worktree}': Permission denied`);
    };

    const outcome = await removeWorktree({ rootDir: root, worktreePath: worktree, settings: {}, taskId: "FN-X", reason: RemovalReason.PoolPrune });

    expect(outcome).toMatchObject({ removed: true, classification: "partially-removed", checkoutState: "unregistered", residualRemoved: true });
    expect(existsSync(worktree)).toBe(false);
  });

  it("still reports the checkout as removed when the residue cannot be finished", async () => {
    const { root, worktree, adminDir } = fixture();
    gitScript.onRemove = () => halfDelete(worktree, adminDir);
    const audit = { git: vi.fn(async () => undefined) };

    const outcome = await removeWorktree({
      rootDir: root, worktreePath: worktree, settings: {}, taskId: "FN-X", audit, reason: RemovalReason.StepSessionCleanup,
      removeCheckoutResidue: async () => ({ removed: false }),
    });

    expect(outcome).toMatchObject({ removed: true, classification: "partially-removed", residualRemoved: false });
    expect(existsSync(join(worktree, "locked", "file.txt"))).toBe(true);
    expect(partialAudits(audit)[0]?.metadata).toMatchObject({ phase: "during-removal", residual: true });
  });

  it("keeps a refused but still usable checkout intact and rethrows", async () => {
    const { root, worktree } = fixture();
    const refusal = gitFailure(`fatal: '${worktree}' contains modified or untracked files, use --force to delete it`);
    gitScript.onRemove = () => { throw refusal; };
    const audit = { git: vi.fn(async () => undefined) };
    const removeCheckoutResidue = vi.fn(async () => ({ removed: true }));

    await expect(removeWorktree({
      rootDir: root, worktreePath: worktree, settings: {}, taskId: "FN-X", audit, reason: RemovalReason.SelfHealingReclaim, removeCheckoutResidue,
    })).rejects.toBe(refusal);

    expect(existsSync(join(worktree, ".git"))).toBe(true);
    expect(existsSync(join(worktree, "feature.txt"))).toBe(true);
    expect(removeCheckoutResidue).not.toHaveBeenCalled();
    expect(partialAudits(audit)).toEqual([]);
  });

  it("never deletes an independent repository left at the path", async () => {
    const { root, worktree } = fixture();
    rmSync(join(worktree, ".git"), { force: true });
    mkdirSync(join(worktree, ".git"));
    const failure = gitFailure(`fatal: '${worktree}' is a main working tree`);
    gitScript.onRemove = () => { throw failure; };

    await expect(removeWorktree({ rootDir: root, worktreePath: worktree, settings: {}, reason: RemovalReason.SelfHealingIdleSweep })).rejects.toBe(failure);
    expect(existsSync(join(worktree, "feature.txt"))).toBe(true);
  });

  it("never deletes a checkout that was already unusable before the removal ran", async () => {
    const { root, worktree } = fixture();
    rmSync(join(worktree, ".git"), { force: true });
    const failure = gitFailure(`fatal: '${worktree}' is not a working tree`);
    gitScript.onRemove = () => { throw failure; };

    await expect(removeWorktree({ rootDir: root, worktreePath: worktree, settings: {}, reason: RemovalReason.SelfHealingReclaim })).rejects.toBe(failure);
    expect(existsSync(join(worktree, "feature.txt"))).toBe(true);
  });
});

describe("callers clear their worktree pointer after a settled partial removal", () => {
  function releaseDeps(worktree: string, root: string) {
    const store = {
      getTask: vi.fn(async () => ({ id: "FN-X", worktree })),
      getSettings: vi.fn(async () => ({})),
      updateTask: vi.fn(async () => ({})),
      logEntry: vi.fn(async () => undefined),
    };
    return {
      store,
      deps: {
        store: store as never,
        rootDir: root,
        activeWorktrees: new Map<string, Set<string>>(),
        getRunContextFor: () => undefined,
        hasLiveTaskSessionSurface: () => false,
      },
    };
  }

  it("pre-execution release clears the pointer when git half-deleted the checkout", async () => {
    const { root, worktree, adminDir } = fixture();
    gitScript.onRemove = () => halfDelete(worktree, adminDir);
    const { store, deps } = releaseDeps(worktree, root);

    await expect(releasePreExecutionWorktree(deps, "FN-X", "paused")).resolves.toBe(true);

    expect(existsSync(worktree)).toBe(false);
    expect(store.updateTask).toHaveBeenCalledWith("FN-X", expect.objectContaining({ worktree: null }), undefined);
  });

  it("pre-execution release keeps the pointer when git refused a usable checkout", async () => {
    const { root, worktree } = fixture();
    gitScript.onRemove = () => { throw gitFailure(`fatal: cannot remove a locked working tree`); };
    const { store, deps } = releaseDeps(worktree, root);

    await expect(releasePreExecutionWorktree(deps, "FN-X", "paused")).resolves.toBe(false);

    expect(existsSync(join(worktree, ".git"))).toBe(true);
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("post-landing cleanup reports removed once, with a single partial-removal audit", async () => {
    const { root, worktree, adminDir } = fixture();
    gitScript.onRemove = () => halfDelete(worktree, adminDir);
    const audit = { git: vi.fn(async () => undefined) };
    const store = { getSettings: async () => ({}), updateTask: vi.fn(async () => ({})), logEntry: vi.fn(async () => undefined) };

    const result = await cleanupLandedTaskWorktree({
      store: store as never,
      taskId: "FN-X",
      worktreePath: worktree,
      rootDir: root,
      landedSha: "abc123",
      source: "ai-merge-finalize",
      audit: audit as never,
      probeWorktreeState: async () => ({ ok: true }),
    });

    expect(result).toEqual({ outcome: "removed", removed: true });
    expect(store.updateTask).toHaveBeenCalledWith("FN-X", { worktree: null });
    expect(partialAudits(audit)).toHaveLength(1);
    expect(partialAudits(audit)[0]?.metadata).toEqual({
      taskId: "FN-X", source: "ai-merge-finalize", classification: "incomplete", phase: "during-removal", residual: false,
    });
    expect(store.logEntry).toHaveBeenCalledWith("FN-X", "Post-landing worktree cleanup partially removed", expect.stringContaining("residual files deleted"));
  });
});

/*
FNXC:WorktreeCleanup 2026-10-07-19:23:
Explicit force teardown is deletion authority by itself. A folder that was already `.git`-less or dangling made git exit "is not a working tree" and every force caller (hard cancel, dispose, archive) kept its pointer to unreapable residue.
Force still never deletes a `.git` directory or a live link, and residue it cannot finish is marked so the startup reaper may reclaim it.
*/
describe("force teardown settles pre-existing residue", () => {
  const forceReasons = [
    RemovalReason.HardCancel,
    RemovalReason.ExecutorDispose,
    RemovalReason.ExecutorTransientRetry,
    RemovalReason.ExecutorStuckKilled,
    RemovalReason.WorkspaceAcquireRollback,
  ];

  for (const reason of forceReasons) {
    it(`${reason}: removes a folder that was already .git-less before the call`, async () => {
      const { root, worktree } = fixture();
      rmSync(join(worktree, ".git"), { force: true });
      gitScript.onRemove = () => { throw gitFailure(`fatal: '${worktree}' is not a working tree`); };

      const outcome = await removeWorktree({ rootDir: root, worktreePath: worktree, settings: {}, taskId: "FN-X", reason, force: true });

      expect(outcome).toMatchObject({ removed: true, classification: "partially-removed", checkoutState: "incomplete", residualRemoved: true });
      expect(existsSync(worktree)).toBe(false);
    });
  }

  it("removes a dangling-pointer folder under force", async () => {
    const { root, worktree, adminDir } = fixture();
    rmSync(adminDir, { recursive: true, force: true });
    gitScript.onRemove = () => { throw gitFailure(`fatal: '${worktree}' is not a working tree`); };

    const outcome = await removeWorktree({ rootDir: root, worktreePath: worktree, settings: {}, reason: RemovalReason.HardCancel, force: true });

    expect(outcome).toMatchObject({ removed: true, checkoutState: "unregistered", residualRemoved: true });
    expect(existsSync(worktree)).toBe(false);
  });

  it("marks residue force teardown could not finish so the reaper may reclaim it", async () => {
    const { root, worktree } = fixture();
    rmSync(join(worktree, ".git"), { force: true });
    gitScript.onRemove = () => { throw gitFailure(`fatal: '${worktree}' is not a working tree`); };

    const outcome = await removeWorktree({
      rootDir: root, worktreePath: worktree, settings: {}, reason: RemovalReason.ExecutorDispose, force: true,
      removeCheckoutResidue: async () => ({ removed: false }),
    });

    expect(outcome).toMatchObject({ removed: true, residualRemoved: false });
    expect(await isAuthorizedCheckoutResidue(worktree)).toBe(true);
  });

  it("never deletes an independent repository under force", async () => {
    const { root, worktree } = fixture();
    rmSync(join(worktree, ".git"), { force: true });
    mkdirSync(join(worktree, ".git"));
    const failure = gitFailure(`fatal: '${worktree}' is not a working tree`);
    gitScript.onRemove = () => { throw failure; };

    await expect(removeWorktree({ rootDir: root, worktreePath: worktree, settings: {}, reason: RemovalReason.ExecutorDispose, force: true })).rejects.toBe(failure);
    expect(existsSync(join(worktree, "feature.txt"))).toBe(true);
  });

  it("archive baseline disposer clears the pointer and removes a .git-less checkout", async () => {
    const { root, worktree } = fixture();
    rmSync(join(worktree, ".git"), { force: true });
    gitScript.onRemove = () => { throw gitFailure(`fatal: '${worktree}' is not a working tree`); };
    const store = { rootDir: root, getTaskWorkflowSelectionAsync: async () => undefined } as unknown as TaskStore;
    const unregister = installBaselineArchiveWorktreeDisposer(store, { rootDir: root, getSettings: async () => ({}) });
    try {
      const task = { id: "FN-X", column: "done", worktree } as { id: string; column: string; worktree?: string };
      await getArchiveWorktreeDisposer(store)!(task as never, {} as never);
      expect(task.worktree).toBeUndefined();
      expect(existsSync(worktree)).toBe(false);
    } finally {
      unregister();
    }
  });
});

describe("unfinished defensive residue carries deletion authority forward", () => {
  it("marks residue a content-proven removal could not finish", async () => {
    const { root, worktree, adminDir } = fixture();
    gitScript.onRemove = () => halfDelete(worktree, adminDir);

    await removeWorktree({
      rootDir: root, worktreePath: worktree, settings: {}, taskId: "FN-X", reason: RemovalReason.StepSessionCleanup,
      removeCheckoutResidue: async () => ({ removed: false }),
    });

    expect(await isAuthorizedCheckoutResidue(worktree)).toBe(true);
  });

  it("does not mark a checkout that was already unusable before a defensive removal", async () => {
    const { root, worktree } = fixture();
    rmSync(join(worktree, ".git"), { force: true });
    gitScript.onRemove = () => { throw gitFailure(`fatal: '${worktree}' is not a working tree`); };

    await expect(removeWorktree({ rootDir: root, worktreePath: worktree, settings: {}, reason: RemovalReason.SelfHealingReclaim })).rejects.toThrow();
    expect(await isAuthorizedCheckoutResidue(worktree)).toBe(false);
  });
});
