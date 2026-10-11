import { describe, expect, it } from "vitest";
import { inferWorkflowStepVerdictFromProse, parseWorkflowStepVerdict } from "../executor.js";

/*
FNXC:WorkflowStepResults 2026-06-26: the WORKFLOW_STEP_TEMPLATES catalog was deleted
(graph-native cutover, plan U6) — built-in quality gates now live as optional-group IR
nodes whose prompt envelopes are asserted by the core builtin-group tests. This suite
retains the executor-owned VERDICT PARSER coverage (`parseWorkflowStepVerdict` /
`inferWorkflowStepVerdictFromProse`), which the graph path still uses to interpret
prompt-mode workflow-step output, independent of any template catalog.
*/
describe("workflow step verdict parsing", () => {
  it("parses canonical structured verdicts", () => {
    expect(parseWorkflowStepVerdict('{"verdict":"APPROVE","notes":""}')).toEqual({
      verdict: "APPROVE",
      notes: "",
    });
    expect(parseWorkflowStepVerdict('{"verdict":"APPROVE","notes":"out of scope"}')).toEqual({
      verdict: "APPROVE",
      notes: "out of scope",
    });
    expect(parseWorkflowStepVerdict('{"verdict":"APPROVE_WITH_NOTES","notes":"advisory only"}')).toEqual({
      verdict: "APPROVE_WITH_NOTES",
      notes: "advisory only",
    });
    expect(parseWorkflowStepVerdict('{"verdict":"REVISE","notes":"fix auth"}')).toEqual({
      verdict: "REVISE",
      notes: "fix auth",
    });
  });

  /*
  FNXC:PostMergeEvidenceWait 2026-10-08-19:12:
  KB-080: the built-in post-merge verification prompt's own verdict shape lists WAIT, and a WAIT in that
  shape parses only in the post-merge phase.
  */
  it("accepts the built-in post-merge WAIT payload only in the post-merge phase", () => {
    const payload = '{"verdict":"WAIT","notes":"Full Suite run 37763174330 is still queued.","evidencePending":{"state":"run-queued","runId":"37763174330"}}';
    expect(parseWorkflowStepVerdict(payload, { postMergePhase: true })).toEqual({
      verdict: "WAIT",
      notes: "Full Suite run 37763174330 is still queued.",
      evidencePending: { state: "run-queued", runId: "37763174330" },
    });
    expect(parseWorkflowStepVerdict(payload)).toBeNull();
  });

  it("infers REVISE from the legacy prose fallback", () => {
    expect(inferWorkflowStepVerdictFromProse("REQUEST REVISION\nfix packages/foo.ts")).toEqual({
      verdict: "REVISE",
      notes: "fix packages/foo.ts",
    });
  });
});
