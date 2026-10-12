/*
FNXC:MergeLandingCommitPoint 2026-10-12-12:30:
Original symptom (KB-146): after its no-op landing was confirmed, a stale-content reroute seeded Code Review on the landed card; the gate wrote a pending lease over the stored approval and a new reviewer session started on a worktree whose diff against main was empty.
Invariant: on a card whose landing is settled, no pre-merge gate session starts and the stored approval is unchanged, for the state every confirming path leaves; the walk goes on to the merge node and post-merge verification.
Surfaces (one row each): normal landing (branch deleted), normal landing interrupted before cleanup (branch at its pin), no-op landing with trailer proof (pinned), operator close as landed, absent-branch reconcile, recorded-landing short circuit, workspace land, pull-request merge without a pin.
The operator close and absent-branch rows reproduce the rows those owners write; self-healing-close-as-landed.test.ts and self-healing-reconcile-landed-review-task.test.ts drive the real owners and check the same rule.
Negative rows: an unlanded card and a confirmed card whose branch moved past its pin still run the review.
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MergeDetails, TaskDetail, WorkflowIr, WorkflowStepResult } from "@fusion/core";
import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";
import { isLandingSettled } from "../merge/landing-settled.js";

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Code Review before the merge node, post-merge verification after it. */
function reviewMergeVerifyIr(): WorkflowIr {
  const group = (id: string, phase: "pre-merge" | "post-merge", templateId: string) => ({
    id,
    kind: "optional-group" as const,
    config: { name: id, defaultOn: true, phase, template: { nodes: [{ id: templateId, kind: "prompt" as const, config: { prompt: templateId } }], edges: [] } },
  });
  return {
    version: "v2",
    name: "landed-card-review",
    columns: [{ id: "in-review", name: "In review", traits: [] }],
    nodes: [
      { id: "start", kind: "start" },
      group("code-review", "pre-merge", "reviewer"),
      { id: "merge", kind: "prompt", config: { prompt: "merge" } },
      group("post-merge-verification", "post-merge", "verifier"),
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "code-review" },
      { from: "code-review", to: "merge", condition: "success" },
      { from: "code-review", to: "end", condition: "failure" },
      { from: "merge", to: "post-merge-verification" },
      { from: "post-merge-verification", to: "end" },
    ],
  } as WorkflowIr;
}

const STALE_APPROVAL: WorkflowStepResult = {
  workflowStepId: "code-review",
  workflowStepName: "Code Review",
  phase: "pre-merge",
  source: "optional-group",
  status: "passed",
  verdict: "APPROVE",
  reviewInputFingerprint: `sha256:${"0".repeat(64)}`,
  startedAt: "2026-10-12T04:47:00.000Z",
  completedAt: "2026-10-12T04:59:00.000Z",
} as WorkflowStepResult;

describe("pre-merge review on a card whose landing is settled", () => {
  let repo = "";
  let pinSha = "";
  let landedSha = "";

  beforeAll(() => {
    repo = mkdtempSync(path.join(os.tmpdir(), "fn-landed-review-"));
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    writeFileSync(path.join(repo, "a.txt"), "one\n", "utf-8");
    git(repo, ["add", "a.txt"]);
    git(repo, ["commit", "-q", "-m", "base"]);
    git(repo, ["checkout", "-q", "-b", "fusion/kb-at-pin"]);
    writeFileSync(path.join(repo, "a.txt"), "two\n", "utf-8");
    git(repo, ["commit", "-q", "-am", "work"]);
    pinSha = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "-q", "-b", "fusion/kb-moved"]);
    writeFileSync(path.join(repo, "b.txt"), "later\n", "utf-8");
    git(repo, ["add", "b.txt"]);
    git(repo, ["commit", "-q", "-m", "after the reviewed squash"]);
    git(repo, ["checkout", "-q", "main"]);
    git(repo, ["merge", "--squash", "fusion/kb-at-pin"]);
    git(repo, ["commit", "-q", "-m", "KB-159: squash", "-m", "Fusion-Task-Id: KB-159"]);
    landedSha = git(repo, ["rev-parse", "HEAD"]);
  });

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  function card(branch: string, mergeDetails?: MergeDetails, extra: Record<string, unknown> = {}): TaskDetail {
    return {
      id: "KB-159",
      column: "in-review",
      branch,
      enabledWorkflowSteps: ["code-review", "post-merge-verification"],
      workflowStepResults: [structuredClone(STALE_APPROVAL)],
      ...(mergeDetails ? { mergeDetails } : {}),
      ...extra,
    } as TaskDetail;
  }

  async function walk(task: TaskDetail) {
    const ran: string[] = [];
    const written: WorkflowStepResult[] = [];
    const executor = new WorkflowGraphExecutor({
      handlers: {
        prompt: async (node) => {
          ran.push(node.id);
          return { outcome: "success", value: node.id.includes("verifier") || node.id.includes("reviewer") ? "APPROVE" : undefined };
        },
      },
      recordWorkflowStepResult: async (_taskId, result) => { written.push(result); return true; },
      isTaskLandingSettled: async () => isLandingSettled(task, repo),
    });
    const approvalBefore = structuredClone(task.workflowStepResults);
    const result = await executor.run(task, { experimentalFeatures: { workflowGraphExecutor: true } }, reviewMergeVerifyIr());
    return { result, ran, written, approvalBefore };
  }

  const confirmed = (extra: Partial<MergeDetails>): MergeDetails => ({ mergeConfirmed: true, mergeTargetBranch: "main", mergedAt: "2026-10-12T05:29:24.000Z", ...extra });

  const settledRows: Array<[string, () => TaskDetail]> = [
    ["normal landing, branch deleted", () => card("fusion/kb-gone", confirmed({ commitSha: landedSha, landedBranchTipSha: pinSha }))],
    ["normal landing interrupted before cleanup", () => card("fusion/kb-at-pin", confirmed({ commitSha: landedSha, landedBranchTipSha: pinSha }))],
    ["no-op landing with trailer proof", () => card("fusion/kb-at-pin", confirmed({ noOpMerge: true, noOpReason: "no-net-changes", landedBranchTipSha: pinSha }))],
    ["operator close as landed", () => card("fusion/kb-at-pin", confirmed({ noOpMerge: true, noOpReason: "closed as already landed by operator: superseded", landedFiles: [] }))],
    ["absent-branch reconcile", () => card("fusion/kb-gone", confirmed({ commitSha: landedSha, mergeTargetSource: "project-default" } as Partial<MergeDetails>))],
    ["recorded-landing short circuit", () => card("fusion/kb-gone", confirmed({ commitSha: landedSha, landedBranchTipSha: pinSha }))],
    ["workspace land", () => card("fusion/kb-at-pin", confirmed({ commitSha: landedSha }), { workspaceWorktrees: { "repo-a": { worktreePath: "/w/a", branch: "fusion/kb-159" } } })],
    ["pull-request merge without a pin", () => card("fusion/kb-at-pin", confirmed({ commitSha: landedSha, prNumber: 42 }))],
  ];

  it.each(settledRows)("%s: no review session, approval unchanged, walk reaches post-merge verification", async (_label, build) => {
    const task = build();

    const { result, ran, written, approvalBefore } = await walk(task);

    expect(ran).not.toContain("reviewer");
    expect(written.filter((entry) => entry.workflowStepId === "code-review")).toEqual([]);
    expect(task.workflowStepResults).toEqual(approvalBefore);
    expect(ran).toContain("merge");
    expect(ran).toContain("verifier");
    expect(result.visitedNodeIds).toContain("post-merge-verification");
  });

  it.each([
    ["an unlanded card", () => card("fusion/kb-at-pin")],
    ["a confirmed card whose branch moved past its pin", () => card("fusion/kb-moved", confirmed({ commitSha: landedSha, landedBranchTipSha: pinSha }))],
  ] as Array<[string, () => TaskDetail]>)("%s still runs Code Review", async (_label, build) => {
    const { ran, written } = await walk(build());

    expect(ran).toContain("reviewer");
    expect(written.some((entry) => entry.workflowStepId === "code-review" && entry.status === "pending")).toBe(true);
  });
});
