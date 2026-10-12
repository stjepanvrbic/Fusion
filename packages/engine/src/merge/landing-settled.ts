import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Task } from "@fusion/core";
import { resolveTaskWorkingBranch } from "../worktree/worktree-names.js";

const execFileAsync = promisify(execFile);

/**
 * FNXC:MergeLandingCommitPoint 2026-10-12-09:40:
 * One definition of "this card's work has landed" for every before-merge consumer: the graph's pre-merge gate entry, the stale-content review reroute and the merge door.
 * KB-146 landed on main, then a stale-approval check compared its earlier Code Review approval with a diff that was empty only because the work had landed, and re-ran Code Review on the landed card.
 * A card is settled when its merge is confirmed, except in the one designed state that still holds unlanded work: the landing pinned the reviewed branch tip and the task branch now points somewhere else (it gained commits after the reviewed squash).
 * A branch ref that cannot be resolved counts as absent, and a card without `mergeConfirmed` is never settled.
 */
export async function isLandingSettled(
  task: Pick<Task, "id" | "branch" | "branchContext" | "mergeDetails">,
  projectRootDir: string,
): Promise<boolean> {
  const details = task.mergeDetails;
  if (details?.mergeConfirmed !== true) return false;
  const pin = details.landedBranchTipSha?.trim();
  if (!pin) return true;
  const branch = resolveTaskWorkingBranch(task);
  if (details.mergeTargetBranch && branch === details.mergeTargetBranch) return true;
  const liveTip = await readBranchTip(branch, projectRootDir);
  return !liveTip || liveTip === pin;
}

async function readBranchTip(branch: string, projectRootDir: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], {
      cwd: projectRootDir,
      encoding: "utf-8",
      timeout: 30_000,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
