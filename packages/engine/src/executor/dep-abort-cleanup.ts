/**
 * FNXC:CodeOrganization 2026-08-03-18:20:
 * handleDepAbortCleanup peeled from TaskExecutor (U4).
 * After mid-execution fn_task_add_dep: remove worktree, delete branch, discard progress.
 *
 * FNXC:LifecycleContainment 2026-10-07-18:04:
 * The discarded card stays in its WIP lane. It used to move back to the hold lane without a move
 * source, an automatic WIP-to-hold move FN-207 reserves for Plan Review REVISE. The work is still
 * discarded (checkout, branch, step progress, prompt checkboxes), and the new dependency becomes the
 * executor's in-place dependency hold; the scheduler's dependency wake-up re-dispatches the lane.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { isFusionDeletableBranch, type Settings, type TaskStore } from "@fusion/core";
import { resolveTaskWorkingBranch } from "../worktree/worktree-names.js";
import { RemovalReason } from "../worktree/worktree-pool.js";
import { executorLog } from "../logger.js";
import { resolveExternalExecutionCheckoutRoute } from "../execution/external-execution-checkout.js";
import { blockOuterDispatchWhenDependenciesUnmet } from "./dependency-dispatch-gate.js";
import { requeueExecutionInPlace } from "./in-place-execution-requeue.js";
import type { EngineRunContext } from "../util/run-audit.js";

const execAsync = promisify(exec);

export type DepAbortCleanupDeps = {
  rootDir: string;
  store: TaskStore;
  activeWorktrees: Map<string, unknown>;
  removeOwnWorktreeWithReconcile: (input: {
    worktreePath: string;
    settings: Settings;
    taskId: string;
    reason: RemovalReason;
  }) => Promise<void>;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  markGraphExecuteSelfRequeued: (taskId: string) => void;
  scheduleInPlaceExecutionResume: (taskId: string) => void;
};

export async function handleDepAbortCleanup(
  deps: DepAbortCleanupDeps,
  taskId: string,
  worktreePath: string,
): Promise<void> {
  executorLog.log(`${taskId} dependency added — work discarded, waiting in place for the new dependency`);

  const task = await deps.store.getTask(taskId);
  const externalExecutionRoute = await resolveExternalExecutionCheckoutRoute(task);

  /*
  FNXC:ExternalExecutionCheckout 2026-08-09-22:43:
  Persisted external execution routes are operator-owned checkouts. Executor cleanup may clear Fusion's managed task pointers, but it must never remove the routed directory or delete its branch during dependency abort, retry, pause, stuck-kill, or remediation recovery.
  */
  if (!externalExecutionRoute.configured) {
    try {
      const settings = await deps.store.getSettings() as Settings;
      await deps.removeOwnWorktreeWithReconcile({
        worktreePath,
        settings,
        taskId,
        reason: RemovalReason.ExecutorDispose,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      executorLog.warn(`${taskId}: failed to remove worktree during dep-abort cleanup (${worktreePath}): ${msg}`);
    }
  }

  // Delete only a Fusion-managed branch. External routes remain operator-owned.
  const branch = resolveTaskWorkingBranch(task);
  let branchDeleted = false;
  if (!externalExecutionRoute.configured && isFusionDeletableBranch(task, branch)) {
    try {
      await execAsync(`git branch -D "${branch}"`, { cwd: deps.rootDir });
      branchDeleted = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      executorLog.warn(`${taskId}: failed to delete branch during dep-abort cleanup (${branch}): ${msg}`);
    }
  }
  if (branchDeleted) {
    // FN-2165 regression guard: null baseBranch on any task that stored this branch
    try { await deps.store.clearStaleExecutionStartBranchReferences([branch], taskId); } catch { /* best-effort */ }
  }

  // Clear worktree tracking
  deps.activeWorktrees.delete(taskId);

  // Discard progress in place: clear the checkout, the session, and every step's status.
  const discardedSteps = task.steps.map((step) => ({ ...step, status: "pending" as const }));
  await deps.store.updateTask(taskId, {
    worktree: null,
    branch: null,
    branchWriteOrigin: "engine" as const,
    sessionFile: null,
    status: null,
    error: null,
    ...(discardedSteps.length > 0 ? { steps: discardedSteps, currentStep: 0 } : {}),
  });
  await deps.store.resetPromptCheckboxes(deps.store.taskDir(taskId)).catch((err: unknown) => {
    executorLog.warn(`${taskId}: failed to reset prompt checkboxes during dep-abort cleanup: ${err instanceof Error ? err.message : String(err)}`);
  });
  await deps.store.logEntry(taskId, "Execution stopped — work discarded, waiting in place for the added dependency");
  const liveTask = await deps.store.getTask(taskId);
  if (await blockOuterDispatchWhenDependenciesUnmet(deps, liveTask)) {
    deps.markGraphExecuteSelfRequeued(taskId);
    return;
  }
  await requeueExecutionInPlace(deps, taskId);
}
