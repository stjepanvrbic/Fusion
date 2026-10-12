import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isOwnGitTopLevel } from "./own-checkout-top-level.js";

const execFileAsync = promisify(execFile);

export type ReviewCheckoutProbe =
  | { state: "clean" }
  | { state: "dirty"; paths: string[] }
  | { state: "unavailable" };

/**
 * Approval binds committed content; ignored verification artifacts are not source changes.
 *
 * FNXC:ReviewInputProof 2026-10-12-10:55:
 * The status is read only from `worktreePath` as its own checkout, checked before and after `git status`.
 * Cleanup can remove the `.git` link while the command runs, and removal is one-way, so a passing check afterwards proves the status came from this checkout.
 */
export async function probeReviewCheckout(worktreePath: string): Promise<ReviewCheckoutProbe> {
  if (!await isOwnGitTopLevel(worktreePath)) return { state: "unavailable" };
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: worktreePath, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    const records = stdout.split("\0").filter(Boolean);
    const paths: string[] = [];
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      paths.push(record.slice(3));
      if (/[RC]/.test(record.slice(0, 2)) && records[index + 1]) paths.push(records[++index]);
    }
    if (!await isOwnGitTopLevel(worktreePath)) return { state: "unavailable" };
    return paths.length ? { state: "dirty", paths } : { state: "clean" };
  } catch {
    return { state: "unavailable" };
  }
}
