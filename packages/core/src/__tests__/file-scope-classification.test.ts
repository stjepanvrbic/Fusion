/**
 * FNXC:FileScopeClassification 2026-07-21-12:00:
 * Regression for root-level File Scope files with extensions. GitHub issue import
 * embeds the issue body into PROMPT.md; when that body declares `## File Scope`
 * with paths like global.json / Directory.Packages.props / MyApp.slnx, createTask
 * must not throw InvalidFileScopeError, and extractEffectiveWriteScopeFromPrompt
 * must keep all four write targets (not only nested src/... entries).
 *
 * FNXC:FileScopeClassification 2026-07-21-18:05:
 * Also covers fenced repro snippets (GitHub #2389) whose escaped backticks produced
 * tokens like `global.json\` and blocked import via InvalidFileScopeError.
 *
 * FNXC:FileScopeClassification 2026-07-21-19:00:
 * The regression invariant covers ecosystem-neutral root files, not only the four-path
 * .NET repro. Classification, create/update validation, and the public store re-export
 * must agree while duplicate, read-only, and invalid tokens remain excluded from writes.
 */
import { describe, expect, it } from "vitest";
import {
  appendFileScopeEntries,
  classifyFileScopeFromPrompt,
  extractEffectiveWriteScopeFromPrompt,
  extractFileScopeTokens,
  isValidFileScopeEntry,
  locateFileScopeSection,
} from "../tasks/file-scope-classification.js";
import {
  isValidFileScopeEntry as storeFileScopeIsValidFileScopeEntry,
  sanitizeFileScopeInPromptContent,
  validateFileScopeInPromptContent,
} from "../task-store/file-scope.js";
import { isValidFileScopeEntry as storeIsValidFileScopeEntry } from "../store.js";
import { buildBootstrapPrompt, buildRefinementSeedPrompt } from "../mesh/mesh-task-replication.js";
import {
  ORIGINAL_DESCRIPTION_END_MARKER,
  ORIGINAL_DESCRIPTION_START_MARKER,
  applyOriginalDescription,
} from "../tasks/original-description-policy.js";
import { locateOriginalDescriptionRegion } from "../tasks/original-description-region.js";

describe("isValidFileScopeEntry", () => {
  it("accepts root-level repo files with letter-leading extensions", () => {
    const roots = [
      "global.json",
      "Directory.Build.props",
      "Directory.Build.targets",
      "Directory.Packages.props",
      "nuget.config",
      "NuGet.config",
      ".editorconfig",
      "MyApp.slnx",
      "MyApp.sln",
      "Cargo.toml",
      "go.mod",
      "pyproject.toml",
      "tsconfig.json",
      "package.json",
      "pnpm-lock.yaml",
      "README.md",
      ".env",
      "AGENTS.md",
    ];
    for (const path of roots) {
      expect(isValidFileScopeEntry(path), path).toBe(true);
      expect(storeFileScopeIsValidFileScopeEntry(path), `task-store:${path}`).toBe(true);
      expect(storeIsValidFileScopeEntry(path), `store:${path}`).toBe(true);
    }
  });

  it("accepts nested files, globs, and known extensionless roots", () => {
    const samples = [
      "src/MyApp/Program.cs",
      "packages/core/src/store.ts",
      "packages/engine/src/**/*.ts",
      "packages/dashboard/app/**",
      "Makefile",
      "Dockerfile",
      "foo/Dockerfile",
    ];
    for (const path of samples) {
      expect(isValidFileScopeEntry(path), path).toBe(true);
    }
  });

  it("rejects git refs, absolute paths, bare identifiers, and version-like tokens", () => {
    const rejects = [
      "origin/main",
      "upstream/main",
      "refs/heads/main",
      "https://example.com/repo",
      "git@github.com:org/repo.git",
      "ssh://git@host/repo",
      "feature/fn-123",
      "abc1234",
      "deadbeef",
      "main",
      "todo",
      "v1.2.3",
      "/abs/path.ts",
      "../escape.ts",
      "packages/../secret.ts",
      "",
      "   ",
    ];
    for (const path of rejects) {
      expect(isValidFileScopeEntry(path), JSON.stringify(path)).toBe(false);
    }
  });

  it("keeps create/update validation and store exports on the same function", () => {
    expect(storeFileScopeIsValidFileScopeEntry).toBe(isValidFileScopeEntry);
    expect(storeIsValidFileScopeEntry).toBe(isValidFileScopeEntry);
  });
});

describe("extractEffectiveWriteScopeFromPrompt / validateFileScopeInPromptContent", () => {
  const prompt = `# Task: FN-8459

## File Scope
- \`global.json\`
- \`Directory.Packages.props\`
- \`MyApp.slnx\`
- \`src/MyApp/Program.cs\`

## Steps
- [ ] Implement
`;

  it("includes all four FN-8459-style File Scope entries in effective write scope", () => {
    expect(extractEffectiveWriteScopeFromPrompt(prompt)).toEqual([
      "global.json",
      "Directory.Packages.props",
      "MyApp.slnx",
      "src/MyApp/Program.cs",
    ]);
  });

  it("retains the broader .NET root set in effective scope", () => {
    const rootPaths = [
      ".editorconfig",
      "Directory.Build.props",
      "Directory.Build.targets",
      "Directory.Packages.props",
      "global.json",
      "nuget.config",
      "MyApp.slnx",
    ];
    const broaderPrompt = `## File Scope
${rootPaths.map((path) => `- \`${path}\` (new)`).join("\n")}
- \`src/MyApp/Program.cs\` (new)
`;

    expect(extractEffectiveWriteScopeFromPrompt(broaderPrompt)).toEqual([
      ...rootPaths,
      "src/MyApp/Program.cs",
    ]);
    expect(validateFileScopeInPromptContent(broaderPrompt).invalid).toEqual([]);
  });

  it("passes create/update File Scope validation for root-level extension paths", () => {
    const { valid, invalid } = validateFileScopeInPromptContent(prompt);
    expect(invalid).toEqual([]);
    expect(valid).toEqual([
      "global.json",
      "Directory.Packages.props",
      "MyApp.slnx",
      "src/MyApp/Program.cs",
    ]);
  });

  it("omits duplicate, read-only, conditional, and invalid tokens from write scope", () => {
    const classified = `## File Scope
- \`global.json\`
- \`global.json\`

Read-only context:
- \`Directory.Build.props\`

Files changed:
- \`src/MyApp/Program.cs\`

Only if changed:
- \`.changeset/fix.md\`

## Steps
`;
    expect(extractEffectiveWriteScopeFromPrompt(classified)).toEqual([
      "global.json",
      "src/MyApp/Program.cs",
    ]);
  });

  it("still rejects git-ref tokens inside File Scope on create/update validation", () => {
    const bad = `## File Scope
- \`packages/core/src/store.ts\`
- \`origin/main\`
`;
    const { valid, invalid } = validateFileScopeInPromptContent(bad);
    expect(valid).toEqual(["packages/core/src/store.ts"]);
    expect(invalid).toEqual(["origin/main"]);
  });

  it("ignores ## File Scope headings inside fenced code blocks (GitHub #2389 repro shape)", () => {
    // Mirrors issue body: fenced TS sample with escaped markdown backticks around paths.
    const issueBody = `## Summary

Root-level File Scope files are dropped.

## Repro (unit-level)

\`\`\`ts
import { extractEffectiveWriteScopeFromPrompt } from "packages/core/src/tasks/file-scope-classification";

const prompt = \`
## File Scope

- \\\`global.json\\\` (new)
- \\\`Directory.Packages.props\\\` (new)
- \\\`MyApp.slnx\\\` (new)
- \\\`src/MyApp/Program.cs\\\` (new)
\`;

extractEffectiveWriteScopeFromPrompt(prompt);
// actual:   ["src/MyApp/Program.cs"]
// expected: all four entries
\`\`\`
`;

    expect(extractFileScopeTokens(issueBody)).toEqual([]);
    expect(extractEffectiveWriteScopeFromPrompt(issueBody)).toEqual([]);
    expect(validateFileScopeInPromptContent(issueBody)).toEqual({ valid: [], invalid: [] });

    const bootstrap = buildBootstrapPrompt(
      "FN-8460",
      "File-Scope classifier silently drops .NET root-level files",
      `${issueBody}\n\nSource: https://github.com/Runfusion/Fusion/issues/2389`,
    );
    expect(validateFileScopeInPromptContent(bootstrap)).toEqual({ valid: [], invalid: [] });
  });

  it("still reads a real File Scope section after a fenced sample that also mentions File Scope", () => {
    const prompt = `# Task: FN-1

## Context

Example only:

\`\`\`md
## File Scope
- \\\`bogus/path\\\`
\`\`\`

## File Scope
- \`global.json\`
- \`src/MyApp/Program.cs\`

## Steps
- [ ] Go
`;
    expect(extractFileScopeTokens(prompt)).toEqual(["global.json", "src/MyApp/Program.cs"]);
    expect(extractEffectiveWriteScopeFromPrompt(prompt)).toEqual([
      "global.json",
      "src/MyApp/Program.cs",
    ]);
  });
});

/*
FNXC:FileScopeClassification 2026-10-08-05:09:
A qualifier written on one File Scope bullet belongs to that bullet only. KB-008 declared twenty write targets, several qualified "(only if ...)"; the qualifier leaked into every later bullet, the effective scope shrank to three files, and the strict squash invariant refused an approved, fully in-scope squash twice.
*/
describe("File Scope qualifiers stay on their own bullet", () => {
  const kb008Shape = `## File Scope

- \`packages/engine/src/worktree/worktree-pool.ts\` (only if the L7/L8 root cause is a probe/identity defect)
- \`packages/engine/src/merger.ts\` (plus the sync module that #21 changed, for L7)
- \`packages/dashboard/src/__tests__/task-reset-lifecycle.test.ts\` (check if affected)
- \`packages/engine/src/__tests__/reliability-interactions/_helpers.ts\` (only if the fixture is proven stale)
- \`packages/core/src/**/*.ts\` and \`packages/engine/src/**/*.ts\` (limited to the failing test files and their product code)
- \`scripts/lib/windows-known-failing-tests.json\` (remove now-passing entries)
- \`docs/solutions/test-failures/suite-only-flakes-observed-register.md\` (first-sighting records only)
- \`.changeset/kb-008-fullsuite-regressions.md\` (only if a product behavior fix ships in the published CLI package)

## Steps
`;

  it("keeps every write target after a conditional bullet, including conditional non-changeset targets", () => {
    expect(extractEffectiveWriteScopeFromPrompt(kb008Shape)).toEqual([
      "packages/engine/src/worktree/worktree-pool.ts",
      "packages/engine/src/merger.ts",
      "packages/dashboard/src/__tests__/task-reset-lifecycle.test.ts",
      "packages/engine/src/__tests__/reliability-interactions/_helpers.ts",
      "packages/core/src/**/*.ts",
      "packages/engine/src/**/*.ts",
      "scripts/lib/windows-known-failing-tests.json",
      "docs/solutions/test-failures/suite-only-flakes-observed-register.md",
    ]);
  });

  it("scopes read-only and forbidden bullet qualifiers to their own bullet", () => {
    const prompt = `## File Scope
- \`packages/core/src/a.ts\` (read-only, evidence only)
- \`packages/core/src/b.ts\`
- \`packages/core/src/c.ts\` (do not edit)
- \`packages/core/src/d.ts\`
`;
    expect(extractEffectiveWriteScopeFromPrompt(prompt)).toEqual([
      "packages/core/src/b.ts",
      "packages/core/src/d.ts",
    ]);
  });

  it("does not read qualifier words out of the paths themselves", () => {
    const prompt = `## File Scope
- \`packages/core/src/metadata/read-only-view.ts\`
- \`packages/engine/src/merge/merge-write-fence.ts\`
- \`packages/engine/src/safeguards.ts\`
`;
    expect(extractEffectiveWriteScopeFromPrompt(prompt)).toEqual([
      "packages/core/src/metadata/read-only-view.ts",
      "packages/engine/src/merge/merge-write-fence.ts",
      "packages/engine/src/safeguards.ts",
    ]);
  });

  it("still lets a standalone heading line set the context for the bullets under it", () => {
    const prompt = `## File Scope
- \`src/a.ts\` (only if needed)

Read-only context:
- \`src/ref.ts\`
- \`src/ref2.ts\` (modify the export only)

Forbidden:
- \`src/never.ts\`

Files changed:
- \`src/b.ts\`

Only if changed:
- \`.changeset/fix.md\`
- \`src/c.ts\`
`;
    expect(extractEffectiveWriteScopeFromPrompt(prompt)).toEqual([
      "src/a.ts",
      "src/ref2.ts",
      "src/b.ts",
      "src/c.ts",
    ]);
  });
});


/*
FNXC:FileScopeClassification 2026-10-11-14:50:
Operator requests routinely end with a quoted File Scope heading, a path list and an "Origin:" line.
Once planning wraps the request in the Original Description region, that quoted list must never be read, validated, sanitized or extended as the task's scope; only the plan's own section counts.
*/
describe("File Scope quoted inside the Original Description", () => {
  const planEntries = ["packages/engine/src/real.ts", "docs/testing.md"];
  const planScope = ["## File Scope", "", "- `packages/engine/src/real.ts`", "- `docs/testing.md`", ""].join("\n");

  const variants = {
    A: { bullets: ["- packages/quoted/plain.ts", "- docs/quoted.md"], origin: "Origin: an earlier planning session." },
    B: { bullets: ["- `decoy/quoted-only.ts`"], origin: "Origin: an earlier planning session." },
    C: { bullets: ["- packages/quoted/plain.ts"], origin: "Origin: the server at `commands/mcp-memory-server.js`." },
    D: { bullets: ["- packages/quoted/plain.ts"], origin: "Origin: the `@fusion/core/memory-mcp` entry point." },
    E: {
      bullets: ["- `decoy/quoted-only.ts`"],
      origin: "Origin: `commands/mcp-memory-server.js` and `@fusion/core/memory-mcp`.",
    },
  } as const;
  type Variant = keyof typeof variants;

  function description(variant: Variant): string {
    const { bullets, origin } = variants[variant];
    return ["The requester explains the defect here.", "", "## File Scope", ...bullets, "", origin].join("\n");
  }

  function plan(options: { firstHeading?: string; scope?: string } = {}): string {
    const scope = options.scope ?? planScope;
    return [
      "# Task: KB-1 - Example",
      "",
      "**Created:** 2026-10-11",
      "",
      options.firstHeading ?? "## What This Delivers\n\n- Plans can be saved.",
      "",
      "## Mission",
      "",
      "Do the planned work.",
      "",
      scope,
      "## Steps",
      "",
      "### Step 1: Work",
      "",
      "- [ ] Do it.",
      "",
    ].join("\n");
  }

  function stripMarkers(prompt: string): string {
    return prompt
      .replace(`${ORIGINAL_DESCRIPTION_START_MARKER}\n`, "")
      .replace(`${ORIGINAL_DESCRIPTION_END_MARKER}\n`, "");
  }

  const shapes = {
    marked: (variant: Variant) => applyOriginalDescription(plan(), description(variant)),
    unmarked: (variant: Variant) => stripMarkers(applyOriginalDescription(plan(), description(variant))),
    "custom successor": (variant: Variant) =>
      applyOriginalDescription(plan({ firstHeading: "## Rollout Notes\n\nShip gradually." }), description(variant)),
  } as const;

  function planHeadingOffset(prompt: string): number {
    return prompt.lastIndexOf("\n## File Scope\n") + 1;
  }

  const cases = (Object.keys(shapes) as (keyof typeof shapes)[]).flatMap((shape) =>
    (Object.keys(variants) as Variant[]).map((variant) => [shape, variant] as const),
  );

  it.each(cases)("%s region, variant %s: reads, validates and sanitizes only the plan's section", (shape, variant) => {
    const prompt = shapes[shape](variant);
    expect(locateOriginalDescriptionRegion(prompt)).not.toBeNull();
    expect(prompt.indexOf("## File Scope")).toBeLessThan(planHeadingOffset(prompt));

    expect(locateFileScopeSection(prompt)?.headingStart).toBe(planHeadingOffset(prompt));
    expect(extractFileScopeTokens(prompt)).toEqual(planEntries);
    expect(extractEffectiveWriteScopeFromPrompt(prompt)).toEqual(planEntries);
    expect(classifyFileScopeFromPrompt(prompt).entries.map((entry) => entry.token)).toEqual(planEntries);
    expect(validateFileScopeInPromptContent(prompt)).toEqual({ valid: planEntries, invalid: [] });
    expect(sanitizeFileScopeInPromptContent(prompt)).toEqual({ sanitized: prompt, dropped: [], kept: planEntries });
  });

  it("declares no scope when the plan has no File Scope section, whatever the request quotes", () => {
    const prompt = applyOriginalDescription(plan({ scope: "" }), description("E"));
    expect(locateFileScopeSection(prompt)).toBeNull();
    expect(extractEffectiveWriteScopeFromPrompt(prompt)).toEqual([]);
    expect(validateFileScopeInPromptContent(prompt)).toEqual({ valid: [], invalid: [] });
  });

  it("still reports and sanitizes an invalid token in the plan's own section, leaving the region untouched", () => {
    const scope = ["## File Scope", "", "- `packages/engine/src/real.ts`", "- `origin/main`", ""].join("\n");
    const prompt = applyOriginalDescription(plan({ scope }), description("D"));
    const region = locateOriginalDescriptionRegion(prompt)!;

    expect(validateFileScopeInPromptContent(prompt)).toEqual({
      valid: ["packages/engine/src/real.ts"],
      invalid: ["origin/main"],
    });
    const { sanitized, dropped } = sanitizeFileScopeInPromptContent(prompt);
    expect(dropped).toEqual(["origin/main"]);
    expect(sanitized).toBe(prompt.replace("- `origin/main`\n", ""));
    expect(sanitized.slice(region.start, region.end)).toBe(prompt.slice(region.start, region.end));
  });

  it("does not let an unbalanced fence in the request hide the plan's section", () => {
    const request = ["Repro:", "", "```ts", "const broken = true;", "## File Scope", "- `decoy/quoted-only.ts`"].join("\n");
    const prompt = applyOriginalDescription(plan(), request);
    expect(extractEffectiveWriteScopeFromPrompt(prompt)).toEqual(planEntries);
  });

  it("resolves the plan's section when the request quotes the marker comments literally", () => {
    const request = [
      `Hygiene writes ${ORIGINAL_DESCRIPTION_START_MARKER} and ${ORIGINAL_DESCRIPTION_END_MARKER} around requests.`,
      "",
      description("B"),
    ].join("\n");
    const prompt = applyOriginalDescription(plan(), request);
    expect(extractEffectiveWriteScopeFromPrompt(prompt)).toEqual(planEntries);
    expect(validateFileScopeInPromptContent(prompt)).toEqual({ valid: planEntries, invalid: [] });
  });

  it.each([
    ["inline", `The requester mentions ${ORIGINAL_DESCRIPTION_START_MARKER} inline.`],
    ["alone on a mid-body line", `The requester explains the defect here.\n\n${ORIGINAL_DESCRIPTION_START_MARKER}\n`],
  ])("resolves the plan's section in an unwrapped section whose request mentions the start marker %s with no end marker", (_name, mention) => {
    const request = description("B").replace("The requester explains the defect here.", mention);
    expect(request).toContain(ORIGINAL_DESCRIPTION_START_MARKER);
    const prompt = plan().replace("## What This Delivers", `## Original Description\n\n${request}\n\n## What This Delivers`);
    expect(prompt).not.toContain(ORIGINAL_DESCRIPTION_END_MARKER);
    expect(locateFileScopeSection(prompt)?.headingStart).toBe(planHeadingOffset(prompt));
    expect(extractEffectiveWriteScopeFromPrompt(prompt)).toEqual(planEntries);
  });

  it("resolves the plan's section when the prompt has CRLF line endings", () => {
    const prompt = shapes.marked("E").replaceAll("\n", "\r\n");
    expect(extractEffectiveWriteScopeFromPrompt(prompt)).toEqual(planEntries);
    expect(validateFileScopeInPromptContent(prompt)).toEqual({ valid: planEntries, invalid: [] });
  });

  it.each([
    ["bootstrap stub", () => buildBootstrapPrompt("KB-1", "Example", description("B"))],
    ["refinement seed", () => buildRefinementSeedPrompt("Example", description("B"))],
  ])("keeps a %s's quoted File Scope as its provisional declared scope", (_label, build) => {
    const prompt = build();
    expect(locateOriginalDescriptionRegion(prompt)).toBeNull();
    expect(extractEffectiveWriteScopeFromPrompt(prompt)).toEqual(["decoy/quoted-only.ts"]);
  });

  /*
  FNXC:TaskRefinementWorkflow 2026-10-11-16:10:
  Seeds are stored verbatim, never File Scope sanitized, because seed detection compares their exact content.
  Skipping the sanitizer costs nothing: the reader already excludes an invalid token from the effective write scope.
  */
  it.each([
    ["bootstrap stub", (request: string) => buildBootstrapPrompt("KB-1", "Example", request)],
    ["refinement seed", (request: string) => buildRefinementSeedPrompt("Example", request)],
  ])("excludes an invalid token from a %s's provisional scope without sanitizing", (_label, build) => {
    const request = "Tighten the guard.\n\n## File Scope\n- `packages/core/src/example.ts`\n- `origin/main`\n\nRefines: KB-0";
    const prompt = build(request);
    expect(extractEffectiveWriteScopeFromPrompt(prompt)).toEqual(["packages/core/src/example.ts"]);
    expect(extractEffectiveWriteScopeFromPrompt(sanitizeFileScopeInPromptContent(prompt).sanitized))
      .toEqual(extractEffectiveWriteScopeFromPrompt(prompt));
  });

  describe("appendFileScopeEntries", () => {
    it("appends to the plan's section and round-trips through the effective-scope reader", () => {
      const prompt = shapes.marked("B");
      const region = locateOriginalDescriptionRegion(prompt)!;
      const result = appendFileScopeEntries(prompt, ["packages/engine/src/new.ts"])!;

      expect(result.added).toEqual(["packages/engine/src/new.ts"]);
      expect(result.content.slice(region.start, region.end)).toBe(prompt.slice(region.start, region.end));
      expect(extractEffectiveWriteScopeFromPrompt(result.content)).toEqual([...planEntries, "packages/engine/src/new.ts"]);
    });

    it("adds a file listed only in the quoted section and skips one already in the plan's section", () => {
      const prompt = shapes.marked("B");
      const result = appendFileScopeEntries(prompt, ["  decoy/quoted-only.ts ", "docs/testing.md", "", "decoy/quoted-only.ts"])!;
      expect(result.added).toEqual(["decoy/quoted-only.ts"]);
      expect(extractEffectiveWriteScopeFromPrompt(result.content)).toEqual([...planEntries, "decoy/quoted-only.ts"]);

      expect(appendFileScopeEntries(prompt, ["docs/testing.md"])).toEqual({ content: prompt, added: [] });
    });

    it("writes the scope-tool shape: one line per file, a single newline before the next heading", () => {
      const prompt = "# T\n\n## File Scope\n\n- `a.ts`\n\n## Steps\n\n- go\n";
      expect(appendFileScopeEntries(prompt, ["b.ts", "c.ts"])?.content).toBe(
        "# T\n\n## File Scope\n\n- `a.ts`\n- `b.ts`\n- `c.ts`\n## Steps\n\n- go\n",
      );
      expect(appendFileScopeEntries("# T\n\n## File Scope\n\n## Steps\n", ["b.ts"])?.content).toBe(
        "# T\n\n## File Scope\n\n- `b.ts`\n## Steps\n",
      );
    });

    it("returns null when no section is located", () => {
      expect(appendFileScopeEntries(applyOriginalDescription(plan({ scope: "" }), description("B")), ["a.ts"])).toBeNull();
    });

    it("appends the line suffix and the suffixed entry is still read back", () => {
      const suffix = " <!-- scopeAutoWiden: merge -->";
      const result = appendFileScopeEntries(shapes.marked("B"), ["packages/engine/src/new.ts"], { lineSuffix: suffix })!;
      expect(result.content).toContain(`- \`packages/engine/src/new.ts\`${suffix}\n`);
      expect(extractEffectiveWriteScopeFromPrompt(result.content)).toContain("packages/engine/src/new.ts");
    });
  });
});
