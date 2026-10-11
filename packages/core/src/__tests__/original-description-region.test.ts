import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findGeneratedOriginalDescriptionEnd,
  stripOriginalDescriptionSection,
} from "../tasks/original-description-region.js";
import {
  ORIGINAL_DESCRIPTION_END_MARKER,
  ORIGINAL_DESCRIPTION_START_MARKER,
  resolveOriginalDescriptionEnd,
} from "../tasks/original-description-policy.js";

const heading = "## Original Description";

function marked(body: string, successor = ""): string {
  return [heading, "", ORIGINAL_DESCRIPTION_START_MARKER, body, ORIGINAL_DESCRIPTION_END_MARKER, successor]
    .filter((line, index) => line !== "" || index > 0)
    .join("\n");
}

afterEach(() => vi.restoreAllMocks());

describe("generated Original Description region", () => {
  it.each([
    "## What This Delivers\n\n- Clear operator value.",
    "## Before → After Transformation\n\n- Before: old.\n- After: new.",
    "## Review Level: 2 (Plan and Code)",
    "## Mission\n\nBuild safely.",
    "",
  ])("accepts a generated end marker before %s", (successor) => {
    const prompt = marked("Operator request.", successor ? `\n${successor}` : "");
    const start = prompt.indexOf(ORIGINAL_DESCRIPTION_START_MARKER);
    expect(findGeneratedOriginalDescriptionEnd(prompt, start)).toBe(prompt.indexOf(ORIGINAL_DESCRIPTION_END_MARKER));
  });

  it("rejects an unknown successor heading and warns without exposing prompt content", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const prompt = marked("Operator request.", "\n## Why\n\nOperator-owned context.");

    expect(findGeneratedOriginalDescriptionEnd(prompt, prompt.indexOf(ORIGINAL_DESCRIPTION_START_MARKER))).toBe(-1);
    expect(stripOriginalDescriptionSection(prompt)).toBe(prompt);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("## Why");
    expect(warn.mock.calls[0]?.[0]).not.toContain("Operator-owned context.");
  });

  it("warns when a start marker has no end marker", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const prompt = `${heading}\n\n${ORIGINAL_DESCRIPTION_START_MARKER}\nOperator request.\n## Mission`;

    expect(stripOriginalDescriptionSection(prompt)).toBe(prompt);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("## Mission");
  });

  it("strips an empty marked body before a known successor without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const prompt = marked("", "\n## What This Delivers\n\n- Value.");

    expect(stripOriginalDescriptionSection(prompt)).toBe("\n\n## What This Delivers\n\n- Value.");
    expect(warn).not.toHaveBeenCalled();
  });

  it("uses the bounded generated end marker when operator prose contains a literal marker", () => {
    const prompt = marked(
      `Literal ${ORIGINAL_DESCRIPTION_END_MARKER} remains operator prose.\n\n## Do NOT\n\nOperator constraint.`,
      "\n## What This Delivers\n\n- Value.",
    );

    expect(stripOriginalDescriptionSection(prompt)).toBe("\n\n## What This Delivers\n\n- Value.");
  });

  it("warns once after rejecting an embedded marker before the real boundary", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const prompt = marked(
      `Operator prose.\n${ORIGINAL_DESCRIPTION_END_MARKER}\nmore operator prose.`,
      "\n## What This Delivers\n\n- Value.",
    );
    const start = prompt.indexOf(ORIGINAL_DESCRIPTION_START_MARKER);
    const result = resolveOriginalDescriptionEnd(prompt, start + ORIGINAL_DESCRIPTION_START_MARKER.length);

    expect(result).toMatchObject({ resolved: true, skippedCandidateCount: 1 });
    expect(stripOriginalDescriptionSection(prompt)).toContain("## What This Delivers");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("1");
    expect(warn.mock.calls[0]?.[0]).not.toContain("more operator prose");
  });

  it("removes an unmarked section without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const prompt = "# Task\n\n## Original Description\n\nLegacy prose.\n\n## Mission\n\nBuild safely.";

    expect(stripOriginalDescriptionSection(prompt)).toBe("# Task\n\n## Mission\n\nBuild safely.");
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["bare", "Operator request.\n\n## File Scope\n\n- operator/path.ts\n\n## Mission\n\nOperator prose."],
    ["fenced", "```text\nOperator request.\n\n## File Scope\n\n- operator/path.ts\n```"],
    ["empty", ""],
  ])("ends an unmarked %s section at the highest-priority known heading, past quoted headings", (_shape, body) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const planner = "## What This Delivers\n\n- Value.\n\n## Mission\n\nBuild safely.\n\n## File Scope\n\n- src/a.ts\n";
    const prompt = `# Task\n\n**Size:** M\n\n${heading}\n\n${body}\n\n${planner}`;

    expect(stripOriginalDescriptionSection(prompt)).toBe(`# Task\n\n**Size:** M\n\n${planner}`);
    expect(warn).not.toHaveBeenCalled();
  });

  it("ends an unmarked section at the first H2 when no known heading follows", () => {
    const prompt = `# Task\n\n${heading}\n\nOperator request.\n\n## Product Overview\n\nCustom planner context.\n`;

    expect(stripOriginalDescriptionSection(prompt)).toBe("# Task\n\n## Product Overview\n\nCustom planner context.\n");
  });

  it("removes an unmarked section that runs to the end of the document", () => {
    expect(stripOriginalDescriptionSection(`# Task\n\n${heading}\n\nOperator request.\n`)).toBe("# Task\n");
  });

  it("returns a prompt without the section unchanged and without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const prompt = "# Task\n\n## Mission\n\nBuild safely.\n";

    expect(stripOriginalDescriptionSection(prompt)).toBe(prompt);
    expect(warn).not.toHaveBeenCalled();
  });

  it("gives the same remainder for marked and unmarked sections over the same plan", () => {
    const planner = "## What This Delivers\n\n- Value.\n\n## Mission\n\nBuild safely.\n";
    const body = "Operator request.\n\n## Mission\n\nOperator prose.";
    const unmarked = `# Task\n\n${heading}\n\n${body}\n\n${planner}`;

    expect(stripOriginalDescriptionSection(`# Task\n\n${marked(body, `\n${planner}`)}`)).toBe(stripOriginalDescriptionSection(unmarked));
  });
});
