/*
FNXC:PromptReadBack 2026-09-04-05:12:
STAS-103 pins the prompt-return contract through the real PostgreSQL backend-mode store:
rowToTask never hydrates a prompt column (there is none), so the updateTask return, the
getTask detail read (file-based enrichment), and the on-disk PROMPT.md bytes must all
reflect the exact content that was written. Current-plan evidence must not commit a
revision whose PROMPT.md write later failed.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { type TaskStore } from "../../store.js";
import { buildBootstrapPrompt } from "../../mesh/mesh-task-replication.js";
import { canonicalizePlan, createCurrentPlanEvidence } from "../../planner/spec-lock.js";
import {
  ORIGINAL_DESCRIPTION_ENCODING_MARKER,
  ORIGINAL_DESCRIPTION_END_MARKER,
  ORIGINAL_DESCRIPTION_START_MARKER,
  encodeOriginalDescriptionBody,
  extractOriginalDescriptionBody,
  resolveOriginalDescriptionSection,
} from "../../tasks/original-description-policy.js";
import { stripOriginalDescriptionSection } from "../../tasks/original-description-region.js";

const { persistPromptFile } = vi.hoisted(() => {
  const persistPromptFile = vi.fn();
  return { persistPromptFile };
});

vi.mock("../../task-store/prompt-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../task-store/prompt-file.js")>();
  persistPromptFile.mockImplementation((promptPath: string, content: string) =>
    actual.writePromptFileAtomic(promptPath, content),
  );
  return {
    ...actual,
    writePromptFileAtomic: persistPromptFile,
  };
});

const prompt = (body: string, symbols?: string[]) =>
  `# Task\n\n## Mission\n\n${body}\n\n## File Scope\n\n- packages/core/src/store.ts\n\n## Steps\n\n1. Verify prompt return\n\n## Completion Criteria\n\n- [ ] updateTask returns the prompt\n\n## Do NOT\n\n- Drop the prompt\n\n## Dependencies\n\n- None\n${symbols?.length ? `\n## Declared Symbols\n\n${symbols.map((symbol) => `- \`${symbol}\``).join("\n")}\n` : ""}`;

pgDescribe("updateTask prompt return (PostgreSQL backend mode)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_task_update_prompt_return" });
  let store: TaskStore;

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => { persistPromptFile.mockClear(); await h.beforeEach(); store = h.store(); });
  afterEach(h.afterEach);

  it.sequential("returns the persisted prompt and the detail read exposes the same prompt", async () => {
    const task = await store.createTask({ description: "prompt return contract" });
    const content = prompt("pg contract body");

    const updated = await store.updateTask(task.id, { prompt: content });

    expect(updated).toBeDefined();
    expect(updated?.prompt).toBe(content);
    expect((await store.getTask(task.id)).prompt).toBe(content);
  });

  it.sequential("writes the exact requested bytes to PROMPT.md in the store task dir", async () => {
    const task = await store.createTask({ description: "prompt disk bytes" });
    const content = prompt("pg disk bytes body");

    await store.updateTask(task.id, { prompt: content });

    const bytes = await readFile(join(store.taskDir(task.id), "PROMPT.md"));
    expect(bytes.equals(Buffer.from(content))).toBe(true);
  });

  it.sequential("a second rewrite returns the new content and the disk matches it", async () => {
    const task = await store.createTask({ description: "prompt rewrite" });
    const second = prompt("second revision");

    await store.updateTask(task.id, { prompt: prompt("first revision") });
    const updated = await store.updateTask(task.id, { prompt: second });

    expect(updated?.prompt).toBe(second);
    expect(await readFile(join(store.taskDir(task.id), "PROMPT.md"), "utf8")).toBe(second);
  });

  it.sequential("does not commit current-plan evidence when PROMPT.md persistence fails", async () => {
    /*
    FNXC:PromptReadBack 2026-09-04-05:12:
    The PG row transaction used to append specPlanPrompt as current-plan evidence before
    writePromptFileAtomic. If that file write failed, spec-lock and drift reconciliation
    could observe an unwritten revision. After a durable first prompt, a failed rewrite
    must leave evidence and on-disk PROMPT.md on the first revision.
    */
    const task = await store.createTask({ description: "prompt evidence isolation" });
    const first = prompt("first revision that is on disk");
    const leaked = prompt("must not leak into plan evidence");

    await store.updateTask(task.id, { prompt: first });
    const before = await store.getLatestCurrentPlanEvidence(task.id);
    expect(before).toBeDefined();
    expect(before?.plan.sections.mission.canonical).toContain("first revision that is on disk");

    persistPromptFile.mockRejectedValueOnce(
      new Error("EIO: simulated PROMPT.md write failure"),
    );

    await expect(store.updateTask(task.id, { prompt: leaked })).rejects.toThrow(
      /EIO: simulated PROMPT.md write failure/,
    );

    const after = await store.getLatestCurrentPlanEvidence(task.id);
    expect(after?.sourceHash).toBe(before?.sourceHash);
    expect(after?.plan).toEqual(before?.plan);
    expect(JSON.stringify(after)).not.toContain("must not leak into plan evidence");
    expect(await readFile(join(store.taskDir(task.id), "PROMPT.md"), "utf8")).toBe(first);
  });

  it.sequential("does not persist prompt-derived declaredSymbols when PROMPT.md persistence fails", async () => {
    /*
    FNXC:PromptReadBack 2026-09-04-05:45:
    Symbol hydration from a Declared Symbols section must not land in the PG row before
    PROMPT.md reaches disk. A failed rewrite keeps the previously persisted symbols.
    */
    const task = await store.createTask({ description: "prompt symbols isolation" });
    const first = prompt("first symbols revision", ["pkg/old.ts#A"]);
    const leaked = prompt("must not leak symbols", ["pkg/new.ts#Foo"]);

    await store.updateTask(task.id, { prompt: first });
    expect((await store.getTask(task.id)).declaredSymbols).toEqual(["pkg/old.ts#a"]);

    persistPromptFile.mockRejectedValueOnce(
      new Error("EIO: simulated PROMPT.md write failure"),
    );

    await expect(store.updateTask(task.id, { prompt: leaked })).rejects.toThrow(
      /EIO: simulated PROMPT.md write failure/,
    );

    expect((await store.getTask(task.id)).declaredSymbols).toEqual(["pkg/old.ts#a"]);
    expect(await readFile(join(store.taskDir(task.id), "PROMPT.md"), "utf8")).toBe(first);
  });

  it.sequential("keeps the durable prompt when current-plan evidence capture fails", async () => {
    /*
    FNXC:PromptReadBack 2026-09-04-05:45:
    A PlanEvidenceAppendError after writePromptFileAtomic must not reject the prompt update.
    PROMPT.md is already the authoritative revision; updateTaskImpl reconciliation repairs
    missing evidence from that file after the task lock is released.
    */
    const task = await store.createTask({ description: "prompt evidence defer" });
    const first = prompt("first evidence revision");
    const next = prompt("durable prompt after evidence failure");
    await store.updateTask(task.id, { prompt: first });

    const spy = vi.spyOn(store, "captureCurrentPlanEvidenceWhilePlanningLocked")
      .mockRejectedValueOnce(new Error("simulated current-plan evidence insert failure"));
    try {
      const updated = await store.updateTask(task.id, { prompt: next });
      expect(updated?.prompt).toBe(next);
      expect(await readFile(join(store.taskDir(task.id), "PROMPT.md"), "utf8")).toBe(next);
    } finally {
      spy.mockRestore();
    }

    const evidence = await store.getLatestCurrentPlanEvidence(task.id);
    expect(evidence?.plan.sections.mission.canonical).toContain("durable prompt after evidence failure");
  });

  it.sequential("retries declaredSymbols persist after PROMPT.md write so a later read matches", async () => {
    /*
    FNXC:PromptReadBack 2026-09-04-07:51:
    Drive shipped updateTask: if the follow-up declaredSymbols row write fails after PROMPT.md
    is durable, retry until the row matches the new prompt so getTask cannot observe split revisions.
    */
    const task = await store.createTask({ description: "prompt symbols persist retry" });
    const first = prompt("first symbols revision", ["pkg/old.ts#A"]);
    const next = prompt("durable prompt after symbols persist failure", ["pkg/new.ts#Foo"]);
    await store.updateTask(task.id, { prompt: first });
    expect((await store.getTask(task.id)).declaredSymbols).toEqual(["pkg/old.ts#a"]);

    const original = store.atomicWriteTaskJsonWithAudit.bind(store);
    let failedOnce = false;
    const spy = vi.spyOn(store, "atomicWriteTaskJsonWithAudit").mockImplementation(async (...args) => {
      const written = args[1] as { declaredSymbols?: string[] };
      if (!failedOnce && JSON.stringify(written.declaredSymbols ?? []) === JSON.stringify(["pkg/new.ts#foo"])) {
        failedOnce = true;
        throw new Error("simulated declaredSymbols persist failure");
      }
      return original(...args);
    });
    try {
      const updated = await store.updateTask(task.id, { prompt: next });
      expect(updated?.prompt).toBe(next);
      expect(updated?.declaredSymbols).toEqual(["pkg/new.ts#foo"]);
      expect((await store.getTask(task.id)).declaredSymbols).toEqual(["pkg/new.ts#foo"]);
      expect(await readFile(join(store.taskDir(task.id), "PROMPT.md"), "utf8")).toBe(next);
      expect(failedOnce).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  const operatorDescription = "Operator request.\n\n## File Scope\n- operator/path.ts\n\nMore operator prose.";
  const plannerSpec = prompt("envelope contract body").replace(
    "## Mission",
    "## What This Delivers\n\n- The operator request stays protected.\n\n## Mission",
  );
  const withUnmarkedSection = (sectionBody: string) => plannerSpec.replace(
    "## What This Delivers",
    `## Original Description\n\n${sectionBody}\n\n## What This Delivers`,
  );

  it.sequential.each([
    ["bare", withUnmarkedSection(operatorDescription)],
    ["fenced", withUnmarkedSection(`\`\`\`text\n${operatorDescription}\n\`\`\``)],
  ])("stores a %s unmarked Original Description section inside the marker envelope", async (_shape, submitted) => {
    const task = await store.createTask({ description: operatorDescription });

    const updated = await store.updateTask(task.id, { prompt: submitted });

    const onDisk = await readFile(join(store.taskDir(task.id), "PROMPT.md"), "utf8");
    expect(onDisk).toContain(`${ORIGINAL_DESCRIPTION_START_MARKER}\n${operatorDescription}\n${ORIGINAL_DESCRIPTION_END_MARKER}`);
    expect(resolveOriginalDescriptionSection(onDisk).kind).toBe("marked");
    expect(stripOriginalDescriptionSection(onDisk)).toBe(plannerSpec);
    expect(updated.prompt).toBe(onDisk);
    expect((await store.getTask(task.id)).prompt).toBe(onDisk);

    const evidence = await store.getLatestCurrentPlanEvidence(task.id);
    expect(evidence?.plan.status).toBe("available");
    expect(evidence?.sourceHash).toBe(
      createCurrentPlanEvidence({ version: 1, sourceRevision: 1, capturedAt: "", prompt: onDisk, bindings: { dependencies: [] } }).sourceHash,
    );

    const again = await store.updateTask(task.id, { prompt: onDisk });
    expect(again.prompt).toBe(onDisk);
    expect(await readFile(join(store.taskDir(task.id), "PROMPT.md"), "utf8")).toBe(onDisk);
  });

  /*
  FNXC:OriginalDescriptionInPrompt 2026-10-11-17:25:
  A request that mentions the start marker, or a plan that quotes it below the section, used to leave the section unwrapped on every write: the writer read the mention as an envelope it could not close and returned the prompt unchanged.
  */
  const quotingDescription = `The resolver reads the \`${ORIGINAL_DESCRIPTION_START_MARKER}\` comment as an envelope.\n\n## File Scope\n- operator/decoy.ts\n\nOrigin: follow-up.`;

  it.sequential("wraps and encodes a request that mentions the start marker and locks the plan without it", async () => {
    const task = await store.createTask({ description: quotingDescription });

    const updated = await store.updateTask(task.id, { prompt: withUnmarkedSection(quotingDescription) });

    const onDisk = await readFile(join(store.taskDir(task.id), "PROMPT.md"), "utf8");
    expect(onDisk).toContain(
      `${ORIGINAL_DESCRIPTION_START_MARKER}\n${ORIGINAL_DESCRIPTION_ENCODING_MARKER}\n${encodeOriginalDescriptionBody(quotingDescription)}\n${ORIGINAL_DESCRIPTION_END_MARKER}`,
    );
    expect(onDisk.split(ORIGINAL_DESCRIPTION_START_MARKER)).toHaveLength(2);
    expect(resolveOriginalDescriptionSection(onDisk).kind).toBe("marked");
    expect(extractOriginalDescriptionBody(onDisk)).toBe(quotingDescription);
    expect(stripOriginalDescriptionSection(onDisk)).toBe(plannerSpec);
    expect(updated.prompt).toBe(onDisk);
    expect((await store.getTask(task.id)).prompt).toBe(onDisk);

    const evidence = await store.getLatestCurrentPlanEvidence(task.id);
    expect(evidence?.plan).toMatchObject({ status: "available", contentHash: canonicalizePlan(plannerSpec).contentHash });

    const again = await store.updateTask(task.id, { prompt: onDisk });
    expect(again.prompt).toBe(onDisk);
    expect(await readFile(join(store.taskDir(task.id), "PROMPT.md"), "utf8")).toBe(onDisk);
    expect((await store.getLatestCurrentPlanEvidence(task.id))?.version).toBe(evidence?.version);
  });

  it.sequential("wraps a marker-free request when a later plan step quotes the start marker", async () => {
    const quotingPlan = plannerSpec.replace("1. Verify prompt return", `1. Verify prompt return\n2. Keep \`${ORIGINAL_DESCRIPTION_START_MARKER}\` intact`);
    const task = await store.createTask({ description: operatorDescription });

    const updated = await store.updateTask(task.id, { prompt: quotingPlan.replace(
      "## What This Delivers",
      `## Original Description\n\n${operatorDescription}\n\n## What This Delivers`,
    ) });

    const onDisk = await readFile(join(store.taskDir(task.id), "PROMPT.md"), "utf8");
    expect(onDisk).toContain(`## Original Description\n\n${ORIGINAL_DESCRIPTION_START_MARKER}\n${operatorDescription}\n${ORIGINAL_DESCRIPTION_END_MARKER}`);
    expect(stripOriginalDescriptionSection(onDisk)).toBe(quotingPlan);
    expect(updated.prompt).toBe(onDisk);
  });

  it.sequential("wraps the original-description task document when the task has one", async () => {
    const task = await store.createTask({ description: "# Plan title\n\nA plan-shaped description is not the operator request." });
    await store.upsertTaskDocument(task.id, { key: "original-description", content: "  Operator request kept apart from the plan.\n", author: "user" });

    const updated = await store.updateTask(task.id, { prompt: withUnmarkedSection("Planner paraphrase of the request.") });

    expect(updated.prompt).toContain(`${ORIGINAL_DESCRIPTION_START_MARKER}\nOperator request kept apart from the plan.\n${ORIGINAL_DESCRIPTION_END_MARKER}`);
    expect(updated.prompt).not.toContain("Planner paraphrase of the request.");
    expect(stripOriginalDescriptionSection(updated.prompt ?? "")).toBe(plannerSpec);
  });

  it.sequential("stores a prompt without the section byte-identical and never inserts one", async () => {
    const task = await store.createTask({ description: operatorDescription });

    const updated = await store.updateTask(task.id, { prompt: plannerSpec });

    expect(updated.prompt).toBe(plannerSpec);
    expect(await readFile(join(store.taskDir(task.id), "PROMPT.md"), "utf8")).toBe(plannerSpec);
  });

  it.sequential("stores a bootstrap seed prompt byte-identical even when the description quotes the section heading", async () => {
    const description = "Operator request.\n\n## Original Description\n\nQuoted by the operator.";
    const task = await store.createTask({ description });
    const seed = buildBootstrapPrompt(task.id, task.title, task.description);

    const updated = await store.updateTask(task.id, { prompt: seed });

    expect(updated.prompt).toBe(seed);
    expect(await readFile(join(store.taskDir(task.id), "PROMPT.md"), "utf8")).toBe(seed);
  });

  /*
  FNXC:FileScopeClassification 2026-10-11-14:50:
  Requests routinely end with a quoted File Scope heading, a path list and an "Origin:" line.
  Hygiene re-inserts that request verbatim before validation, so a locator that read it rejected every plan write over tokens only the request held, and the effective scope came from the request instead of the plan.
  */
  const quotedScopeDescription = (bullets: string[], origin: string) =>
    ["The requester explains the defect.", "", "## File Scope", ...bullets, "", origin].join("\n");
  const planEntries = ["packages/cli/vitest.config.ts", "docs/testing.md"];
  const plannedPrompt = (scopeLines = planEntries.map((entry) => `- \`${entry}\``)) => [
    "# Task",
    "",
    "## Original Description",
    "",
    "The requester wants the quoted scope ignored.",
    "",
    "## What This Delivers",
    "",
    "- Plans can be saved.",
    "",
    "## Mission",
    "",
    "Read the plan's scope.",
    "",
    "## File Scope",
    "",
    ...scopeLines,
    "",
    "## Steps",
    "",
    "1. Do it",
    "",
  ].join("\n");

  it.sequential.each([
    ["a backticked package specifier", quotedScopeDescription(["- packages/quoted/plain.ts"], "Origin: the `@fusion/core/memory-mcp` entry point.")],
    ["a backticked path-like token", quotedScopeDescription(["- packages/quoted/plain.ts"], "Origin: the server at `commands/mcp-memory-server.js`.")],
    ["no backticked tokens", quotedScopeDescription(["- packages/quoted/plain.ts", "- docs/quoted.md"], "Origin: an earlier planning session.")],
  ])("accepts a plan whose request quotes File Scope with %s and parses the plan's entries", async (_label, description) => {
    const task = await store.createTask({ description });

    const updated = await store.updateTask(task.id, { prompt: plannedPrompt() });

    const onDisk = await readFile(join(store.taskDir(task.id), "PROMPT.md"), "utf8");
    expect(onDisk).toContain(`${ORIGINAL_DESCRIPTION_START_MARKER}\n${description}\n${ORIGINAL_DESCRIPTION_END_MARKER}`);
    expect(updated.prompt).toBe(onDisk);
    expect(await store.parseFileScopeFromPrompt(task.id)).toEqual(planEntries);
  });

  it.sequential("still rejects an invalid entry in the plan's own section, naming only that entry", async () => {
    const task = await store.createTask({
      description: quotedScopeDescription(["- `decoy/quoted-only.ts`"], "Origin: an earlier planning session."),
    });

    const write = store.updateTask(task.id, { prompt: plannedPrompt(["- `packages/cli/vitest.config.ts`", "- `origin/main`"]) });

    await expect(write).rejects.toMatchObject({ name: "InvalidFileScopeError", invalidEntries: ["origin/main"] });
  });

  it.sequential("keeps a quoted File Scope in an unplanned stub as its provisional scope", async () => {
    const task = await store.createTask({
      description: quotedScopeDescription(
        ["- `decoy/quoted-only.ts`"],
        "Origin: `commands/mcp-memory-server.js` and `@fusion/core/memory-mcp`.",
      ),
    });

    expect(await store.parseFileScopeFromPrompt(task.id)).toEqual(["decoy/quoted-only.ts", "commands/mcp-memory-server.js"]);
  });
});
