import { describe, expect, it } from "vitest";
import { EMPTY_MERGE_NO_LANDED_PROOF_REASON, buildEmptyMergeNoLandedProofReason, isEmptyMergeNoLandedProofPark } from "../tasks/empty-merge-park.js";

describe("empty-merge park reason", () => {
  it("carries both agents' statements and names the operator fallback for a single-repository card", () => {
    const reason = buildEmptyMergeNoLandedProofReason("KB-057", {
      mergeAgentExplanations: ["main already contains everything on fusion/kb-057"],
      reviewerDispute: "docs/testing.md on main lacks the load-timeout paragraph",
      closeAsLandedAvailable: true,
    });

    expect(reason.startsWith(EMPTY_MERGE_NO_LANDED_PROOF_REASON)).toBe(true);
    expect(reason).toContain("merge agent: main already contains everything on fusion/kb-057");
    expect(reason).toContain("reviewer disputes that the work is on main: docs/testing.md on main lacks the load-timeout paragraph");
    expect(reason).toContain('fn task close-landed KB-057 --reason "<why>"');
    expect(isEmptyMergeNoLandedProofPark({ status: "failed", error: reason })).toBe(true);
  });

  it("names no close-as-landed fallback where the action refuses (workspace tasks)", () => {
    const reason = buildEmptyMergeNoLandedProofReason("FN-1", { closeAsLandedAvailable: false });

    expect(reason).toBe(`${EMPTY_MERGE_NO_LANDED_PROOF_REASON}.`);
  });

  it("recognises the park only while the card is failed with that reason, including rows parked before the statements existed", () => {
    expect(isEmptyMergeNoLandedProofPark({ status: "failed", error: EMPTY_MERGE_NO_LANDED_PROOF_REASON })).toBe(true);
    expect(isEmptyMergeNoLandedProofPark({ status: null, error: EMPTY_MERGE_NO_LANDED_PROOF_REASON })).toBe(false);
    expect(isEmptyMergeNoLandedProofPark({ status: "failed", error: "AI merge blocked" })).toBe(false);
    expect(isEmptyMergeNoLandedProofPark({ status: "failed", error: null })).toBe(false);
  });
});
