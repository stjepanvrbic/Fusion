/*
FNXC:PathIdentity 2026-10-08-16:08:
KB-082: `reconcileTaskWorktreeMetadata` compares a task's persisted worktree with the paths `git worktree list` reports.
On Windows the persisted path may be spelled with an 8.3 short alias (the GitHub runner temp is `RUNNER~1`) while git reports the long name.
A live, registered worktree must not be read as stale and rebound because of that spelling; a genuinely unregistered pointer must still be repaired.
Real git fixtures are used because mocking registration would not exercise the spelling git actually prints.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";
import { hasDistinctShortAlias, nativeRealPath, realTempDir, win32ShortAlias } from "./helpers/real-path.js";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A real repository with one linked worktree checked out on `branch`. */
function createRepoWithLinkedWorktree(branch: string): { rootDir: string; worktreePath: string; scratch: string } {
  const scratch = realTempDir("kb082-worktree-metadata-");
  created.push(scratch);
  const rootDir = join(scratch, "project-root");
  mkdirSync(rootDir);
  git(rootDir, ["init", "-b", "main"]);
  git(rootDir, ["config", "user.email", "test@example.com"]);
  git(rootDir, ["config", "user.name", "Fusion Test"]);
  git(rootDir, ["commit", "--allow-empty", "-m", "initial"]);
  const worktreePath = join(rootDir, ".worktrees", "kb-082-live");
  git(rootDir, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
  return { rootDir, worktreePath: nativeRealPath(worktreePath), scratch };
}

function makeStore(tasks: Task[]) {
  const updateTask = vi.fn(async () => undefined);
  const recordRunAuditEvent = vi.fn(async () => undefined);
  const store = Object.assign(new EventEmitter(), {
    getSettings: vi.fn(async () => ({ autoMerge: true, globalPause: false, enginePaused: false })),
    listTasks: vi.fn(async () => tasks),
    getTask: vi.fn(async (id: string) => tasks.find((task) => task.id === id)),
    updateTask,
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent,
  });
  return { store: store as unknown as TaskStore, updateTask, recordRunAuditEvent };
}

function task(worktree: string, branch: string): Task {
  return {
    id: "KB-082",
    title: "t",
    description: "d",
    column: "in-progress",
    status: null,
    steps: [],
    dependencies: [],
    currentStep: 0,
    branch,
    worktree,
    log: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as Task;
}

describe("reconcileTaskWorktreeMetadata path identity", () => {
  it.runIf(process.platform === "win32")("keeps a live worktree whose persisted path is an 8.3 short alias", async () => {
    const branch = "fusion/kb-082";
    const { rootDir, worktreePath } = createRepoWithLinkedWorktree(branch);
    const shortWorktree = win32ShortAlias(worktreePath);
    if (hasDistinctShortAlias(worktreePath)) expect(shortWorktree).not.toBe(worktreePath);

    const { store, updateTask, recordRunAuditEvent } = makeStore([task(shortWorktree, branch)]);
    const manager = new SelfHealingManager(store, { rootDir, getExecutingTaskIds: () => new Set() } as never);
    try {
      await expect(manager.reconcileTaskWorktreeMetadata()).resolves.toBe(0);
      expect(updateTask).not.toHaveBeenCalled();
      expect(recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ mutationType: "task:auto-recover-worktree-metadata-rebound" }));
    } finally {
      manager.stop();
    }
  });

  it("still rebinds a pointer to a directory git does not register", async () => {
    const branch = "fusion/kb-082";
    const { rootDir, worktreePath, scratch } = createRepoWithLinkedWorktree(branch);
    const unregistered = join(scratch, "unregistered-checkout");
    mkdirSync(unregistered);

    const { store, updateTask } = makeStore([task(unregistered, branch)]);
    const manager = new SelfHealingManager(store, { rootDir, getExecutingTaskIds: () => new Set() } as never);
    try {
      await expect(manager.reconcileTaskWorktreeMetadata()).resolves.toBe(1);
      expect(updateTask).toHaveBeenCalledTimes(1);
      const [, patch] = updateTask.mock.calls[0] as unknown as [string, { worktree: string }];
      expect(nativeRealPath(patch.worktree)).toBe(worktreePath);
    } finally {
      manager.stop();
    }
  });
});
