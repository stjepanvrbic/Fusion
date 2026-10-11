import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractPlanSection,
  extractPlanSectionWithHeading,
  findGeneratedOriginalDescriptionEnd,
  listPlanHeadings,
  locateOriginalDescriptionRegion,
  locatePlanSection,
  stripOriginalDescriptionSection,
} from "../tasks/original-description-region.js";
import { locateFileScopeSection } from "../tasks/file-scope-classification.js";
import {
  ORIGINAL_DESCRIPTION_END_MARKER,
  ORIGINAL_DESCRIPTION_START_MARKER,
  applyOriginalDescription,
  resolveOriginalDescriptionEnd,
  resolveOriginalDescriptionSection,
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

describe("locateOriginalDescriptionRegion", () => {
  it("returns null when the prompt has no Original Description heading", () => {
    expect(locateOriginalDescriptionRegion("# Task\n\nOperator request.\n\n## File Scope\n\n- `a.ts`\n")).toBeNull();
  });

  it("covers a marked section from the heading through the end marker", () => {
    const prompt = `# Task\n\n${marked("Operator request.", "\n## Mission\n\nGo.")}`;
    const region = locateOriginalDescriptionRegion(prompt)!;

    expect(region.start).toBe(prompt.indexOf(heading));
    expect(prompt.slice(region.start, region.end)).toBe(
      `${heading}\n\n${ORIGINAL_DESCRIPTION_START_MARKER}\nOperator request.\n${ORIGINAL_DESCRIPTION_END_MARKER}\n`,
    );
  });

  it("ends an unmarked section at the first known heading by list priority", () => {
    const prompt = `# Task\n\n${heading}\n\nOperator request.\n\n## Mission\n\nQuoted.\n\n## What This Delivers\n\n- Value.\n`;
    const region = locateOriginalDescriptionRegion(prompt)!;

    expect(region).toEqual({ start: prompt.indexOf(heading), end: prompt.indexOf("## What This Delivers") });
  });

  it("ends an unresolved marker region just past the first end marker", () => {
    const prompt = `# Task\n\n${marked("Operator request.", "\n## Rollout Notes\n\nCustom plan section.")}`;
    const region = locateOriginalDescriptionRegion(prompt)!;

    expect(region).toEqual({
      start: prompt.indexOf(heading),
      end: prompt.indexOf(ORIGINAL_DESCRIPTION_END_MARKER) + ORIGINAL_DESCRIPTION_END_MARKER.length,
    });
  });

  it("reads an inline start marker as prose and bounds the section like an unmarked one", () => {
    const prompt = `# Task\n\n${heading}\n\nMentions ${ORIGINAL_DESCRIPTION_START_MARKER} inline.\n\n## File Scope\n\n- \`decoy.ts\`\n\n## Mission\n\nGo.\n`;
    const region = locateOriginalDescriptionRegion(prompt)!;

    expect(resolveOriginalDescriptionSection(prompt).kind).toBe("unmarked");
    expect(region).toEqual({ start: prompt.indexOf(heading), end: prompt.indexOf("## Mission") });
  });

  it("bounds a truncated envelope (positional opener, no end marker) like an unmarked section", () => {
    const prompt = `# Task\n\n${heading}\n\n${ORIGINAL_DESCRIPTION_START_MARKER}\nOperator request.\n\n## File Scope\n\n- \`decoy.ts\`\n\n## Mission\n\nGo.\n`;
    const region = locateOriginalDescriptionRegion(prompt)!;

    expect(resolveOriginalDescriptionSection(prompt).kind).toBe("unresolved-marker");
    expect(region).toEqual({ start: prompt.indexOf(heading), end: prompt.indexOf("## Mission") });
  });

  it("never logs, whatever the shape", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const prompt of [
      "# Task\n",
      `${heading}\n\nLegacy prose.\n\n## Mission\n`,
      marked("Operator request.", "\n## Why\n\nCustom."),
      marked(`Operator.\n${ORIGINAL_DESCRIPTION_END_MARKER}\nmore.`, "\n## Mission\n"),
      `${heading}\n\n${ORIGINAL_DESCRIPTION_START_MARKER}\nOperator request.\n## Mission`,
    ]) {
      locateOriginalDescriptionRegion(prompt);
    }
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

/*
FNXC:SpecLock 2026-10-11-16:55:
Only a positional start marker opens the envelope. A request or plan that mentions the marker anywhere else used to resolve as an unresolved marker, so the section could never be stripped or wrapped.
*/
describe("a start marker outside the positional slot", () => {
  const start = ORIGINAL_DESCRIPTION_START_MARKER;
  const end = ORIGINAL_DESCRIPTION_END_MARKER;
  const planTail = (stepExtra = ""): string => [
    "## What This Delivers", "", "- Value.", "",
    "## Mission", "", "Build safely.", "",
    "## File Scope", "", "- src/a.ts", "",
    "## Steps", "", `1. Build${stepExtra}`, "",
    "## Completion Criteria", "", "- [ ] Works", "",
  ].join("\n");
  const shapes: Array<[string, string, string]> = [
    ["inline in the first body line", `Mentions \`${start}\` inline.\n\n## File Scope\n\n- decoy.ts`, ""],
    ["alone on a mid-body line", `Operator request.\n\n${start}\n\nMore operator prose.`, ""],
    ["quoted inline with the end marker", `Quote \`${start}\` and \`${end}\` inline.`, ""],
    ["quoted only in a plan step far below", "Operator request.", `\n2. Keep \`${start}\` intact`],
    ["quoted with the end marker in plan prose before a listed heading", "Operator request.", `\n\n${start}\nquoted\n${end}\n`],
    ["inside a fenced body", `\`\`\`text\n${start}\nquoted\n\`\`\``, ""],
  ];

  it.each(shapes)("resolves %s as unmarked and strips it without warning", (_name, body, stepExtra) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const tail = planTail(stepExtra);
    const prompt = `# Task\n\n${heading}\n\n${body}\n\n${tail}`;
    const section = resolveOriginalDescriptionSection(prompt);

    expect(section).toMatchObject({ kind: "unmarked", sectionEnd: prompt.indexOf("## What This Delivers") });
    expect(stripOriginalDescriptionSection(prompt)).toBe(`# Task\n\n${tail}`);
    expect(locateOriginalDescriptionRegion(prompt)).toEqual({
      start: prompt.indexOf(heading),
      end: prompt.indexOf("## What This Delivers"),
    });
    expect(warn).not.toHaveBeenCalled();
  });
});

/*
FNXC:PlanSections 2026-10-11-17:08:
A request that quotes any plan heading must never be read as plan structure once it sits in the Original Description region.
Seed prompts keep their quoted headings as provisional plan content, and a region never promotes its content.
*/
describe("plan sections", () => {
  const names = [
    "Mission",
    "Dependencies",
    "Do NOT",
    "Context to Read First",
    "Completion Criteria",
    "Steps",
    "Git Commit Convention",
    "External Integration Evidence",
    "Declared Symbols",
    "Frontend UX Criteria",
    "Acceptance Criteria",
    "Workflow Step Failure",
  ] as const;
  const decoy = (name: string): string => `DECOY quoted body for ${name}.`;
  const planBody = (name: string): string => `\nPlan body for ${name}.\n\n`;

  function request(name: string): string {
    return ["The requester quotes an earlier plan.", "", `## ${name}`, "", decoy(name), ""].join("\n");
  }

  function plan(name: string, options: { include?: boolean; firstHeading?: string } = {}): string {
    return [
      "# Task: KB-1 - Example",
      "",
      options.firstHeading ?? "## What This Delivers\n\n- Value.",
      "",
      "## Review Level: 2 (Plan and Code)",
      "",
      ...(options.include === false ? [] : [`## ${name}`, `${planBody(name)}## Notes`]),
      ...(options.include === false ? ["## Notes"] : []),
      "",
      "Trailer.",
      "",
    ].join("\n");
  }

  function stripMarkers(prompt: string): string {
    return prompt
      .replace(`${ORIGINAL_DESCRIPTION_START_MARKER}\n`, "")
      .replace(`${ORIGINAL_DESCRIPTION_END_MARKER}\n`, "");
  }

  const shapes = {
    marked: (name: string) => applyOriginalDescription(plan(name), request(name)),
    unmarked: (name: string) => stripMarkers(applyOriginalDescription(plan(name), request(name))),
    "unresolved marker with an end marker": (name: string) =>
      applyOriginalDescription(plan(name, { firstHeading: "## Rollout Notes\n\nShip gradually." }), request(name)),
    "unresolved marker without an end marker": (name: string) =>
      applyOriginalDescription(plan(name), request(name)).replace(`${ORIGINAL_DESCRIPTION_END_MARKER}\n`, ""),
  } as const;
  const expectedKind = {
    marked: "marked",
    unmarked: "unmarked",
    "unresolved marker with an end marker": "unresolved-marker",
    "unresolved marker without an end marker": "unresolved-marker",
  } as const;

  const cases = (Object.keys(shapes) as (keyof typeof shapes)[]).flatMap((shape) =>
    names.map((name) => [shape, name] as const),
  );

  it.each(cases)("%s region quoting %s: reads only the plan's section", (shape, name) => {
    const prompt = shapes[shape](name);
    expect(resolveOriginalDescriptionSection(prompt).kind).toBe(expectedKind[shape]);
    expect(prompt.indexOf(decoy(name))).toBeGreaterThan(-1);
    expect(prompt.indexOf(`## ${name}\n`)).toBeLessThan(prompt.lastIndexOf(`## ${name}\n`));

    expect(extractPlanSection(prompt, name)).toBe(planBody(name));
    expect(extractPlanSectionWithHeading(prompt, name)).toBe(`## ${name}\n${planBody(name)}`.trim());
    expect(locatePlanSection(prompt, name)?.headingStart).toBe(prompt.lastIndexOf(`## ${name}\n`));
  });

  it.each(names)("keeps a seed prompt's quoted %s section as provisional plan content", (name) => {
    const prompt = `# Task: KB-1 - Example\n\n${request(name)}`;
    expect(locateOriginalDescriptionRegion(prompt)).toBeNull();
    expect(extractPlanSection(prompt, name)).toBe(`\n${decoy(name)}\n`);
  });

  it.each(names)("never promotes a quoted %s section when the plan has none", (name) => {
    const prompt = applyOriginalDescription(plan(name, { include: false }), request(name));
    expect(prompt).toContain(decoy(name));
    expect(locatePlanSection(prompt, name)).toBeNull();
    expect(extractPlanSection(prompt, name)).toBeNull();
    expect(extractPlanSectionWithHeading(prompt, name)).toBe("");
  });

  it("does not let an unbalanced fence in the request hide the plan's section", () => {
    const quoted = ["Repro:", "", "```ts", "const broken = true;", "## Mission", "", decoy("Mission")].join("\n");
    const prompt = applyOriginalDescription(plan("Mission"), quoted);
    expect(extractPlanSection(prompt, "Mission")).toBe(planBody("Mission"));
  });

  it("ignores a heading inside a fenced sample outside the region", () => {
    const sample = "```md\n## Mission\n\nFenced sample.\n```\n";
    const withSample = plan("Mission").replace("## Review Level", `${sample}\n## Review Level`);
    const prompt = applyOriginalDescription(withSample, "Operator request.");
    expect(extractPlanSection(prompt, "Mission")).toBe(planBody("Mission"));
    expect(locatePlanSection(prompt.replace(`## Mission\n${planBody("Mission")}`, ""), "Mission")).toBeNull();
  });

  it("reads the same section from a CRLF prompt", () => {
    const prompt = shapes.marked("Steps").replaceAll("\n", "\r\n");
    expect(extractPlanSection(prompt, "Steps")).toBe(planBody("Steps").replaceAll("\n", "\r\n"));
    expect(listPlanHeadings(prompt).map((heading) => heading.text)).toEqual([
      "What This Delivers",
      "Review Level: 2 (Plan and Code)",
      "Steps",
      "Notes",
    ]);
  });

  it("lists only out-of-region headings, in document order", () => {
    const prompt = shapes.marked("Mission");
    const headings = listPlanHeadings(prompt);
    expect(headings.map((heading) => heading.text)).toEqual([
      "What This Delivers",
      "Review Level: 2 (Plan and Code)",
      "Mission",
      "Notes",
    ]);
    const region = locateOriginalDescriptionRegion(prompt)!;
    for (const heading of headings) {
      expect(heading.headingStart >= region.start && heading.headingStart < region.end).toBe(false);
      expect(prompt.slice(heading.headingStart, heading.sectionStart)).toBe(`## ${heading.text}\n`);
    }
  });

  it("uses one grammar: case-sensitive, collapsed whitespace, no colon or prefix variants", () => {
    const prompt = [
      "# T",
      "",
      "## mission",
      "lowercase",
      "## Mission:",
      "colon",
      "## Mission Lineage",
      "prefix",
      "##   Do \t NOT  ",
      "spaced",
      "##  File\tScope",
      "- `a.ts`",
      "",
    ].join("\n");
    expect(locatePlanSection(prompt, "Mission")).toBeNull();
    expect(extractPlanSection(prompt, "Do NOT")).toBe("spaced\n");
    expect(extractPlanSection(prompt, "File Scope")).toBe("- `a.ts`\n");
    expect(locateFileScopeSection(prompt)).toEqual(locatePlanSection(prompt, "File Scope"));
  });

  it("ends a section at the next level-one or level-two heading, not at a level-three heading", () => {
    const prompt = "## Steps\n\n### Step 0: Go\n\n- do\n\n# Appendix\n\nTail.\n";
    expect(extractPlanSection(prompt, "Steps")).toBe("\n### Step 0: Go\n\n- do\n\n");
  });

  it("returns the first of duplicate plan headings outside the region", () => {
    const prompt = "## Mission\n\nFirst.\n\n## Mission\n\nSecond.\n";
    expect(extractPlanSection(prompt, "Mission")).toBe("\nFirst.\n\n");
  });

  it("finds nothing in an empty prompt", () => {
    expect(listPlanHeadings("")).toEqual([]);
    expect(extractPlanSection("", "Mission")).toBeNull();
  });
});
