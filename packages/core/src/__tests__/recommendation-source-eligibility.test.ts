import { describe, expect, it } from "vitest";
import { isRecommendationSourceActionable } from "../tasks/recommendation-source-eligibility.js";

const complete = new Set(["done"]);
const review = new Set(["in-review"]);

describe("isRecommendationSourceActionable", () => {
  it.each([
    ["complete lane", { column: "done", mergeDetails: undefined }, true],
    ["landed in review", { column: "in-review", mergeDetails: { mergeConfirmed: true } }, true],
    ["unlanded in review", { column: "in-review", mergeDetails: { mergeConfirmed: false } }, false],
    ["review without merge details", { column: "in-review", mergeDetails: undefined }, false],
    ["landed but reopened to intake", { column: "todo", mergeDetails: { mergeConfirmed: true } }, false],
    ["landed but executing again", { column: "in-progress", mergeDetails: { mergeConfirmed: true } }, false],
  ] as const)("%s", (_label, task, expected) => {
    expect(isRecommendationSourceActionable(task as never, complete, review)).toBe(expected);
  });

  it("keeps the complete-lane-only contract when no review lanes are supplied", () => {
    expect(isRecommendationSourceActionable({ column: "in-review", mergeDetails: { mergeConfirmed: true } } as never, complete)).toBe(false);
  });
});
