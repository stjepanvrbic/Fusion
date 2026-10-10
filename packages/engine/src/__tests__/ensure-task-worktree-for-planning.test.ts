import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, TaskDetail, TaskStore } from "@fusion/core";
import { ensureTaskWorktreeForPlanning, type EnsureTaskWorktreeForPlanningDeps } from "../executor/ensure-task-worktree-for-planning.js";
import * as worktreePool from "../worktree/worktree-pool.js";

/*
FNXC:WorktreeSessionRecovery 2026-10-10-17:21:
Symptom: on Windows a removal can unregister a checkout and leave its directory behind ("Directory not empty").
Planning reused any recorded worktree whose directory existed, so the residue was handed to the session, which refused
to start in an incomplete worktree, and every retry reused the same dead path.
Invariant: planning reuses a recorded worktree only when it is a usable checkout; residue or a missing directory is
re-acquired. The control keeps a usable checkout without a second acquisition.
*/

describe("ensureTaskWorktreeForPlanning", () => {
  let rootDir: string;
  let residue: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "fusion-planning-root-"));
    residue = mkdtempSync(join(tmpdir(), "fusion-planning-residue-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(residue, { recursive: true, force: true });
  });

  function deps(recordedWorktree: string) {
    const acquired = join(rootDir, "reacquired");
    const ensureGraphCustomNodeWorktree = vi.fn(async (task: TaskDetail) => ({ ...task, worktree: acquired }) as TaskDetail);
    const store = {
      getTask: vi.fn(async () => ({ id: "FN-9701", worktree: recordedWorktree }) as TaskDetail),
      getSettings: vi.fn(async () => ({}) as Settings),
    } as unknown as TaskStore;
    const value: EnsureTaskWorktreeForPlanningDeps = {
      store,
      rootDir,
      workspaceConfigOwner: {},
      getWorkspaceConfig: () => null,
      setWorkspaceConfig: () => undefined,
      ensureGraphCustomNodeWorktree,
    };
    return { value, ensureGraphCustomNodeWorktree, acquired };
  }

  it("re-acquires when the recorded worktree is residue without git metadata", async () => {
    const { value, ensureGraphCustomNodeWorktree, acquired } = deps(residue);

    const path = await ensureTaskWorktreeForPlanning(value, "FN-9701");

    expect(path).toBe(acquired);
    expect(ensureGraphCustomNodeWorktree).toHaveBeenCalledWith(expect.objectContaining({ worktree: undefined }), expect.anything(), "planning");
  });

  it("re-acquires when the recorded worktree directory is gone", async () => {
    const { value, ensureGraphCustomNodeWorktree, acquired } = deps(join(residue, "removed"));

    expect(await ensureTaskWorktreeForPlanning(value, "FN-9701")).toBe(acquired);
    expect(ensureGraphCustomNodeWorktree).toHaveBeenCalledTimes(1);
  });

  it("reuses a usable recorded worktree without acquiring again", async () => {
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValue(true);
    const { value, ensureGraphCustomNodeWorktree } = deps(residue);

    expect(await ensureTaskWorktreeForPlanning(value, "FN-9701")).toBe(residue);
    expect(ensureGraphCustomNodeWorktree).not.toHaveBeenCalled();
  });
});
