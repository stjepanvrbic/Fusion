/**
 * FNXC:CodeOrganization 2026-08-03-12:10:
 * resetStepsIfWorkLost peeled from TaskExecutor (U4).
 *
 * FNXC:StuckRequeue 2026-06-27-23:55:
 * Stuck-requeue cleanup is about to delete the checkout. If git cannot prove the branch has durable commits, treat completed steps as lost uncommitted work and reset them.
 *
 * FNXC:StuckRequeue 2026-10-07-19:23:
 * Completed steps are reset only on positive proof of lost work: the branch is absent, or its tip equals its merge-base with HEAD.
 * A git failure, timeout, or shell error is not proof, so it logs and leaves step progress intact.
 * Before this, any probe failure (including the Windows `2>/dev/null` cmd.exe failure) reset every done step and the executor redid finished work.
 */
import { isWorkspaceTask, loadWorkspaceConfig, type Task } from "@fusion/core";
import { exec } from "node:child_process";
import { bindPosixShell } from "@fusion/core";
import { promisify } from "node:util";
import { resolveTaskWorkingBranch } from "../worktree/worktree-names.js";
import { executorLog } from "../logger.js";

const execAsync = bindPosixShell(promisify(exec));

export type ResetStepsIfWorkLostDeps = {
  rootDir: string;
  resetLostWorkStepProgress: (task: Task, completedCount: number, reason: string) => Promise<void>;
};

export async function resetStepsIfWorkLost(
  deps: ResetStepsIfWorkLostDeps,
  task: Task,
): Promise<void> {
  const completedSteps = task.steps.filter(
    (s) => s.status === "done" || s.status === "in-progress",
  );
  if (completedSteps.length === 0) return;
  /*
  FNXC:WorkspaceRootRouting 2026-08-19-12:15:
  The stuck-requeue caller supplies one root cwd and one singular branch. That is never proof for a
  multi-repository task: a stale root failure must not reset steps whose work belongs to registered
  sub-repository worktrees. Per-repository loss proof remains owned by workspace-aware recovery.
  */
  if (isWorkspaceTask(task)) return;
  try {
    if ((await loadWorkspaceConfig(deps.rootDir))?.repos.length) return;
  } catch { /* an unreadable config cannot establish workspace mode */ }

  const branchName = resolveTaskWorkingBranch(task);

  const proof = await proveBranchDurability(deps.rootDir, branchName);
  if (proof.kind === "absent") {
    await deps.resetLostWorkStepProgress(task, completedSteps.length, "branch does not exist");
  } else if (proof.kind === "no-commits") {
    await deps.resetLostWorkStepProgress(task, completedSteps.length, "branch had no commits");
  } else if (proof.kind === "unknown") {
    executorLog.warn(
      `${task.id}: unable to prove whether branch ${branchName} holds durable commits; keeping ${completedSteps.length} completed step(s) (${proof.error})`,
    );
  }
}

type BranchDurability =
  | { kind: "has-commits" }
  | { kind: "no-commits" }
  | { kind: "absent" }
  | { kind: "unknown"; error: string };

function execErrorDetail(err: unknown): { code: unknown; stderr: string; message: string } {
  const e = (err ?? {}) as { code?: unknown; stderr?: unknown; message?: unknown };
  return {
    code: e.code,
    stderr: typeof e.stderr === "string" ? e.stderr.trim() : "",
    message: typeof e.message === "string" ? e.message : String(err),
  };
}

/**
 * `rev-parse --verify --quiet` exits 1 with no stderr only when the ref is missing.
 * Any other failure shape (spawn error, timeout, exit 128, shell stderr) leaves durability unknown.
 */
async function proveBranchDurability(rootDir: string, branchName: string): Promise<BranchDurability> {
  let branchHead: string;
  try {
    const { stdout } = await execAsync(
      `git rev-parse --verify --quiet "refs/heads/${branchName}^{commit}"`,
      { cwd: rootDir, encoding: "utf-8" },
    );
    branchHead = stdout.trim();
  } catch (err: unknown) {
    const detail = execErrorDetail(err);
    if (detail.code === 1 && detail.stderr === "") return { kind: "absent" };
    return { kind: "unknown", error: detail.stderr || detail.message };
  }
  if (!branchHead) return { kind: "unknown", error: "rev-parse returned no commit" };

  try {
    const { stdout } = await execAsync(
      `git merge-base "${branchName}" HEAD`,
      { cwd: rootDir, encoding: "utf-8" },
    );
    return stdout.trim() === branchHead ? { kind: "no-commits" } : { kind: "has-commits" };
  } catch (err: unknown) {
    const detail = execErrorDetail(err);
    // Exit 1 with no output: no common ancestor, so every branch commit is unique to it.
    if (detail.code === 1 && detail.stderr === "") return { kind: "has-commits" };
    return { kind: "unknown", error: detail.stderr || detail.message };
  }
}
