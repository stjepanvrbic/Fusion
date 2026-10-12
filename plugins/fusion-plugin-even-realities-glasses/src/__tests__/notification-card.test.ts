import { describe, expect, it } from "vitest";
import { notificationCard } from "../cards.js";

const baseTask = {
  id: "FN-1",
  description: "Desc",
  title: "Ship a very long feature title for notification card behavior",
  column: "in-review",
  updatedAt: "2026-05-08T10:00:00.000Z",
  dependencies: [],
  steps: [],
  currentStep: 1,
  log: [],
} as const;

describe("notificationCard", () => {
  it.each([
    ["entered-column", "In review ·"],
    ["new-task", "New task ·"],
    ["left-column", "Moved out ·"],
    ["completed", "Done ·"],
  ] as const)("prefixes %s", (reason, prefix) => {
    const card = notificationCard(baseTask as never, reason, { now: () => new Date("2026-05-08T10:01:00.000Z") });
    expect(card.title.startsWith(prefix)).toBe(true);
    expect(card.badge).toBe("in-review");
  });

  it("titles entry into a renamed review lane the caller supplied as in review", () => {
    const card = notificationCard({ ...baseTask, column: "qa" } as never, "entered-column", {
      reviewColumns: new Set(["qa"]),
    });
    expect(card.title.startsWith("In review ·")).toBe(true);
  });

  it("titles entry into a column outside the supplied review lanes as moved in", () => {
    const card = notificationCard(baseTask as never, "entered-column", { reviewColumns: new Set(["qa"]) });
    expect(card.title.startsWith("Moved in ·")).toBe(true);
  });

  it("decides the entry title by the legacy id when the caller supplies no review lanes", () => {
    expect(notificationCard(baseTask as never, "entered-column").title.startsWith("In review ·")).toBe(true);
    expect(
      notificationCard({ ...baseTask, column: "qa" } as never, "entered-column").title.startsWith("Moved in ·"),
    ).toBe(true);
  });

  it("truncates title boundary", () => {
    const card = notificationCard(baseTask as never, "new-task", { maxCharsPerLine: 16 });
    expect(card.title).toContain("…");
  });

  it("is deterministic with fixed now", () => {
    const now = () => new Date("2026-05-08T10:05:00.000Z");
    const a = notificationCard(baseTask as never, "completed", { now });
    const b = notificationCard(baseTask as never, "completed", { now });
    expect(a).toEqual(b);
    expect(a.lines[1]).toBe("updated 5m ago");
  });
});
