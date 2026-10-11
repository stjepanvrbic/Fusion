import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { appendPlanEvidenceInTransaction, PlanEvidenceAppendError } from "../task-store/plan-evidence.js";
import { createCurrentPlanEvidence, SPEC_LOCK_PARSER_VERSION, type CurrentPlanEvidence } from "../planner/spec-lock.js";

const prompt = "# Task\n\n## Mission\n\nEvidence\n\n## Steps\n\n1. Keep it\n";
const evidence = (version: number) => createCurrentPlanEvidence({ version, sourceRevision: 1, capturedAt: "2026-08-11T02:04:00.000Z", prompt });

function fakeTx(latestVersions: number[], conflicts: Array<"insert" | "dedupe"> = [], matching?: CurrentPlanEvidence) {
  const inserted: CurrentPlanEvidence[] = [];
  let selectCount = 0;
  const tx = {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [{ version: latestVersions[Math.min(selectCount++, latestVersions.length - 1)] }] }), limit: async () => matching ? [{ version: matching.version, snapshot: matching }] : [] }) }) }),
    insert: () => ({ values: (row: { snapshot: CurrentPlanEvidence }) => ({ onConflictDoNothing: () => ({ returning: async () => {
      const outcome = conflicts.shift();
      if (outcome === "insert" || outcome === "dedupe") return [];
      inserted.push(row.snapshot);
      return [{ version: row.snapshot.version }];
    } }) }) }),
  };
  return { tx, inserted };
}

it("derives the next evidence version from the durable column", async () => {
  const { tx, inserted } = fakeTx([5]);
  const result = await appendPlanEvidenceInTransaction(tx as never, { taskId: "KB-1", buildEvidence: evidence });
  expect(result.version).toBe(6);
  expect(inserted[0]?.version).toBe(6);
});

it("retries a primary-key conflict with a freshly-read version", async () => {
  const { tx, inserted } = fakeTx([5, 6], ["insert"]);
  const result = await appendPlanEvidenceInTransaction(tx as never, { taskId: "KB-1", buildEvidence: evidence });
  expect(result).toMatchObject({ version: 7, attempts: 2, deduped: false });
  expect(inserted[0]?.version).toBe(7);
});

it("returns the stored snapshot for a source-hash dedupe conflict", async () => {
  const stored = evidence(5);
  const { tx, inserted } = fakeTx([5], ["dedupe"], stored);
  const result = await appendPlanEvidenceInTransaction(tx as never, { taskId: "KB-1", buildEvidence: () => stored });
  expect(result).toMatchObject({ evidence: stored, version: 5, deduped: true });
  expect(inserted).toEqual([]);
});

it("throws a named error after conflicts cannot produce a durable row", async () => {
  const { tx } = fakeTx([5, 6, 7], ["insert", "insert", "insert"]);
  await expect(appendPlanEvidenceInTransaction(tx as never, { taskId: "KB-1", buildEvidence: evidence }))
    .rejects.toEqual(expect.objectContaining({ name: "PlanEvidenceAppendError", taskId: "KB-1", attempts: 3 } satisfies Partial<PlanEvidenceAppendError>));
});

/** Models the durable table: the version primary key and the unique source hash. */
function durableTx(seed: Array<{ version: number; sourceHash: string; snapshot: CurrentPlanEvidence }>) {
  const rows = [...seed];
  let attemptedSourceHash: string | undefined;
  const tx = {
    select: () => ({ from: () => ({ where: () => ({
      orderBy: () => ({ limit: async () => rows.length ? [{ version: Math.max(...rows.map((row) => row.version)) }] : [] }),
      limit: async () => rows.filter((row) => row.sourceHash === attemptedSourceHash).slice(0, 1),
    }) }) }),
    insert: () => ({ values: (row: { version: number; sourceHash: string; snapshot: CurrentPlanEvidence }) => ({ onConflictDoNothing: () => ({ returning: async () => {
      attemptedSourceHash = row.sourceHash;
      if (rows.some((stored) => stored.version === row.version || stored.sourceHash === row.sourceHash)) return [];
      rows.push({ version: row.version, sourceHash: row.sourceHash, snapshot: row.snapshot });
      return [{ version: row.version }];
    } }) }) }),
  };
  return { tx, rows };
}

it("appends current-parser evidence beside a rejection an older parser stored for the same prompt", async () => {
  const unmarkedPrompt = "# Task\n\n## Original Description\n\nOperator request.\n\n## File Scope\n\n- operator/path.ts\n\n## What This Delivers\n\n- Value.\n\n## Mission\n\nEvidence\n\n## File Scope\n\n- src/a.ts\n";
  const legacySourceHash = createHash("sha256").update(JSON.stringify({ prompt: unmarkedPrompt, bindings: {} }), "utf8").digest("hex");
  const current = createCurrentPlanEvidence({ version: 2, sourceRevision: 2, capturedAt: "2026-10-11T10:00:00.000Z", prompt: unmarkedPrompt });
  const legacy: CurrentPlanEvidence = {
    version: 1,
    sourceRevision: 1,
    sourceHash: legacySourceHash,
    capturedAt: "2026-10-10T23:13:00.000Z",
    plan: {
      parserVersion: 1,
      status: "unavailable",
      reason: "section-duplicate",
      sections: { ...current.plan.sections, "file-scope": { status: "unavailable", reason: "section-duplicate", canonical: "" } },
    },
  };
  const { tx, rows } = durableTx([{ version: 1, sourceHash: legacySourceHash, snapshot: legacy }]);
  const build = (version: number) => createCurrentPlanEvidence({ version, sourceRevision: 2, capturedAt: "2026-10-11T10:00:00.000Z", prompt: unmarkedPrompt });

  const first = await appendPlanEvidenceInTransaction(tx as never, { taskId: "KB-1", buildEvidence: build });
  expect(first).toMatchObject({ version: 2, deduped: false });
  expect(first.evidence.plan).toMatchObject({ status: "available", parserVersion: SPEC_LOCK_PARSER_VERSION });
  expect(first.evidence.sourceHash).not.toBe(legacySourceHash);

  const second = await appendPlanEvidenceInTransaction(tx as never, { taskId: "KB-1", buildEvidence: build });
  expect(second).toMatchObject({ version: 2, deduped: true });
  expect(second.evidence.plan.status).toBe("available");
  expect(rows.map((row) => row.version)).toEqual([1, 2]);
  expect(rows[0]?.snapshot).toBe(legacy);
});
