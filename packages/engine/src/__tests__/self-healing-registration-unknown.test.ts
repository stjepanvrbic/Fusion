import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Task, TaskStore } from "@fusion/core";

const registration = vi.hoisted(() => ({ unknown: true }));

vi.mock("../worktree/worktree-pool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worktree/worktree-pool.js")>();
  const fail = () => {
    throw new actual.WorktreeRegistrationUnknownError("/repo", new Error("git worktree list timed out"));
  };
  return {
    ...actual,
    getRegisteredWorktreePaths: vi.fn(async (...args: Parameters<typeof actual.getRegisteredWorktreePaths>) =>
      registration.unknown ? fail() : actual.getRegisteredWorktreePaths(...args)),
    getRegisteredWorktreeBranchMap: vi.fn(async (...args: Parameters<typeof actual.getRegisteredWorktreeBranchMap>) =>
      registration.unknown ? fail() : actual.getRegisteredWorktreeBranchMap(...args)),
    classifyTaskWorktree: vi.fn(async () => (registration.unknown
      ? { ok: false, classification: "registration-unknown", reason: "git worktree list timed out" }
      : { ok: false, classification: "unregistered", reason: "not registered" })),
  };
});

import { SelfHealingManager } from "../self-healing.js";

/*
FNXC:WorktreeLiveness 2026-10-08-00:20:
A failed `git worktree list` makes registration unknown. Self-healing must read that as "do nothing":
no backward-move proof, no pointer clear, no metadata repair. Only a proven-unregistered checkout is
actionable, which the control case keeps covered.
*/
function makeStore(tasks: Task[]) {
  const updateTask = vi.fn(async () => undefined);
  const store = Object.assign(new EventEmitter(), {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false })),
    listTasks: vi.fn(async () => tasks),
    getTask: vi.fn(async (id: string) => tasks.find((task) => task.id === id)),
    updateTask,
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
  });
  return { store: store as unknown as TaskStore, updateTask };
}

const staleTask = (overrides: Partial<Task> = {}): Task => ({
  id: "FN-RU",
  title: "t",
  description: "d",
  column: "in-progress",
  status: "failed",
  steps: [],
  dependencies: [],
  currentStep: 0,
  branch: "fusion/fn-ru",
  worktree: "/repo/.worktrees/fn-ru",
  updatedAt: "2026-01-01T00:00:00.000Z",
  columnMovedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
} as unknown as Task);

describe("self-healing treats unknown worktree registration as do-nothing", () => {
  it("reports an unknown-registration checkout as unknown, not unusable", async () => {
    registration.unknown = true;
    const { store } = makeStore([]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" } as never);
    await expect((manager as any).taskWorktreeUsability("/repo/.worktrees/fn-ru")).resolves.toBe("unknown");
    registration.unknown = false;
    await expect((manager as any).taskWorktreeUsability("/repo/.worktrees/fn-ru")).resolves.toBe("unusable");
    manager.stop();
  });

  it.each([
    ["with a recorded worktree", staleTask()],
    ["with no recorded worktree", staleTask({ worktree: undefined })],
  ])("never proves a backward move %s while registration is unknown", async (_label, task) => {
    registration.unknown = true;
    const { store } = makeStore([task]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", getExecutingTaskIds: () => new Set() } as never);
    const proof = await (manager as any).evaluateBackwardMoveTripleProof(task, {
      stage: "test", graceMs: 0, stalenessAnchor: task.updatedAt, reason: "test",
    });
    expect(proof.ok).toBe(false);
    manager.stop();
  });

  it("repairs no worktree metadata while registration is unknown", async () => {
    registration.unknown = true;
    const { store, updateTask } = makeStore([staleTask({ status: undefined })]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" } as never);
    await expect(manager.reconcileTaskWorktreeMetadata()).resolves.toBe(0);
    expect(updateTask).not.toHaveBeenCalled();
    manager.stop();
  });
});
