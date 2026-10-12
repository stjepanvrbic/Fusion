import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("../../utils/projectStorage", () => ({
  getScopedItem: vi.fn(() => null),
  setScopedItem: vi.fn(),
  removeScopedItem: vi.fn(),
}));

import { getScopedItem, removeScopedItem, setScopedItem } from "../../utils/projectStorage";
import { countCapacityRiskLanes, useCapacityRiskBanner } from "../useCapacityRiskBanner";
import type { ColumnRoleFlags } from "../../utils/columnRoles";

const base = {
  agentStats: { todoTaskCount: 5, idleNonEphemeralCount: 0 },
  inProgressCount: 1,
  inReviewCount: 0,
  capacityRiskBannerEnabled: true,
  capacityRiskTodoThreshold: 3,
  settingsLoaded: true,
  currentProjectId: "p1",
};

describe("countCapacityRiskLanes", () => {
  const flagsFor = (entries: Record<string, ColumnRoleFlags>) => new Map(Object.entries(entries));

  it("counts renamed lanes by their column traits", () => {
    const tasks = [
      { id: "T-1", column: "building" },
      { id: "T-2", column: "qa" },
      { id: "T-3", column: "backlog" },
    ];
    const flags = flagsFor({
      "T-1": { countsTowardWip: true },
      "T-2": { mergeBlocker: true },
      "T-3": { hold: true },
    });

    expect(countCapacityRiskLanes(tasks, flags)).toEqual({ inProgressCount: 1, inReviewCount: 1 });
  });

  it("counts a human-review lane as in review", () => {
    const tasks = [{ id: "T-1", column: "qa" }];

    expect(countCapacityRiskLanes(tasks, flagsFor({ "T-1": { humanReview: true } }))).toEqual({
      inProgressCount: 0,
      inReviewCount: 1,
    });
  });

  it("does not count a legacy column id whose traits lack the role", () => {
    const tasks = [
      { id: "T-1", column: "in-progress" },
      { id: "T-2", column: "in-review" },
    ];
    const flags = flagsFor({ "T-1": { hold: true }, "T-2": {} });

    expect(countCapacityRiskLanes(tasks, flags)).toEqual({ inProgressCount: 0, inReviewCount: 0 });
  });

  it("counts by legacy column id when a task has no traits", () => {
    const tasks = [
      { id: "T-1", column: "in-progress" },
      { id: "T-2", column: "in-review" },
      { id: "T-3", column: "todo" },
    ];

    expect(countCapacityRiskLanes(tasks, new Map())).toEqual({ inProgressCount: 1, inReviewCount: 1 });
  });

  it("counts nothing for an empty task list", () => {
    expect(countCapacityRiskLanes([], flagsFor({ "T-1": { countsTowardWip: true } }))).toEqual({
      inProgressCount: 0,
      inReviewCount: 0,
    });
  });
});

describe("useCapacityRiskBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("computes the capacity-risk signal from counts + threshold", () => {
    const { result } = renderHook(() => useCapacityRiskBanner(base));

    expect(result.current.signal).toBeTruthy();
    expect(result.current.signal.atRisk).toBe(true);
    expect(result.current.signal.threshold).toBe(3);
  });

  it("dismiss persists to scoped storage and hides", () => {
    const { result } = renderHook(() => useCapacityRiskBanner(base));

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.dismissed).toBe(true);
    expect(setScopedItem).toHaveBeenCalledWith(expect.any(String), "true", "p1");
  });

  it("clears a prior dismissal when the banner is re-enabled after hydrate", () => {
    vi.mocked(getScopedItem).mockReturnValue("true");
    const { result, rerender } = renderHook(
      (props: { enabled: boolean }) =>
        useCapacityRiskBanner({ ...base, capacityRiskBannerEnabled: props.enabled }),
      { initialProps: { enabled: false } },
    );

    // First settings load hydrates without clearing.
    expect(result.current.dismissed).toBe(true);
    expect(removeScopedItem).not.toHaveBeenCalled();

    // Re-enabling the banner resurrects the dismissed banner.
    rerender({ enabled: true });

    expect(removeScopedItem).toHaveBeenCalledWith(expect.any(String), "p1");
    expect(result.current.dismissed).toBe(false);
  });
  it("clears a prior dismissal when the todo threshold changes after hydrate", () => {
    vi.mocked(getScopedItem).mockReturnValue("true");
    const { result, rerender } = renderHook(
      (props: { threshold: number }) =>
        useCapacityRiskBanner({ ...base, capacityRiskTodoThreshold: props.threshold }),
      { initialProps: { threshold: 3 } },
    );

    // First settings load hydrates without clearing.
    expect(result.current.dismissed).toBe(true);
    expect(removeScopedItem).not.toHaveBeenCalled();

    // Changing the threshold resurrects the previously-dismissed banner.
    rerender({ threshold: 5 });

    expect(removeScopedItem).toHaveBeenCalledWith(expect.any(String), "p1");
    expect(result.current.dismissed).toBe(false);
  });
});
