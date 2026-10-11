import { describe, expect, it, vi } from "vitest";
import { getCommitTaskOwnership } from "../merge/already-merged-detector.js";
import {
  assessLandedCommitProvenance,
  parseCommitTimeSeconds,
  resolveLandedCommitProvenance,
  type LandedCommitProvenanceInput,
} from "../merge/landed-commit-provenance.js";

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-11T07:00:00.000Z");
const CREATED_AT = new Date(NOW - HOUR).toISOString();
const TASK = "KB-900";
const LINEAGE = "lin-kb-900";

function ownership(subject: string, body = "", lineageId: string | undefined = LINEAGE) {
  return getCommitTaskOwnership(TASK, lineageId, subject, body);
}

function input(overrides: Partial<LandedCommitProvenanceInput>): LandedCommitProvenanceInput {
  return {
    ownership: ownership(`feat(${TASK}): work`),
    scope: "unbounded",
    commitTimeMs: NOW,
    taskCreatedAt: CREATED_AT,
    taskLineageId: LINEAGE,
    nowMs: NOW,
    ...overrides,
  };
}

describe("assessLandedCommitProvenance", () => {
  it("accepts a lineage trailer even with an old committer time", () => {
    expect(assessLandedCommitProvenance(input({
      ownership: ownership("chore: squash", `Fusion-Task-Lineage: ${LINEAGE}`),
      commitTimeMs: Date.parse("2020-01-01T00:00:00Z"),
    }))).toEqual({ accepted: true, proof: "lineage-trailer" });
  });

  it("treats a matching lineage trailer as lineage proof when a task-id trailer is also present", () => {
    expect(assessLandedCommitProvenance(input({
      ownership: ownership("chore: squash", `Fusion-Task-Id: ${TASK}\nFusion-Task-Lineage: ${LINEAGE}`),
      commitTimeMs: NOW - 400 * DAY,
    }))).toEqual({ accepted: true, proof: "lineage-trailer" });
  });

  it("accepts a bounded subject anchor with an unknown committer time", () => {
    expect(assessLandedCommitProvenance(input({ scope: "bounded", commitTimeMs: undefined })))
      .toEqual({ accepted: true, proof: "subject-anchor" });
  });

  it("rejects an unbounded task trailer committed 190 days before the task", () => {
    expect(assessLandedCommitProvenance(input({
      ownership: ownership("feat: old", `Fusion-Task-Id: ${TASK}`),
      commitTimeMs: NOW - 190 * DAY,
    }))).toEqual({ accepted: false, reason: "predates-task" });
  });

  it("accepts an unbounded task trailer one hour older than the task (clock skew)", () => {
    expect(assessLandedCommitProvenance(input({
      ownership: ownership("feat: squash", `Fusion-Task-Id: ${TASK}`),
      commitTimeMs: Date.parse(CREATED_AT) - HOUR,
    }))).toEqual({ accepted: true, proof: "task-trailer" });
  });

  it("falls back to a 30-day window when createdAt is missing", () => {
    const trailerOwnership = ownership("feat: squash", `Fusion-Task-Id: ${TASK}`);
    expect(assessLandedCommitProvenance(input({
      ownership: trailerOwnership,
      taskCreatedAt: undefined,
      commitTimeMs: NOW - 40 * DAY,
    }))).toEqual({ accepted: false, reason: "predates-task" });
    expect(assessLandedCommitProvenance(input({
      ownership: trailerOwnership,
      taskCreatedAt: "not a date",
      commitTimeMs: NOW - 20 * DAY,
    }))).toEqual({ accepted: true, proof: "task-trailer" });
  });

  it("rejects a recent unbounded subject anchor outside the task branch", () => {
    expect(assessLandedCommitProvenance(input({ onTaskBranch: false })))
      .toEqual({ accepted: false, reason: "subject-only-outside-task-range" });
    expect(assessLandedCommitProvenance(input({ onTaskBranch: undefined })))
      .toEqual({ accepted: false, reason: "subject-only-outside-task-range" });
  });

  it("accepts a recent unbounded subject anchor on the task branch", () => {
    expect(assessLandedCommitProvenance(input({ onTaskBranch: true })))
      .toEqual({ accepted: true, proof: "subject-anchor" });
  });

  it("rejects an old unbounded subject anchor even when it is on the task branch", () => {
    expect(assessLandedCommitProvenance(input({ onTaskBranch: true, commitTimeMs: NOW - 190 * DAY })))
      .toEqual({ accepted: false, reason: "predates-task" });
  });

  it("rejects an unbounded candidate with an unreadable committer time", () => {
    expect(assessLandedCommitProvenance(input({ commitTimeMs: Number.NaN, onTaskBranch: true })))
      .toEqual({ accepted: false, reason: "commit-time-unknown" });
    expect(assessLandedCommitProvenance(input({ commitTimeMs: undefined, onTaskBranch: true })))
      .toEqual({ accepted: false, reason: "commit-time-unknown" });
  });

  it("rejects foreign task and lineage trailers in any scope", () => {
    expect(assessLandedCommitProvenance(input({
      scope: "bounded",
      ownership: ownership(`feat(${TASK}): x`, "Fusion-Task-Id: KB-901"),
    }))).toEqual({ accepted: false, reason: "foreign-owner" });
    expect(assessLandedCommitProvenance(input({
      scope: "bounded",
      ownership: ownership(`feat(${TASK}): x`, "Fusion-Task-Lineage: other-lineage"),
    }))).toEqual({ accepted: false, reason: "foreign-owner" });
  });

  it("rejects a prose mention", () => {
    expect(assessLandedCommitProvenance(input({
      scope: "bounded",
      ownership: ownership("feat: unrelated change", `Follow-up to ${TASK}.`),
    }))).toEqual({ accepted: false, reason: "not-owned" });
  });
});

describe("resolveLandedCommitProvenance", () => {
  it("probes branch membership only for an unbounded subject-only candidate that passed the age check", async () => {
    const probe = vi.fn(async () => true);
    await expect(resolveLandedCommitProvenance(input({ scope: "bounded" }), probe))
      .resolves.toEqual({ accepted: true, proof: "subject-anchor" });
    await expect(resolveLandedCommitProvenance(input({ commitTimeMs: NOW - 190 * DAY }), probe))
      .resolves.toEqual({ accepted: false, reason: "predates-task" });
    expect(probe).not.toHaveBeenCalled();

    await expect(resolveLandedCommitProvenance(input({}), probe))
      .resolves.toEqual({ accepted: true, proof: "subject-anchor" });
    expect(probe).toHaveBeenCalledTimes(1);

    await expect(resolveLandedCommitProvenance(input({}), async () => false))
      .resolves.toEqual({ accepted: false, reason: "subject-only-outside-task-range" });
  });
});

describe("parseCommitTimeSeconds", () => {
  it("parses seconds into milliseconds and rejects junk", () => {
    expect(parseCommitTimeSeconds("1700000000\n")).toBe(1_700_000_000_000);
    expect(parseCommitTimeSeconds("")).toBeUndefined();
    expect(parseCommitTimeSeconds("abc")).toBeUndefined();
    expect(parseCommitTimeSeconds(undefined)).toBeUndefined();
  });
});
