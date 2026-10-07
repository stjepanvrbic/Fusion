import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_CODING_WORKFLOW_IR, type Settings, type Task, type TaskStore } from "@fusion/core";
import { resumeMissingPostMergeGate } from "../merge/post-merge-gate-reseed.js";
import { recoverConfirmedMergePush } from "../merge/recover-confirmed-merge-push.js";

/*
FNXC:PostMergePublication 2026-10-07-21:05:
A push-divergence rebase rewrites every unpublished landing on the integration branch, but only the task that pushed
had its record refreshed. Earlier tasks kept SHAs that are on neither the branch nor the remote, so their publication
precondition and push recovery waited forever. A landing whose recorded SHA left its branch is re-pointed to the one
rewritten commit carrying the same Fusion-Task-Id trailer and the same change, verified on every read, so it also works
after a restart. Real git end to end.
*/
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
  cwd, encoding: "utf8",
  env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.t" },
}).trim();

function landing(root: string, taskId: string, file: string): string {
  writeFileSync(join(root, file), `${taskId}\n`);
  git(root, "add", file);
  git(root, "commit", "-q", "-m", `feat(${taskId}): ${file}`, "-m", `Fusion-Task-Id: ${taskId}`);
  return git(root, "rev-parse", "HEAD");
}

/** Two unpublished landings, a diverged remote, then the divergence rebase that publishes both as rewritten commits. */
function rewrittenHistory() {
  const parent = process.env.FUSION_TEST_WORKER_ROOT ?? tmpdir();
  mkdirSync(parent, { recursive: true });
  const base = mkdtempSync(join(parent, "fusion-rewritten-landing-"));
  dirs.push(base);
  const remote = join(base, "remote.git");
  const root = join(base, "root");
  const other = join(base, "other");
  git(base, "init", "-q", "--bare", "-b", "main", remote);
  git(base, "clone", "-q", remote, root);
  git(root, "checkout", "-q", "-b", "main");
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, "add", "base.txt");
  git(root, "commit", "-q", "-m", "base");
  git(root, "push", "-q", "origin", "main");
  const oldA = landing(root, "FN-A", "a.txt");
  const oldB = landing(root, "FN-B", "b.txt");
  git(base, "clone", "-q", remote, other);
  writeFileSync(join(other, "r.txt"), "remote\n");
  git(other, "add", "r.txt");
  git(other, "commit", "-q", "-m", "remote work");
  git(other, "push", "-q", "origin", "main");
  git(root, "pull", "-q", "--rebase", "origin", "main");
  git(root, "push", "-q", "origin", "main");
  const newB = git(root, "rev-parse", "HEAD");
  const newA = git(root, "rev-parse", "HEAD~1");
  return { root, oldA, oldB, newA, newB };
}

function fixture(root: string, taskId: string, commitSha: string, pushAfterMerge: boolean) {
  const rejection = {
    workflowStepId: "post-merge-verification", phase: "post-merge", status: "failed", verdict: "REVISE",
    completedAt: new Date(Date.now() - 61 * 60_000).toISOString(), notes: "No Full Suite run exists",
  };
  const task = {
    id: taskId, column: "in-review", updatedAt: "2026-10-07T21:00:00.000Z", autoMerge: true, steps: [],
    mergeDetails: { mergeConfirmed: true, commitSha, mergeTargetBranch: "main" },
    enabledWorkflowSteps: ["post-merge-verification"],
    workflowStepResults: [{ ...rejection, priorAttempts: [rejection, rejection, rejection] }],
  } as unknown as Task;
  const settings = { autoMerge: true, pushAfterMerge } as Settings;
  const items: unknown[] = [];
  let counter = 0;
  const store = {
    rootDir: root,
    getTask: vi.fn(async () => structuredClone(task)),
    getSettings: vi.fn(async () => settings),
    updateTaskAtomic: vi.fn(async (_id: string, update: (live: Task) => Partial<Task> | null | Promise<Partial<Task> | null>) => {
      const patch = await update(structuredClone(task));
      if (patch) Object.assign(task, patch, { updatedAt: `2026-10-07T21:00:0${++counter}.000Z` });
      return structuredClone(task);
    }),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: task.enabledWorkflowSteps ?? [] })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: task.enabledWorkflowSteps ?? [] })),
    getWorkflowDefinition: vi.fn(async () => ({ ir: JSON.stringify(BUILTIN_CODING_WORKFLOW_IR) })),
    listWorkflowWorkItemsForTask: vi.fn(async () => items),
    seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(async () => {
      items.push({});
      return { seeded: true, workItemId: "post-merge-continuation" };
    }),
  } as unknown as TaskStore;
  return { task, settings, store, items };
}

describe("landings rewritten by a push-divergence rebase", () => {
  it("re-points every earlier unpublished landing to its published rewrite, so its gate reseeds", async () => {
    const { root, oldA, oldB, newA, newB } = rewrittenHistory();
    for (const [taskId, oldSha, newSha] of [["FN-A", oldA, newA], ["FN-B", oldB, newB]] as const) {
      const { task, store, items } = fixture(root, taskId, oldSha, false);
      await expect(resumeMissingPostMergeGate(store, taskId)).resolves.toMatchObject({ outcome: "resumed" });
      expect(task.mergeDetails?.commitSha).toBe(newSha);
      expect(items).toHaveLength(1);
    }
  });

  it("lets push recovery deliver a rewritten landing instead of failing its ancestry proof", async () => {
    const { root, oldA, newA } = rewrittenHistory();
    const { task, settings, store } = fixture(root, "FN-A", oldA, true);
    await expect(recoverConfirmedMergePush(store, task, settings)).resolves.toBe("delivered");
    expect(task.mergeDetails?.commitSha).toBe(newA);
    expect(task.mergeDetails?.pushRecovery).toMatchObject({ commitSha: newA, pushedAt: expect.any(String) });
  });

  it("never re-points a landing to a commit whose change differs", async () => {
    const { root, oldA } = rewrittenHistory();
    // A second, different commit attributed to the same task makes the match ambiguous by trailer alone.
    writeFileSync(join(root, "a.txt"), "edited\n");
    git(root, "commit", "-q", "-am", "feat(FN-A): edit", "-m", "Fusion-Task-Id: FN-A");
    git(root, "push", "-q", "origin", "main");
    const { task, store } = fixture(root, "FN-A", oldA, false);
    await resumeMissingPostMergeGate(store, "FN-A");
    expect(task.mergeDetails?.commitSha).toBe(git(root, "rev-parse", "HEAD~2"));
  });
});
