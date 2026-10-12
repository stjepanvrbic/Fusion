import { describe, expect, it } from "vitest";
import { formatStepTransitionLogAction, parseStepTransitionLogAction } from "../tasks/step-transition-log.js";
import type { StepStatus } from "../types.js";

const STATUSES: StepStatus[] = ["pending", "in-progress", "done", "skipped"];

describe("step transition log action", () => {
  it("keeps the recorded text format", () => {
    expect(formatStepTransitionLogAction(4, "Testing & Verification", "done")).toBe(
      "Step 4 (Testing & Verification) → done",
    );
  });

  it.each(STATUSES)("round-trips a %s transition", (status) => {
    expect(parseStepTransitionLogAction(formatStepTransitionLogAction(12, "Implementation", status))).toEqual({
      stepIndex: 12,
      stepName: "Implementation",
      status,
    });
  });

  it.each(["Wire the seam (engine) and docs (core)", "Rename a → b", "Odd) → done (name", ""])(
    "round-trips the step name %j",
    (stepName) => {
      expect(parseStepTransitionLogAction(formatStepTransitionLogAction(0, stepName, "in-progress"))).toEqual({
        stepIndex: 0,
        stepName,
        status: "in-progress",
      });
    },
  );

  it.each([
    "Reset stuck-kill streak (forward progress: step 4 (X) → done)",
    "[integrity-warning] graph-source updateStep suppressed: step 3 (X) → done arrived after completion",
    "Ignored out-of-order done for step 2 (X) — earlier step 1 (Y) is still pending",
    "Comment added by agent",
    "[planner] stage=executor signal=stuck: Executor stage inactive for over 2h with no execution activity",
    "",
    "Step 1 (X) → failed",
    "Step 1 (X) → done and more",
    "prefix Step 1 (X) → done",
    "Step one (X) → done",
  ])("does not recognize %j", (action) => {
    expect(parseStepTransitionLogAction(action)).toBeNull();
  });
});
