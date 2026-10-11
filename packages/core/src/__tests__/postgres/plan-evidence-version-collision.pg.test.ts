/*
FNXC:SpecLock 2026-08-11-02:04:
FN-8969 reproduces the operator-visible FN-8964 wedge against PostgreSQL: durable row versions,
not stale snapshot payload versions, must advance every authoritative PROMPT.md write.
*/
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { type TaskStore } from "../../store.js";
import * as schema from "../../postgres/schema/index.js";
import { createCurrentPlanEvidence, SPEC_LOCK_PARSER_VERSION, type CurrentPlanEvidence } from "../../planner/spec-lock.js";
import { computePlanApprovalFingerprint } from "../../planner/plan-approval.js";

const prompt = (body: string) => `# Task\n\n## Mission\n\n${body}\n\n## File Scope\n\n- packages/core/src/store.ts\n\n## Steps\n\n1. Preserve plan evidence\n\n## Completion Criteria\n\n- [ ] Plan write succeeds\n\n## Do NOT\n\n- Drop evidence\n\n## Dependencies\n\n- None\n`;

pgDescribe("plan evidence version collisions", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_plan_evidence_collision" });
  let store: TaskStore;

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => { await h.beforeEach(); store = h.store(); });
  afterEach(h.afterEach);

  async function seedDriftedEvidence(taskId: string) {
    await h.layer().db.delete(schema.project.currentPlanEvidence).where(eq(schema.project.currentPlanEvidence.taskId, taskId));
    const evidence = createCurrentPlanEvidence({ version: 4, sourceRevision: Date.now(), capturedAt: new Date().toISOString(), prompt: prompt("stale snapshot") });
    await h.layer().db.insert(schema.project.currentPlanEvidence).values({
      projectId: "", taskId, version: 5, sourceRevision: evidence.sourceRevision,
      sourceHash: evidence.sourceHash, capturedAt: evidence.capturedAt, snapshot: evidence,
    });
  }

  it.sequential("self-heals a durable-version/snapshot-version wedge and dedupes a repeated prompt", async () => {
    const task = await store.createTask({ description: "drifted evidence prompt write" });
    await seedDriftedEvidence(task.id);
    const revised = prompt("new authoritative content");

    await expect(store.updateTask(task.id, { prompt: revised })).resolves.toBeDefined();
    expect((await store.getTask(task.id)).prompt).toBe(revised);
    const afterFirst = await h.layer().db.select({ version: schema.project.currentPlanEvidence.version })
      .from(schema.project.currentPlanEvidence).where(and(eq(schema.project.currentPlanEvidence.taskId, task.id))).orderBy(schema.project.currentPlanEvidence.version);
    expect(afterFirst.map((row) => row.version)).toContain(6);

    await expect(store.updateTask(task.id, { prompt: revised })).resolves.toBeDefined();
    const afterRepeat = await h.layer().db.select({ version: schema.project.currentPlanEvidence.version })
      .from(schema.project.currentPlanEvidence).where(and(eq(schema.project.currentPlanEvidence.taskId, task.id)));
    expect(afterRepeat).toHaveLength(afterFirst.length);
  });

  it.sequential("uses unbound-layer reads and accepts concurrent distinct and identical prompt writes", async () => {
    const task = await store.createTask({ description: "unbound concurrent plan writes" });
    await seedDriftedEvidence(task.id);
    await expect(Promise.all([
      store.updateTask(task.id, { prompt: prompt("concurrent one") }),
      store.updateTask(task.id, { prompt: prompt("concurrent two") }),
    ])).resolves.toHaveLength(2);
    const distinct = await h.layer().db.select({ version: schema.project.currentPlanEvidence.version, sourceHash: schema.project.currentPlanEvidence.sourceHash })
      .from(schema.project.currentPlanEvidence).where(eq(schema.project.currentPlanEvidence.taskId, task.id)).orderBy(schema.project.currentPlanEvidence.version);
    expect(distinct.map((row) => row.version)).toEqual(expect.arrayContaining([5, 6, 7]));

    const same = prompt("same concurrent content");
    await expect(Promise.all([store.updateTask(task.id, { prompt: same }), store.updateTask(task.id, { prompt: same })])).resolves.toHaveLength(2);
    const rows = await h.layer().db.select({ sourceHash: schema.project.currentPlanEvidence.sourceHash })
      .from(schema.project.currentPlanEvidence).where(eq(schema.project.currentPlanEvidence.taskId, task.id));
    const sameEvidence = createCurrentPlanEvidence({ version: 1, sourceRevision: 0, capturedAt: "", prompt: same });
    expect(rows.filter((row) => row.sourceHash === sameEvidence.sourceHash)).toHaveLength(1);
  });

  const quotedOperatorBody = "Operator request.\n\n## File Scope\n- operator/path.ts\n\nMore operator prose.";
  const unmarkedPrompt = (sectionBody: string) => prompt("locked after a parser fix").replace(
    "## Mission",
    `## Original Description\n\n${sectionBody}\n\n## What This Delivers\n\n- An approved plan reaches execution.\n\n## Mission`,
  );

  it.sequential.each([
    ["bare", unmarkedPrompt(quotedOperatorBody)],
    ["fenced", unmarkedPrompt(`\`\`\`text\n${quotedOperatorBody}\n\`\`\``)],
  ])("locks an unchanged prompt with a %s unmarked section despite a rejection stored by the previous parser", async (_shape, stuckPrompt) => {
    const task = await store.createTask({ description: "stale parser evidence" });
    await h.layer().db.delete(schema.project.currentPlanEvidence).where(eq(schema.project.currentPlanEvidence.taskId, task.id));
    const current = createCurrentPlanEvidence({ version: 1, sourceRevision: 1, capturedAt: "2026-10-10T23:13:00.000Z", prompt: stuckPrompt, bindings: { dependencies: [] } });
    const legacySourceHash = createHash("sha256").update(JSON.stringify({ prompt: stuckPrompt, bindings: {} }), "utf8").digest("hex");
    const legacy: CurrentPlanEvidence = {
      ...current,
      sourceHash: legacySourceHash,
      plan: {
        parserVersion: 1,
        status: "unavailable",
        reason: "section-duplicate",
        sections: { ...current.plan.sections, "file-scope": { status: "unavailable", reason: "section-duplicate", canonical: "" } },
      },
    };
    await h.layer().db.insert(schema.project.currentPlanEvidence).values({
      projectId: "", taskId: task.id, version: 1, sourceRevision: legacy.sourceRevision,
      sourceHash: legacy.sourceHash, capturedAt: legacy.capturedAt, snapshot: legacy,
    });

    const lock = await store.lockCurrentPlan(task.id, computePlanApprovalFingerprint(stuckPrompt), stuckPrompt);

    expect(lock.plan).toMatchObject({ status: "available", parserVersion: SPEC_LOCK_PARSER_VERSION });
    expect(lock.currentPlanHash).toBe(createCurrentPlanEvidence({ version: 1, sourceRevision: 1, capturedAt: "", prompt: prompt("locked after a parser fix") }).plan.contentHash);
    const latest = await store.getLatestCurrentPlanEvidence(task.id);
    expect(latest).toMatchObject({ version: 2, plan: { status: "available", parserVersion: SPEC_LOCK_PARSER_VERSION } });
    expect(latest?.sourceHash).not.toBe(legacySourceHash);
    const stored = await store.listCurrentPlanEvidence(task.id);
    expect(stored.map((row) => row.plan.status)).toEqual(["unavailable", "available"]);
  });
});
