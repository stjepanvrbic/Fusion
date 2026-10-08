import { exec } from "node:child_process";
import { bindPosixShell } from "@fusion/core";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { isFusionDeletableBranch, type Task, type TaskStore } from "@fusion/core";
import { activeSessionRegistry } from "../agents/active-session-registry.js";
import {
  classifyForeignOnlyContamination,
  reanchorBranchToBase,
} from "../execution/branch-conflicts.js";
import type { RunAuditor } from "../util/run-audit.js";
import { isUsableTaskWorktree } from "../worktree/worktree-pool.js";

const execAsync = bindPosixShell(promisify(exec));
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface RecoverForeignOnlyContaminationDeps {
  repoDir: string;
  taskStore: TaskStore;
  runAudit: RunAuditor;
  /** Arms the executor's guarded in-place re-dispatch once the branch is repaired. */
  resumeInPlace: (taskId: string) => void;
  integrationBranch: string;
}

export interface RecoverForeignOnlyContaminationResult {
  recovered: boolean;
  subtype?: "reanchor" | "branch-discard";
  reason?: string;
}

export async function recoverForeignOnlyContamination(
  task: Task,
  deps: RecoverForeignOnlyContaminationDeps,
): Promise<RecoverForeignOnlyContaminationResult> {
  if (!task.branch || !task.worktree) return { recovered: false, reason: "missing-branch-or-worktree" };

  const baseSha = task.baseCommitSha ?? task.baseBranch ?? task.executionStartBranch ?? deps.integrationBranch;
  if (!baseSha) {
    await deps.runAudit.database({
      type: "task:auto-recover-foreign-only-contamination-skipped",
      target: task.id,
      metadata: { reason: "baseSha-unresolved" },
    });
    return { recovered: false, reason: "baseSha-unresolved" };
  }

  const classification = await classifyForeignOnlyContamination({
    repoDir: deps.repoDir,
    branchName: task.branch,
    baseSha,
    taskId: task.id,
  });

  if (classification.kind !== "foreign-only-no-own-work" && classification.kind !== "foreign-only-already-upstream") {
    await deps.runAudit.database({
      type: "task:auto-recover-foreign-only-contamination-skipped",
      target: task.id,
      metadata: { reason: "ambiguous", kind: classification.kind },
    });
    return { recovered: false, reason: "ambiguous" };
  }

  if (await isUsableTaskWorktree(deps.repoDir, task.worktree)) {
    await reanchorBranchToBase({
      repoDir: deps.repoDir,
      worktreePath: task.worktree,
      branchName: task.branch,
      baseSha,
      taskId: task.id,
    });

    /* FNXC:LifecycleContainment 2026-10-07-18:04: the re-anchored card resumes in its lane; the former contained move was an FN-217 no-op. */
    await deps.taskStore.updateTask(task.id, {
      recoveryRetryCount: 0,
      nextRecoveryAt: null,
      error: null,
      paused: false,
      pausedReason: null,
    });
    deps.resumeInPlace(task.id);
    await deps.runAudit.database({
      type: "task:auto-recover-foreign-only-contamination",
      target: task.id,
      metadata: { subtype: "reanchor", kind: classification.kind, baseSha },
    });
    return { recovered: true, subtype: "reanchor" };
  }

  if (activeSessionRegistry.isPathActive(task.worktree)) {
    await deps.runAudit.database({
      type: "task:auto-recover-foreign-only-contamination-skipped",
      target: task.id,
      metadata: { reason: "active-session", kind: classification.kind },
    });
    return { recovered: false, reason: "active-session" };
  }

  await execAsync("git worktree prune", { cwd: deps.repoDir, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER }).catch(() => undefined);
  if (isFusionDeletableBranch(task, task.branch)) {
    await execAsync(`git branch -D ${quote(task.branch)}`, { cwd: deps.repoDir, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER }).catch(() => undefined);
  }

  /* FNXC:LifecycleContainment 2026-10-07-18:04: the discarded branch is recreated by an in-place resume; the former contained move was an FN-217 no-op. */
  await deps.taskStore.updateTask(task.id, {
    recoveryRetryCount: 0,
    nextRecoveryAt: null,
    error: null,
    paused: false,
    pausedReason: null,
    worktree: null,
    branch: null, branchWriteOrigin: "engine" as const,
    baseCommitSha: null,
    modifiedFiles: [],
  });
  deps.resumeInPlace(task.id);
  await deps.runAudit.database({
    type: "task:auto-recover-foreign-only-contamination",
    target: task.id,
    metadata: {
      subtype: "branch-discard",
      kind: classification.kind,
      baseSha,
      worktreePresent: existsSync(task.worktree),
    },
  });
  return { recovered: true, subtype: "branch-discard" };
}
