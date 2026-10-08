import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_WORKTREES } from "@fusion/core";
import { formatAdmissionCapacityQueuedReason, projectCapacityAdmissionLimits } from "../concurrency/concurrency.js";
import { formatConcurrencyLimitReason } from "../scheduler.js";

describe("effective concurrency operator surfaces", () => {
  it("builds both admission ceilings for unset, configured, and worktree-bound settings", () => {
    const holders = async () => ({ runningTaskIds: [], checkoutOnlyHolderTaskIds: [] });
    const ceilings = (settings: Record<string, unknown>) => {
      const limits = projectCapacityAdmissionLimits(settings, holders);
      return { maxConcurrent: limits.maxConcurrent, worktrees: limits.worktreeCapacity?.limit ?? null };
    };
    expect(ceilings({})).toEqual({ maxConcurrent: 2, worktrees: DEFAULT_MAX_WORKTREES });
    expect(ceilings({ maxConcurrent: 6, maxWorktrees: 9 })).toEqual({ maxConcurrent: 6, worktrees: 9 });
    expect(ceilings({ maxConcurrent: 8, maxWorktrees: 4, worktreeLimitEnabled: true })).toEqual({ maxConcurrent: 8, worktrees: 4 });
    expect(ceilings({ maxConcurrent: 8, maxWorktrees: 4, worktreeLimitEnabled: false })).toEqual({ maxConcurrent: 8, worktrees: null });
  });

  it("names the effective ceiling and binding setting in the shared admission reason", () => {
    expect(formatAdmissionCapacityQueuedReason({
      maxConcurrent: 8,
      maxWorktrees: 4,
      worktreeLimitEnabled: true,
      claimed: 4,
      holderTaskIds: ["FN-1"],
    })).toContain("effectiveLimit=4; bindingKnob=maxWorktrees");
  });

  it("names the effective ceiling and binding setting in scheduler diagnostics", () => {
    const reason = formatConcurrencyLimitReason({
      available: 0,
      bindingGates: ["maxWorktrees"],
      maxConcurrentGate: { used: 4, limit: 8, slack: 4 },
      maxWorktreesGate: { used: 4, limit: 4, slack: 0 },
      semaphoreGate: undefined,
      holders: { maxConcurrent: ["FN-1"], maxWorktrees: ["FN-1"], semaphore: undefined },
    });
    expect(reason).toContain("effectiveLimit=4 (bindingKnob=maxWorktrees)");
  });
});
