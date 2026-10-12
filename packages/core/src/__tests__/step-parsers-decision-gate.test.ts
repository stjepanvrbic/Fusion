import { describe, expect, it } from "vitest";

import {
  StepDecisionGateAnnotationError,
  getStepParser,
  matchStepHeadings,
  parseJsonSteps,
  parseStepHeadings,
} from "../tasks/step-parsers.js";

describe("decision-gate step annotation", () => {
  it("marks a step whose heading carries the marker and keeps the title as its name", () => {
    const steps = parseStepHeadings([
      "### Step 0: Preflight",
      "### Step 1 (decision-gate): Read the owner's choice",
      "### Step 2: Implement",
    ].join("\n"));

    expect(steps).toEqual([
      { name: "Preflight", status: "pending" },
      { name: "Read the owner's choice", status: "pending", decisionGate: true },
      { name: "Implement", status: "pending" },
    ]);
  });

  it("accepts the marker after a dependency prefix", () => {
    const steps = parseStepHeadings([
      "### Step 1: Preflight",
      "### Step 2: Research",
      "### Step 3 (depends: 1) (decision-gate): Choose the option",
      "### Step 4 (depends:) (decision-gate): Choose the vendor",
    ].join("\n"));

    expect(steps[2]).toEqual({ name: "Choose the option", status: "pending", dependsOn: [0], decisionGate: true });
    expect(steps[3]).toEqual({ name: "Choose the vendor", status: "pending", dependsOn: [], decisionGate: true });
  });

  it("leaves unannotated and dependency-only headings without the attribute", () => {
    const steps = parseStepHeadings("### Step 1: First\n### Step 2 (depends: 1): Second\n### Step 3 (optional): Third");

    expect(steps.map((step) => step.name)).toEqual(["First", "Second", "Third"]);
    for (const step of steps) expect(step).not.toHaveProperty("decisionGate");
  });

  it("treats the words inside a title as plain text", () => {
    const steps = parseStepHeadings([
      "### Step 1: Add the decision-gate parser",
      "### Step 2: Document (decision-gate) headings for planners",
      "### Step 3 (decision-gateway): Route requests",
    ].join("\n"));

    expect(steps.map((step) => step.name)).toEqual([
      "Add the decision-gate parser",
      "Document (decision-gate) headings for planners",
      "Route requests",
    ]);
    for (const step of steps) expect(step).not.toHaveProperty("decisionGate");
  });

  it.each([
    ["repeated", "### Step 1 (decision-gate) (decision-gate): Choose"],
    ["before the dependency prefix", "### Step 1: First\n### Step 2 (decision-gate) (depends: 1): Choose"],
    ["carrying content", "### Step 1 (decision-gate: owner): Choose"],
    ["carrying spaced content", "### Step 1 (decision-gate owner): Choose"],
    ["trailing the title", "### Step 1: Choose (decision-gate)"],
    ["trailing the title before a legacy dependency suffix", "### Step 0: First\n### Step 1: Choose (decision-gate) (depends: 0)"],
    ["trailing a title that also has the prefix marker", "### Step 1 (decision-gate): Choose (decision-gate)"],
    ["after an unrelated annotation", "### Step 1 (optional) (decision-gate): Choose"],
    ["followed by text before the colon", "### Step 1 (decision-gate) owner call: Choose"],
    ["in another letter case", "### Step 1 (Decision-Gate): Choose"],
  ])("fails closed on a marker %s", (_label, content) => {
    expect(() => parseStepHeadings(content)).toThrow(StepDecisionGateAnnotationError);
  });

  it("names the heading and the accepted form in the refusal", () => {
    const heading = "### Step 1: Choose (decision-gate)";
    let caught: unknown;
    try { parseStepHeadings(heading); } catch (error) { caught = error; }

    expect(caught).toBeInstanceOf(StepDecisionGateAnnotationError);
    expect((caught as StepDecisionGateAnnotationError).heading).toBe(heading);
    expect((caught as Error).message).toContain(heading);
    expect((caught as Error).message).toContain("### Step N (decision-gate): Title");
    expect((caught as Error).message).toContain("### Step N (depends: …) (decision-gate): Title");
  });

  it("still reports the annotated line as a step heading", () => {
    const content = "### Step 1: First\n### Step 2 (depends: 1) (decision-gate): Choose\nbody";

    expect(matchStepHeadings(content).map((entry) => entry.match)).toEqual([
      "### Step 1: First",
      "### Step 2 (depends: 1) (decision-gate): Choose",
    ]);
  });

  it("ignores a marker quoted in the Original Description region", () => {
    const content = [
      "# Task",
      "",
      "## Original Description",
      "",
      "<!-- fusion-original-description:start -->",
      "### Step 1: Quoted (decision-gate)",
      "### Step 2 (decision-gate): Quoted gate",
      "<!-- fusion-original-description:end -->",
      "",
      "## Steps",
      "",
      "### Step 0: Preflight",
      "### Step 1: Implement",
    ].join("\n");

    expect(parseStepHeadings(content)).toEqual([
      { name: "Preflight", status: "pending" },
      { name: "Implement", status: "pending" },
    ]);
  });

  it("carries the attribute through the registered step-headings parser", () => {
    const parser = getStepParser("step-headings");

    expect(parser?.parse("### Step 1: First\n### Step 2 (decision-gate): Choose").steps).toEqual([
      { name: "First" },
      { name: "Choose", decisionGate: true },
    ]);
  });

  it("accepts a boolean decisionGate in json-steps and stores only true", () => {
    const { steps } = parseJsonSteps(JSON.stringify([
      { name: "First" },
      { name: "Choose", decisionGate: true, depends: [0] },
      { name: "Implement", decisionGate: false },
    ]));

    expect(steps).toEqual([
      { name: "First" },
      { name: "Choose", dependsOn: [0], decisionGate: true },
      { name: "Implement" },
    ]);
  });

  it.each(["yes", 1, null, []])("rejects a non-boolean json-steps decisionGate: %j", (value) => {
    expect(() => parseJsonSteps(JSON.stringify([{ name: "Choose", decisionGate: value }])))
      .toThrow(/'decisionGate' must be a boolean/);
  });
});
