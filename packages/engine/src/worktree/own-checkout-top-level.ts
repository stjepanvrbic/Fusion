import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isSamePath } from "@fusion/core";

const execFileAsync = promisify(execFile);

/**
 * FNXC:ReviewInputProof 2026-10-12-10:55:
 * A review probe must answer only for the checkout it was given.
 * Task worktrees are nested under the primary checkout, so when cleanup removes a worktree's `.git` link but leaves the directory, `git` walks up and answers for the primary repository.
 * Returns true only when `git rev-parse --show-toplevel` from `checkoutPath` names that same directory, compared with `isSamePath` (realpath, case-insensitive on Windows).
 * A missing directory, a non-repository, or a git failure returns false.
 */
export async function isOwnGitTopLevel(checkoutPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: checkoutPath, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024,
    });
    const topLevel = stdout.trim();
    return topLevel.length > 0 && isSamePath(topLevel, checkoutPath);
  } catch {
    return false;
  }
}
