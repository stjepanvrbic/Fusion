import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireTaskWorktree } from "../../worktree/worktree-acquisition.js";

/*
FNXC:TestIsolation 2026-10-07-18:04:
acquireTaskWorktree writes worktree lock directories under `<rootDir>/.fusion`. Threads-pool lanes keep process.cwd() at the package, so passing it as rootDir created `packages/engine/.fusion` in the checkout and broke later runs. Use a disposable project root.
*/
let rootDir: string;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "fusion-test-shared-branch-group-"));
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe("shared branch group working branch regression", () => {
  it("uses per-task working branches for shared members and keeps existing derivation modes", async () => {
    const store = {
      updateTask: vi.fn().mockResolvedValue(undefined),
      logEntry: vi.fn().mockResolvedValue(undefined),
    } as any;

    const createWorktree = vi.fn(async (branchName: string, worktreePath: string) => ({ path: worktreePath, branch: branchName }));
    const shared = { assignmentMode: "shared", groupId: "BG-1", source: "planning" } as const;

    const [a, b] = await Promise.all([
      acquireTaskWorktree({
        task: { id: "FN-201", title: "a", description: "a", branch: "clionboarding", branchContext: shared, worktree: null } as any,
        rootDir,
        store,
        settings: {},
        createWorktree,
      }),
      acquireTaskWorktree({
        task: { id: "FN-202", title: "b", description: "b", branch: "clionboarding", branchContext: shared, worktree: null } as any,
        rootDir,
        store,
        settings: {},
        createWorktree,
      }),
    ]);

    expect(a.branch).toBe("fusion/fn-201");
    expect(b.branch).toBe("fusion/fn-202");
    expect(a.branch).not.toBe(b.branch);

    const perTask = await acquireTaskWorktree({
      task: { id: "FN-203", title: "c", description: "c", branch: "fusion/custom", branchContext: { assignmentMode: "per-task-derived", groupId: "BG-1", source: "planning" }, worktree: null } as any,
      rootDir,
      store,
      settings: {},
      createWorktree,
    });
    const ungrouped = await acquireTaskWorktree({
      task: { id: "FN-204", title: "d", description: "d", branch: null, worktree: null } as any,
      rootDir,
      store,
      settings: {},
      createWorktree,
    });

    expect(perTask.branch).toBe("fusion/custom");
    expect(ungrouped.branch).toBe("fusion/fn-204");
  });
});
