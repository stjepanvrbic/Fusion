import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../../api/client/client";
import { recommendationCreateRefusalReason } from "../recommendationCreateRefusal";

describe("recommendationCreateRefusalReason", () => {
  it.each([400, 404, 409, 422, 499])("returns the trimmed server reason for a %i refusal", (status) => {
    expect(recommendationCreateRefusalReason(new ApiRequestError("  Recommendations from FN-1 can be filed as tasks after FN-1 lands or completes ", status)))
      .toBe("Recommendations from FN-1 can be filed as tasks after FN-1 lands or completes");
  });

  it.each([
    ["a 500", new ApiRequestError("Internal error", 500)],
    ["a 503", new ApiRequestError("no available server", 503)],
    ["a blank 409", new ApiRequestError("   ", 409)],
    ["a transport error", new TypeError("Failed to fetch")],
    ["a non-error value", "boom"],
  ])("returns null for %s so the generic retry prompt is shown", (_label, cause) => {
    expect(recommendationCreateRefusalReason(cause)).toBeNull();
  });
});
