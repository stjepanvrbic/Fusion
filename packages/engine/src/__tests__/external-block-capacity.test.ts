/*
FNXC:ExternalBlock 2026-10-08-08:29:
A card frozen on an external obstacle is not running: it must not consume a running-agent (maxConcurrent) slot, while its
retained checkout still counts toward maxWorktrees. A resumed frozen card re-enters through the project admission coordinator
and waits when the cap is full. Live incident: three rate-limited cards held three of six slots for 40 minutes.
*/
import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import {
  ProjectAdmissionCoordinator,
  evaluateProjectCapacity,
  formatAdmissionCapacityQueuedReason,
  projectCapacityAdmissionLimits,
  projectCapacityHoldersFromStore,
} from "../concurrency/concurrency.js";

const resolverStore = {
  getTaskWorkflowSelection: () => undefined,
  getTaskWorkflowSelectionAsync: async () => undefined,
} as never;

function card(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    description: id,
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    worktree: `/worktrees/${id.toLowerCase()}`,
    createdAt: "2026-10-08T07:00:00.000Z",
    updatedAt: "2026-10-08T07:00:00.000Z",
    ...overrides,
  };
}

function frozen(id: string, overrides: Partial<Task> = {}): Task {
  return card(id, {
    status: "blocked",
    paused: true,
    pausedReason: "external-block",
    externalBlock: {
      origin: "model-provider",
      code: "RATE_LIMIT",
      message: "429 rate_limit_error",
      source: "session-failure",
      blockedAt: "2026-10-08T07:27:00.000Z",
      resume: { column: "in-progress", currentStep: 0, worktree: `/worktrees/${id.toLowerCase()}` },
    },
    ...overrides,
  });
}

describe("frozen external-block capacity population", () => {
  it("excludes a frozen WIP park from the running ids but keeps its checkout in the worktree population", async () => {
    const noCheckout = frozen("KB-051");
    const tasks = [
      card("KB-008"),
      card("KB-032"),
      frozen("KB-046"),
      card("KB-050", { paused: true, userPaused: true }),
      { ...noCheckout, worktree: undefined, externalBlock: { ...noCheckout.externalBlock!, resume: { column: "in-progress", currentStep: 0 } } },
    ];

    const holders = await projectCapacityHoldersFromStore(resolverStore, tasks);

    expect(holders.runningTaskIds).toEqual(["KB-008", "KB-032"]);
    expect(holders.checkoutOnlyHolderTaskIds).toEqual(["KB-046"]);
  });
});

describe("two-dimension project admission", () => {
  const settings = { maxConcurrent: 6, maxWorktrees: 9, worktreeLimitEnabled: true };

  it("admits a ready execute candidate into the slot a frozen card no longer holds", async () => {
    const coordinator = new ProjectAdmissionCoordinator();
    const holders = {
      runningTaskIds: ["KB-008", "KB-032", "KB-036", "KB-049", "KB-050"],
      checkoutOnlyHolderTaskIds: ["KB-046"],
    };
    const admitted = await coordinator.admitNext({
      projectId: "frozen-admit",
      ...projectCapacityAdmissionLimits(settings, async () => holders),
      refresh: async () => [{ taskId: "KB-060", projectId: "frozen-admit", lane: "execute", start: async () => true }],
    });
    expect(admitted).toBe("KB-060");
    coordinator.releaseReservation("KB-060");
  });

  it("keeps the frozen checkout binding maxWorktrees for a candidate that needs a new worktree", async () => {
    const coordinator = new ProjectAdmissionCoordinator();
    const holders = { runningTaskIds: ["A", "B", "C", "D", "E"], checkoutOnlyHolderTaskIds: ["KB-046"] };
    const limits = projectCapacityAdmissionLimits({ maxConcurrent: 8, maxWorktrees: 6, worktreeLimitEnabled: true }, async () => holders);
    const admitted = await coordinator.admitNext({
      projectId: "frozen-worktree",
      ...limits,
      refresh: async () => [{ taskId: "KB-061", projectId: "frozen-worktree", lane: "execute", start: async () => true }],
    });
    expect(admitted).toBeUndefined();
    expect(await coordinator.reserveIfAvailable({ projectId: "frozen-worktree", taskId: "KB-062", ...limits })).toBe(false);
  });

  it("lets a resumed frozen card past the worktree cap it already holds, but never past maxConcurrent", async () => {
    const coordinator = new ProjectAdmissionCoordinator();
    const worktreeBound = { maxConcurrent: 8, maxWorktrees: 6, worktreeLimitEnabled: true };
    const holders = { runningTaskIds: ["A", "B", "C", "D", "E"], checkoutOnlyHolderTaskIds: ["KB-046"] };
    const started: string[] = [];
    const admitted = await coordinator.admitNext({
      projectId: "frozen-resume",
      ...projectCapacityAdmissionLimits(worktreeBound, async () => holders),
      refresh: async () => [
        { taskId: "KB-061", projectId: "frozen-resume", lane: "execute", createdAt: "2026-10-08T06:00:00.000Z", start: async () => { started.push("KB-061"); } },
        { taskId: "KB-046", projectId: "frozen-resume", lane: "execute", createdAt: "2026-10-08T07:00:00.000Z", start: async () => { started.push("KB-046"); } },
      ],
    });
    // The older candidate needs a new worktree and is refused; the frozen card reuses its own checkout.
    expect(admitted).toBe("KB-046");
    expect(started).toEqual(["KB-046"]);
    coordinator.releaseReservation("KB-046");

    // A full running-agent cap holds the resume back: it waits for a slot instead of over-admitting.
    const full = { runningTaskIds: ["A", "B", "C", "D", "E", "F"], checkoutOnlyHolderTaskIds: ["KB-046"] };
    const waited = await coordinator.admitNext({
      projectId: "frozen-resume",
      ...projectCapacityAdmissionLimits(settings, async () => full),
      refresh: async () => [{ taskId: "KB-046", projectId: "frozen-resume", lane: "execute", start: async () => { started.push("again"); } }],
    });
    expect(waited).toBeUndefined();
    expect(started).toEqual(["KB-046"]);
  });

  /*
  FNXC:WorktreeCapacity 2026-10-08-10:05:
  The same-slot discount (a candidate's own coordinator reservation) applies to the worktree dimension too: a continuation run's own
  merge never needs a second worktree, while a new card is still refused by a frozen checkout at a full worktree cap.
  */
  it("applies the same-slot discount to both dimensions", async () => {
    const coordinator = new ProjectAdmissionCoordinator();
    const projectId = "frozen-same-slot";
    expect(await coordinator.reserveIfAvailable({ projectId, taskId: "KB-008", maxConcurrent: 8, claimed: () => 0 })).toBe(true);
    const holders = { runningTaskIds: ["A", "B"], checkoutOnlyHolderTaskIds: ["KB-046"] };
    const limits = projectCapacityAdmissionLimits({ maxConcurrent: 8, maxWorktrees: 4, worktreeLimitEnabled: true }, async () => holders);

    expect(await coordinator.admitNext({ projectId, ...limits, refresh: async () => [{ taskId: "KB-061", projectId, lane: "review", start: async () => true }] })).toBeUndefined();
    const handoffs: unknown[] = [];
    expect(await coordinator.admitNext({
      projectId,
      ...limits,
      refresh: async () => [{ taskId: "KB-008", projectId, lane: "review", start: async (handoff) => { handoffs.push(handoff); return true; } }],
    })).toBe("KB-008");
    expect(handoffs).toEqual([{ reusedReservation: true }]);
    coordinator.releaseReservation("KB-008");
  });

  it("ignores frozen checkouts entirely when worktrees are not a capacity dimension", async () => {
    const coordinator = new ProjectAdmissionCoordinator();
    const holders = { runningTaskIds: ["A"], checkoutOnlyHolderTaskIds: ["F1", "F2", "F3"] };
    const limits = projectCapacityAdmissionLimits({ maxConcurrent: 2, maxWorktrees: 1, worktreeLimitEnabled: false }, async () => holders);
    expect(limits.worktreeCapacity).toBeUndefined();
    expect(await coordinator.reserveIfAvailable({ projectId: "frozen-off", taskId: "N", ...limits })).toBe(true);
    coordinator.releaseReservation("N");
  });
});

describe("capacity exhaustion diagnostics", () => {
  it("reports the running-agent cap without naming frozen cards as holders", () => {
    const params = {
      claimed: 3,
      runningTaskIds: ["KB-008", "KB-032", "KB-036"],
      checkoutOnlyHolderTaskIds: ["KB-046", "KB-049", "KB-050"],
    };
    expect(evaluateProjectCapacity({ maxConcurrent: 6, maxWorktrees: 9, worktreeLimitEnabled: true }, params).exhausted).toBe(false);
    const full = evaluateProjectCapacity({ maxConcurrent: 3, maxWorktrees: 9, worktreeLimitEnabled: true }, params);
    expect(full.exhausted).toBe(true);
    expect(full.reason).toBe(
      "queued — maxConcurrent capacity exhausted: used=3/3; effectiveLimit=3; bindingKnob=maxConcurrent; holders=KB-008,KB-032,KB-036",
    );
  });

  it("names frozen checkouts as maxWorktrees holders when the worktree cap binds", () => {
    const reason = formatAdmissionCapacityQueuedReason({
      maxConcurrent: 8,
      maxWorktrees: 4,
      worktreeLimitEnabled: true,
      claimed: 2,
      holderTaskIds: ["KB-008", "KB-032"],
      checkoutOnlyHolderTaskIds: ["KB-046", "KB-049"],
    });
    expect(reason).toBe(
      "queued — maxWorktrees capacity exhausted: used=4/4; effectiveLimit=4; bindingKnob=maxWorktrees; holders=KB-008,KB-032,KB-046,KB-049",
    );
  });
});
