import { describe, expect, it } from "vitest";
import { evaluateSpecDrift, hasPriorLockDivergence, isCurrentSpecDriftReport } from "../../planner/drift-report.js";
import { canonicalizePlan, createCurrentPlanEvidence, diffSpecLocks, isSpecLockActive, isUnavailablePlanLockError, UnavailablePlanLockError } from "../../planner/spec-lock.js";
import { applyOriginalDescription, ORIGINAL_DESCRIPTION_END_MARKER, ORIGINAL_DESCRIPTION_START_MARKER, resolveOriginalDescriptionSection } from "../../tasks/original-description-policy.js";

const prompt = `# Task\n\n## Mission\n\nBuild a safe widget.\n\n## File Scope\n\n- src/widget.ts\n\n## Steps\n\n1. Build widget\n\n## Completion Criteria\n\n- [ ] Widget works\n\n## Do NOT\n\n- Change API\n\n## Dependencies\n\n- FN-1\n`;
const plannerPromptWithSummary = `# Task\n\n## What This Delivers\n\n- Deliver a safe widget.\n\n## Mission\n\nBuild a safe widget.\n\n## File Scope\n\n- src/widget.ts\n\n## Steps\n\n1. Build widget\n\n## Completion Criteria\n\n- [ ] Widget works\n\n## Do NOT\n\n- Change API\n\n## Dependencies\n\n- FN-1\n`;
const evidence = (text = prompt, version = 1) => createCurrentPlanEvidence({ version, sourceRevision: version, capturedAt: "2026-08-09T07:06:00.000Z", prompt: text });
const lock = (current = evidence()) => ({ version: 1, acceptedAt: "2026-08-09T07:06:00.000Z", approvalFingerprint: "approved", currentPlanVersion: current.version, currentPlanHash: current.plan.contentHash!, plan: current.plan });

describe("spec lock canonicalization", () => {
  it.each([
    "Mission", "File Scope", "Steps", "Completion Criteria", "Acceptance Criteria", "Do NOT", "Non-goals", "Dependencies", "Mission Lineage", "Parent-child Lineage",
  ])("ignores embedded operator heading %s without changing the planner hash", (heading) => {
    const control = applyOriginalDescription(prompt, "Operator context without structural collisions.");
    const embedded = applyOriginalDescription(prompt, `## ${heading}\n\nOperator-owned prose.`);
    expect(canonicalizePlan(embedded)).toMatchObject({ status: "available", contentHash: canonicalizePlan(control).contentHash });
  });

  it.each(["Mission", "File Scope", "Steps", "Completion Criteria", "Do NOT", "Dependencies"])("ignores tracked operator heading %s when What This Delivers follows the generated region", (heading) => {
    const control = applyOriginalDescription(plannerPromptWithSummary, "Operator context without structural collisions.");
    const embedded = applyOriginalDescription(plannerPromptWithSummary, `Operator context.\n\n## ${heading}\n\nOperator-owned prose.`);
    const canonical = canonicalizePlan(embedded);

    expect(canonical).toMatchObject({
      status: "available",
      contentHash: canonicalizePlan(control).contentHash,
      sections: { "non-goals": expect.objectContaining({ canonical: "Change API" }) },
    });
  });

  it("uses the bounded generated end marker when operator prose contains a literal marker", () => {
    const control = applyOriginalDescription(prompt, "Operator context.");
    const embedded = applyOriginalDescription(prompt, "Literal <!-- fusion-original-description:end --> remains operator prose.\n\n## Do NOT\n\nDo not alter compatibility.");
    expect(canonicalizePlan(embedded)).toMatchObject({ status: "available", contentHash: canonicalizePlan(control).contentHash });
  });

  it("keeps a quoted standalone marker inside the encoded region out of the planner structure", () => {
    const description = [
      "Quoted sample follows:",
      "<!-- fusion-original-description:end -->",
      "",
      "## Do NOT",
      "operator-owned constraint",
    ].join("\n");
    const control = applyOriginalDescription(plannerPromptWithSummary, "Operator context.");
    const encoded = applyOriginalDescription(plannerPromptWithSummary, description);

    expect(canonicalizePlan(encoded)).toMatchObject({
      status: "available",
      contentHash: canonicalizePlan(control).contentHash,
      sections: { "non-goals": expect.objectContaining({ canonical: "Change API" }) },
    });
  });

  it("keeps planner-authored duplicate sections unavailable", () => {
    expect(canonicalizePlan(`${prompt}\n## Do NOT\n\nDuplicate`)).toMatchObject({ status: "unavailable", reason: "section-duplicate" });
  });

  it("combines distinct aliases for the same planner-authored section", () => {
    const withAliases = `${prompt}\n## Non-Goals\n\n- Preserve compatibility`;
    expect(canonicalizePlan(withAliases)).toMatchObject({
      status: "available",
      sections: {
        "non-goals": expect.objectContaining({ canonical: "Change API\nPreserve compatibility" }),
      },
    });
  });

  it("keeps repeated exact aliases unavailable", () => {
    const withRepeatedAlias = `${prompt}\n## Non-Goals\n\n- Preserve compatibility\n\n## Non-Goals\n\n- Duplicate`;
    expect(canonicalizePlan(withRepeatedAlias)).toMatchObject({ status: "unavailable", reason: "section-duplicate" });
  });

  it("identifies unavailable locks without changing the established error message", () => {
    const error = new UnavailablePlanLockError("section-duplicate", ["mission", "non-goals"], "source-hash");
    expect(error.message).toBe("Cannot lock an unavailable plan: section-duplicate");
    expect(isUnavailablePlanLockError(error)).toBe(true);
    expect(isUnavailablePlanLockError(new Error(error.message))).toBe(false);
    expect(error.unavailableSections).toEqual(["mission", "non-goals"]);
  });

  it("normalizes Mission whitespace but preserves a structural Mission rewrite", () => {
    expect(canonicalizePlan(prompt).sections.mission.hash).toBe(canonicalizePlan(prompt.replace("Build a safe widget.", " Build   a safe widget. ")).sections.mission.hash);
    expect(canonicalizePlan(prompt).sections.mission.hash).toBe(canonicalizePlan(prompt.replace("Build a safe widget.", "Build a\n\n safe\twidget.")).sections.mission.hash);
    expect(canonicalizePlan(prompt).sections.mission.hash).not.toBe(canonicalizePlan(prompt.replace("safe", "different")).sections.mission.hash);
  });

  it.each(["", "\n## File Scope\n\n- a.ts", `${prompt}\n## Mission\n\nDuplicate`])("makes missing, empty, and duplicate Mission unavailable", (text) => {
    expect(canonicalizePlan(text).status).toBe("unavailable");
  });

  it("matches recursive glob boundaries without corrupting double-stars", () => {
    const recursive = evidence(prompt.replace("src/widget.ts", "src/**/*.ts"));
    expect(evaluateSpecDrift({ latestLock: lock(recursive), currentPlan: recursive, modifiedFiles: ["src/widget.ts", "src/deep/widget.ts"] }).findings).toEqual([]);
  });

  it("normalizes File Scope separators before comparing execution paths", () => {
    const windowsScope = evidence(prompt.replace("src/widget.ts", "src\\widget.ts"));
    expect(evaluateSpecDrift({ latestLock: lock(windowsScope), currentPlan: windowsScope, modifiedFiles: ["src/widget.ts"] }).findings).toEqual([]);
  });

  it("identifies deterministic Mission deviation and file scope creep", () => {
    const current = evidence(prompt.replace("safe widget", "different widget"), 2);
    const report = evaluateSpecDrift({ latestLock: lock(), currentPlan: current, modifiedFiles: ["src/other.ts"] });
    expect(report.alignment).toBe("diverged-needs-review");
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "plan-deviation", category: "mission-statement" }),
      expect.objectContaining({ kind: "scope-creep", path: "src/other.ts" }),
    ]));
  });

  it("flags additive boundaries as silent expansion and retains a stable diff", () => {
    const current = evidence(prompt.replace("- src/widget.ts", "- src/widget.ts\n- src/extra.ts"), 2);
    expect(evaluateSpecDrift({ latestLock: lock(), currentPlan: current }).findings).toContainEqual(expect.objectContaining({ kind: "silent-expansion", category: "file-scope" }));
    expect(diffSpecLocks(lock().plan, current.plan).changedSections).toEqual(["file-scope"]);
  });

  it("makes live dependency and lineage mutations comparable current-plan revisions", () => {
    const accepted = createCurrentPlanEvidence({
      version: 1,
      sourceRevision: 1,
      capturedAt: "2026-08-09T07:06:00.000Z",
      prompt,
      bindings: { dependencies: ["FN-1"], missionId: "M-1", sliceId: "S-1", sourceParentTaskId: "FN-PARENT" },
    });
    const changed = createCurrentPlanEvidence({
      version: 2,
      sourceRevision: 2,
      capturedAt: "2026-08-09T07:07:00.000Z",
      prompt,
      bindings: { dependencies: ["FN-1", "FN-2"], missionId: "M-2", sliceId: "S-1", sourceParentTaskId: "FN-PARENT" },
    });
    const permuted = createCurrentPlanEvidence({
      version: 3,
      sourceRevision: 3,
      capturedAt: "2026-08-09T07:08:00.000Z",
      prompt,
      bindings: { dependencies: ["FN-2", "FN-1", "FN-1"], missionId: "M-2", sliceId: "S-1", sourceParentTaskId: "FN-PARENT" },
    });
    const report = evaluateSpecDrift({ latestLock: lock(accepted), currentPlan: changed });
    expect(changed.sourceHash).not.toBe(accepted.sourceHash);
    expect(permuted.sourceHash).toBe(changed.sourceHash);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "silent-expansion", category: "dependencies" }),
      expect.objectContaining({ kind: "plan-deviation", category: "lineage" }),
    ]));
  });

  it.each([
    ["Steps", "1. Build widget\n2. Add another widget step", "steps"],
    ["Completion Criteria", "- [ ] Widget works\n- [ ] Another criterion", "acceptance-criteria"],
  ])("classifies added %s items as silent expansion", (heading, replacement, category) => {
    const current = evidence(prompt.replace(heading === "Steps" ? "1. Build widget" : "- [ ] Widget works", replacement), 2);
    expect(evaluateSpecDrift({ latestLock: lock(), currentPlan: current }).findings).toContainEqual(
      expect.objectContaining({ kind: "silent-expansion", category }),
    );
  });

  it("treats reordered durable steps as a plan deviation", () => {
    const expandedPrompt = prompt.replace("1. Build widget", "1. Build widget\n2. Add setup");
    const current = evidence(expandedPrompt, 2);
    const reordered = evidence(expandedPrompt.replace("1. Build widget\n2. Add setup", "1. Add setup\n2. Build widget"), 3);
    expect(evaluateSpecDrift({ latestLock: lock(current), currentPlan: reordered }).findings).toContainEqual(
      expect.objectContaining({ kind: "plan-deviation", category: "steps" }),
    );
  });

  it("reports malformed retained evidence as unavailable rather than clean", () => {
    const current = evidence();
    delete (current.plan.sections as Partial<typeof current.plan.sections>).steps;
    expect(evaluateSpecDrift({ latestLock: lock(), currentPlan: current, approvedPlanFingerprint: "approved" })).toMatchObject({
      status: "unavailable",
      reason: "malformed-plan-evidence",
      alignment: "unavailable",
    });
  });

  it("is on-plan only for matching active approval", () => {
    const current = evidence();
    const active = evaluateSpecDrift({ latestLock: lock(), currentPlan: current, approvedPlanFingerprint: "approved" });
    expect(active.alignment).toBe("on-plan");
    expect(active.approvedPlanFingerprint).toBe("approved");
    expect(isSpecLockActive(lock(), current, "approved")).toBe(true);
    expect(isSpecLockActive(lock(), current, undefined)).toBe(false);
    expect(evaluateSpecDrift({ latestLock: lock(), currentPlan: evidence() }).alignment).toBe("unavailable");
  });

  it("retains historical divergence after a clean newer lock is re-approved", () => {
    const relockedPlan = evidence(prompt.replace("safe widget", "re-scoped widget"), 2);
    const relock = {
      ...lock(relockedPlan),
      version: 2,
      approvalFingerprint: "re-approved",
      priorVersion: 1,
    };
    expect(evaluateSpecDrift({
      latestLock: relock,
      currentPlan: relockedPlan,
      approvedPlanFingerprint: "re-approved",
      priorDivergence: true,
    }).alignment).toBe("diverged-relocked-approved");
  });

  it("derives prior divergence from all retained lock versions", () => {
    const current = evidence();
    const currentLock = lock(current);
    const clean = evaluateSpecDrift({ latestLock: currentLock, currentPlan: current, approvedPlanFingerprint: "approved" });
    const unavailable = evaluateSpecDrift({});
    const divergence = evaluateSpecDrift({
      latestLock: currentLock,
      currentPlan: evidence(prompt.replace("safe widget", "different widget"), 2),
      approvedPlanFingerprint: "approved",
    });

    expect(hasPriorLockDivergence([], currentLock.version)).toBe(false);
    expect(hasPriorLockDivergence([unavailable], undefined)).toBe(false);
    expect(hasPriorLockDivergence([divergence], currentLock.version)).toBe(false);
    expect(hasPriorLockDivergence([{ ...divergence, lockVersion: 0 }, { ...divergence, lockVersion: 0 }], currentLock.version)).toBe(true);
    expect(hasPriorLockDivergence([unavailable, clean], currentLock.version)).toBe(false);
  });

  it("does not expose a report from an older current-plan revision as current", () => {
    const first = evidence(prompt, 1);
    const originalLock = lock(first);
    const report = evaluateSpecDrift({ latestLock: originalLock, currentPlan: first, approvedPlanFingerprint: "approved" });
    const rewritten = evidence(prompt.replace("safe widget", "changed widget"), 2);
    expect(isCurrentSpecDriftReport(report, originalLock, rewritten, "approved")).toBe(false);
    expect(isCurrentSpecDriftReport(report, originalLock, first, "approved")).toBe(true);
    expect(isCurrentSpecDriftReport(report, originalLock, first, undefined)).toBe(false);
  });
});

describe("spec lock across stored Original Description shapes", () => {
  const plannerSpec = [
    "# Task: KB-1 - Safe widget",
    "",
    "**Created:** 2026-10-11",
    "**Size:** M",
    "",
    "## What This Delivers",
    "",
    "- A safe widget.",
    "",
    "## Mission",
    "",
    "Build a safe widget.",
    "",
    "## File Scope",
    "",
    "- src/widget.ts",
    "",
    "## Steps",
    "",
    "1. Build widget",
    "",
    "## Completion Criteria",
    "",
    "- [ ] Widget works",
    "",
    "## Do NOT",
    "",
    "- Change API",
    "",
    "## Dependencies",
    "",
    "- **None**",
    "",
  ].join("\n");
  const lockableAliases = [
    "Mission", "File Scope", "Steps", "Completion Criteria", "Acceptance Criteria",
    "Do NOT", "Non-Goals", "Dependencies", "Mission Lineage", "Parent-Child Lineage",
  ];
  const quoting = (aliases: string[]): string => [
    "Operator request.",
    ...aliases.map((alias) => `## ${alias}\n\nOperator prose under ${alias}.`),
  ].join("\n\n");
  const unmarked = (sectionBody: string): string => plannerSpec.replace(
    "## What This Delivers",
    `## Original Description\n\n${sectionBody}\n\n## What This Delivers`,
  );
  /*
  FNXC:SpecLock 2026-10-11-17:15:
  A request or plan that mentions the start marker outside the positional slot must lock like any other section, before and after hygiene wraps it.
  The plan-side quote sits in What This Delivers, which is not a lock section, so the expected content hash is unchanged.
  */
  const start = ORIGINAL_DESCRIPTION_START_MARKER;
  const end = ORIGINAL_DESCRIPTION_END_MARKER;
  const quotingSpec = plannerSpec.replace("- A safe widget.", `- A safe widget that keeps \`${start}\` intact.`);
  const unmarkedIn = (spec: string, sectionBody: string): string => spec.replace(
    "## What This Delivers",
    `## Original Description\n\n${sectionBody}\n\n## What This Delivers`,
  );
  const markerMentions: Array<[string, (operatorBody: string) => string, string]> = [
    ["start marker inline", (body) => `Mentions \`${start}\` inline.\n\n${body}`, plannerSpec],
    ["start marker alone mid-body", (body) => `Operator lead.\n\n${start}\n\n${body}`, plannerSpec],
    ["both markers inline", (body) => `Quote \`${start}\` and \`${end}\` inline.\n\n${body}`, plannerSpec],
    ["start marker quoted in a later plan section", (body) => body, quotingSpec],
  ];
  const shapes: Array<[string, (operatorBody: string) => string]> = [
    ["bare unmarked", (body) => unmarked(body)],
    ["fenced unmarked", (body) => unmarked(`\`\`\`text\n${body}\n\`\`\``)],
    ["marked", (body) => applyOriginalDescription(plannerSpec, body)],
    ...markerMentions.flatMap(([name, sectionText, spec]): Array<[string, (operatorBody: string) => string]> => [
      [`bare unmarked with the ${name}`, (body) => unmarkedIn(spec, sectionText(body))],
      [`wrapped with the ${name}`, (body) => applyOriginalDescription(unmarkedIn(spec, sectionText(body)), sectionText(body))],
    ]),
  ];
  const quotedBodies: Array<[string, string]> = [
    ...lockableAliases.map((alias): [string, string] => [alias, quoting([alias])]),
    ["every lockable heading", quoting(lockableAliases)],
  ];
  const cases = shapes.flatMap(([shapeName, build]) => quotedBodies.map(
    ([quotedName, body]): [string, string, (operatorBody: string) => string, string] => [shapeName, quotedName, build, body],
  ));

  it.each(cases)("locks a %s section that quotes %s like the same spec without quoted headings", (_shape, _quoted, build, body) => {
    const canonical = canonicalizePlan(build(body));

    expect(canonical.status).toBe("available");
    expect(canonical.contentHash).toBe(canonicalizePlan(build("Operator request.")).contentHash);
    expect(canonical.contentHash).toBe(canonicalizePlan(plannerSpec).contentHash);
  });

  it.each(markerMentions)("wraps a section with the %s into a real envelope", (_name, sectionText, spec) => {
    const body = quoting(lockableAliases);
    const unwrapped = unmarkedIn(spec, sectionText(body));

    expect(resolveOriginalDescriptionSection(unwrapped).kind).toBe("unmarked");
    expect(resolveOriginalDescriptionSection(applyOriginalDescription(unwrapped, sectionText(body))).kind).toBe("marked");
  });

  it.each(shapes)("gives the same lock for CRLF and LF text with a %s section", (_shape, build) => {
    const lf = build(quoting(lockableAliases));
    const crlf = lf.replace(/\n/g, "\r\n");

    expect(canonicalizePlan(crlf)).toMatchObject({ status: "available", contentHash: canonicalizePlan(lf).contentHash });
  });

  it.each(shapes)("still reports a planner-authored duplicate File Scope after a %s section", (_shape, build) => {
    const canonical = canonicalizePlan(`${build(quoting(lockableAliases))}\n## File Scope\n\n- src/other.ts\n`);

    expect(canonical).toMatchObject({ status: "unavailable", reason: "section-duplicate" });
    expect(canonical.sections["file-scope"]).toMatchObject({ status: "unavailable", reason: "section-duplicate" });
    expect(canonical.sections.mission.status).toBe("available");
  });

  it.each(shapes)("still reports a planner-authored duplicate Mission after a %s section", (_shape, build) => {
    const canonical = canonicalizePlan(`${build(quoting(lockableAliases))}\n## Mission\n\nDuplicate mission.\n`);

    expect(canonical).toMatchObject({ status: "unavailable", reason: "mission-duplicate" });
  });
});
