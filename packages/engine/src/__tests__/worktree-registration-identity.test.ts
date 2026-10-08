import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const injected = vi.hoisted(() => ({ failWhen: null as null | ((command: string) => boolean) }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const exec = ((command: string, options: unknown, callback?: (...cbArgs: unknown[]) => void) => {
    const cb = typeof options === "function" ? options as typeof callback : callback;
    if (injected.failWhen?.(command)) {
      const err = Object.assign(new Error(`Command failed: ${command}\nfatal: Unable to create '.git/index.lock': File exists.`), {
        code: 128,
        stderr: "fatal: Unable to create '.git/index.lock': File exists.",
      });
      setImmediate(() => cb?.(err, "", err.stderr));
      return undefined;
    }
    return actual.exec(command, (typeof options === "function" ? {} : options) as never, cb as never);
  }) as typeof actual.exec;
  Object.assign(exec, {
    [promisify.custom]: (command: string, options?: unknown) =>
      new Promise((resolve, reject) => {
        exec(command, (options ?? {}) as never, ((err: Error | null, stdout: string, stderr: string) =>
          err ? reject(Object.assign(err, { stdout, stderr })) : resolve({ stdout, stderr })) as never);
      }),
  });
  return { ...actual, exec };
});

const pool = await import("../worktree/worktree-pool.js");
const { assertWorktreePathNotNested, NonRetryableWorktreeError } = await import("../executor/worktree-registry-helpers.js");
const { tryCreateWorktree } = await import("../executor/worktree-create-conflict.js");
const { cleanupLandedTaskWorktree } = await import("../merge/post-landing-worktree-cleanup.js");
const { CHECKOUT_REMOVAL_RESIDUE_MARKER } = await import("../worktree/remove-checkout.js");

const tracked: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function repo(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "fusion-wt-identity-")));
  tracked.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

/**
 * A second spelling of `path` that names the same directory: case-folded on win32 (case-insensitive volumes), a symlink alias elsewhere.
 */
function spellingVariant(path: string): string {
  if (process.platform === "win32") return path.replace(/[a-z]/g, (c) => c.toUpperCase());
  const aliasParent = mkdtempSync(join(tmpdir(), "fusion-wt-alias-"));
  tracked.push(aliasParent);
  const alias = join(aliasParent, "alias");
  symlinkSync(path, alias);
  return alias;
}

function liveWorktree(root: string, name = "fn-1"): string {
  const path = join(root, ".worktrees", name);
  git(root, "worktree", "add", "-q", "-b", `fusion/${name}`, path);
  writeFileSync(join(path, "uncommitted.txt"), "agent work\n");
  return path;
}

const store = () => ({ logEntry: vi.fn(async () => undefined), getSettings: vi.fn(async () => ({})), updateTask: vi.fn(async () => ({})) });

function createDeps(root: string, logStore = store()) {
  const unused = vi.fn(async () => { throw new Error("unexpected recovery call"); });
  return {
    rootDir: root,
    store: logStore,
    maxWorktreeRetries: 3,
    recoverIndexLockIfStale: vi.fn(async () => false),
    recoverStaleRegistration: vi.fn(async () => false),
    cleanupStaleBranch: vi.fn(async () => false),
    handleWorktreeConflict: vi.fn(async () => null),
    tryCreateWorktree: unused,
    tryFreshWorktreeAfterLiveConflict: unused,
    cleanupConflictingWorktree: vi.fn(async () => false),
    normalizeReclaimableWorktreePath: vi.fn(async (source: string) => source),
    isLiveCleanupRefusal: vi.fn(async () => false),
  } as never;
}

const failWorktreeList = (command: string) => command.includes("worktree list");

beforeEach(() => {
  injected.failWhen = null;
});

afterEach(() => {
  injected.failWhen = null;
  for (const dir of tracked.splice(0).reverse()) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
  }
});

/*
FNXC:PathIdentity 2026-10-07-19:23:
Two spellings of one directory are one worktree identity: the repo-root check, the nested-worktree guard, and registration membership must agree for any spelling of the project root or a task worktree.
*/
describe("worktree identity is spelling-independent", () => {
  it("treats a spelling variant of the project root as the root", () => {
    const root = repo();
    expect(pool.isRepoRootPath(root, spellingVariant(root))).toBe(true);
  });

  it("does not report a task path as nested when the root is stored in another spelling", async () => {
    const root = repo();
    const variant = spellingVariant(root);
    await expect(assertWorktreePathNotNested(variant, store(), join(variant, ".worktrees", "fn-1"), "FN-1")).resolves.toBeUndefined();
  });

  it("recognizes a live worktree as registered and usable under another spelling", async () => {
    const root = repo();
    const wt = liveWorktree(root);
    const variant = spellingVariant(root);
    const variantWt = join(variant, ".worktrees", "fn-1");

    expect(await pool.isRegisteredGitWorktree(variant, variantWt)).toBe(true);
    expect(await pool.classifyTaskWorktree(variant, variantWt)).toEqual({ ok: true });
    expect(readFileSync(join(wt, "uncommitted.txt"), "utf-8")).toBe("agent work\n");
  });

  it("reuses rather than deletes a live worktree reached through another root spelling", async () => {
    const root = repo();
    const wt = liveWorktree(root);
    const variant = spellingVariant(root);

    const created = await tryCreateWorktree(createDeps(variant), "fusion/fn-1", join(variant, ".worktrees", "fn-1"), "FN-1");

    expect(created.branch).toBe("fusion/fn-1");
    expect(readFileSync(join(wt, "uncommitted.txt"), "utf-8")).toBe("agent work\n");
  });
});

/*
FNXC:WorktreeLiveness 2026-10-07-19:23:
Registration is tri-state. A `git worktree list` that cannot run is unknown, never "unregistered": no caller deletes, clears a pointer, or reclaims on it.
*/
describe("an inconclusive registration probe never reads as unregistered", () => {
  /*
  FNXC:WorktreeLiveness 2026-10-08-07:40:
  A repository root that does not exist, or that git positively reports is not a repository, has no registrations: that is proof, not an unknown.
  Reset and cleanup of workspace members whose sub-repository root is gone must not fail on a `spawn` with a missing cwd.
  */
  it("reports no registrations for a repository root that does not exist", async () => {
    const parent = mkdtempSync(join(tmpdir(), "fusion-wt-missing-root-"));
    tracked.push(parent);
    const missing = join(parent, "gone");

    await expect(pool.getRegisteredWorktreePaths(missing)).resolves.toEqual(new Set());
    await expect(pool.getRegisteredWorktreeBranches(missing)).resolves.toEqual([]);
    await expect(pool.isRegisteredGitWorktree(missing, join(missing, ".worktrees", "fn-1"))).resolves.toBe(false);
  });

  it("reports no registrations for a directory git says is not a repository", async () => {
    const plain = mkdtempSync(join(tmpdir(), "fusion-wt-not-a-repo-"));
    tracked.push(plain);
    process.env.GIT_CEILING_DIRECTORIES = dirname(plain);
    try {
      await expect(pool.getRegisteredWorktreePaths(plain)).resolves.toEqual(new Set());
    } finally {
      delete process.env.GIT_CEILING_DIRECTORIES;
    }
  });

  it("throws a distinct error from the registration lister", async () => {
    const root = repo();
    injected.failWhen = failWorktreeList;
    await expect(pool.getRegisteredWorktreePaths(root)).rejects.toBeInstanceOf(pool.WorktreeRegistrationUnknownError);
    await expect(pool.isRegisteredGitWorktree(root, join(root, ".worktrees", "fn-1"))).rejects.toBeInstanceOf(pool.WorktreeRegistrationUnknownError);
  });

  it("classifies a .git-bearing checkout as registration-unknown, not unregistered", async () => {
    const root = repo();
    const wt = liveWorktree(root);
    injected.failWhen = failWorktreeList;
    expect(await pool.classifyTaskWorktree(root, wt)).toMatchObject({ ok: false, classification: "registration-unknown" });
  });

  it("creation keeps an existing worktree and fails retryably when registration is unknown", async () => {
    const root = repo();
    const wt = liveWorktree(root);
    injected.failWhen = failWorktreeList;

    const attempt = tryCreateWorktree(createDeps(root), "fusion/fn-1", wt, "FN-1");

    await expect(attempt).rejects.toBeInstanceOf(pool.WorktreeRegistrationUnknownError);
    await expect(attempt).rejects.not.toBeInstanceOf(NonRetryableWorktreeError);
    expect(readFileSync(join(wt, "uncommitted.txt"), "utf-8")).toBe("agent work\n");
  });

  it("pool sweeps act on nothing when registration is unknown", async () => {
    const root = repo();
    const wt = liveWorktree(root);
    const taskStore = { listTasks: vi.fn(async () => []) } as never;
    injected.failWhen = failWorktreeList;

    await expect(pool.scanIdleWorktrees(root, taskStore)).resolves.toEqual([]);
    await expect(pool.cleanupOrphanedWorktrees(root, taskStore)).resolves.toBe(0);
    await expect(pool.reapOrphanWorktrees(root, {}, { store: taskStore })).resolves.toBe(0);
    expect(readFileSync(join(wt, "uncommitted.txt"), "utf-8")).toBe("agent work\n");
  });

  it("post-landing cleanup re-probes a classifier 'unregistered' verdict the filesystem contradicts", async () => {
    const root = repo();
    const wt = liveWorktree(root);
    rmSync(join(wt, "uncommitted.txt"));
    const audit = { git: vi.fn(async () => undefined) };

    const result = await cleanupLandedTaskWorktree({
      store: store() as never,
      taskId: "FN-1",
      worktreePath: wt,
      rootDir: root,
      landedSha: "abc123",
      source: "ai-merge-finalize",
      audit: audit as never,
      probeWorktreeState: async () => ({ ok: false, classification: "unregistered", reason: "transient list failure" }),
    });

    expect(result.outcome).not.toBe("residual-unusable");
    const preExisting = audit.git.mock.calls.map(([event]) => event as { type: string; metadata?: { phase?: string } })
      .filter((event) => event.type === "worktree:removal-partial" && event.metadata?.phase === "pre-existing");
    expect(preExisting).toEqual([]);
  });
});

/*
FNXC:WorktreeCreation 2026-10-07-19:23:
A directory that pre-exists at the creation path is deleted only when nothing in it can be lost: it is empty, or it is residue a deletion-authorized removal marked.
*/
describe("creation never deletes an unproven pre-existing directory", () => {
  it("refuses, and preserves, a non-empty unregistered directory", async () => {
    const root = repo();
    const path = join(root, ".worktrees", "fn-1");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "notes.md"), "operator notes\n");

    await expect(tryCreateWorktree(createDeps(root), "fusion/fn-1", path, "FN-1")).rejects.toBeInstanceOf(NonRetryableWorktreeError);
    expect(readFileSync(join(path, "notes.md"), "utf-8")).toBe("operator notes\n");
  });

  it("replaces an empty directory", async () => {
    const root = repo();
    const path = join(root, ".worktrees", "fn-1");
    mkdirSync(path, { recursive: true });

    await expect(tryCreateWorktree(createDeps(root), "fusion/fn-1", path, "FN-1")).resolves.toMatchObject({ path });
    expect(existsSync(join(path, ".git"))).toBe(true);
  });

  it("replaces marker-authorized residue", async () => {
    const root = repo();
    const path = join(root, ".worktrees", "fn-1");
    mkdirSync(join(path, "locked"), { recursive: true });
    writeFileSync(join(path, "locked", "file.txt"), "left behind\n");
    writeFileSync(join(path, CHECKOUT_REMOVAL_RESIDUE_MARKER), "{}\n");

    await expect(tryCreateWorktree(createDeps(root), "fusion/fn-1", path, "FN-1")).resolves.toMatchObject({ path });
    expect(existsSync(join(path, "locked", "file.txt"))).toBe(false);
    expect(existsSync(join(path, ".git"))).toBe(true);
  });
});

/*
FNXC:WindowsShell 2026-10-07-19:23:
Orphan `fusion/*` branch discovery runs git without a shell, so the glob reaches git unquoted on every platform.
*/
describe("scanOrphanedBranches", () => {
  it("lists fusion branches no active task owns", async () => {
    const root = repo();
    git(root, "branch", "fusion/fn-1");
    git(root, "branch", "fusion/fn-2");
    git(root, "branch", "feature/other");
    const taskStore = {
      listTasks: vi.fn(async () => [{ id: "FN-1", column: "in-progress", branch: "fusion/fn-1" }]),
      getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    } as never;

    await expect(pool.scanOrphanedBranches(root, taskStore)).resolves.toEqual(["fusion/fn-2"]);
  });
});
