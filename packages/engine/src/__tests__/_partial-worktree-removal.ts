import { vi } from "vitest";
import { readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { NativeWorktreeBackend, type WorktreeRemoveInput } from "../worktree/worktree-backend.js";
import * as worktreeRemovalRetry from "../worktree/worktree-removal-retry.js";

/*
FNXC:WorktreeCleanup 2026-10-11-11:14:
Handling of a checkout that `git worktree remove` only partly deleted must be verified on every platform and for every user, Windows first: that is where a locked file produces the state.
No real trigger is portable (Windows needs an open handle, POSIX needs permission bits, root ignores permission bits), so the removal step itself is faked at the native backend seam.
The fake does what git does when one delete fails: it removes the work-tree files and the admin entry, leaves one survivor, and rejects with a git-shaped error.
Everything after that rejection is real product code: the residue proof, deletion authority, residue marker, admin prune, audit row, pointer clear and branch delete.

The residue fake answers only for the armed checkout and delegates every other path.
The same remover deletes AI-merge clean rooms, which must keep working inside a full merge run.
*/

/** Checkout shapes a partly failed removal leaves behind: `.git` gone, or `.git` pointing at a deleted admin entry. */
export type PartialWorktreeRemovalShape = "incomplete" | "unregistered";

export interface PartialWorktreeRemovalOptions {
  shape?: PartialWorktreeRemovalShape;
  /** Top-level entry left behind as the file git could not delete; defaults to the first entry in sorted order that is not `.git`. */
  survivor?: string;
  /** Keep the residue in place: the engine's default residue remover reports failure for the armed checkout. */
  holdResidue?: boolean;
}

export interface PartialWorktreeRemoval {
  /** Name of the top-level entry the fake leaves behind. */
  survivor: string;
  /** Whether the faked removal has run. */
  fired(): boolean;
  /** Restores every spy this arming created. */
  restore(): void;
}

/** Realpath when the path exists, so the armed path and a caller's alias of it compare equal. */
function pathKey(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function adminDirectoryOf(worktreePath: string): string {
  const dotGit = join(worktreePath, ".git");
  const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
  if (!match) throw new Error(`${dotGit} is not a linked-worktree gitdir pointer`);
  const target = match[1]!.trim();
  return isAbsolute(target) ? target : resolve(dirname(dotGit), target);
}

function gitRemovalFailure(worktreePath: string): Error {
  const stderr = `error: failed to delete '${worktreePath}': Directory not empty`;
  return Object.assign(new Error(`Command failed: git worktree remove ${worktreePath}\n${stderr}`), { stderr, code: 128 });
}

/**
 * Makes the next native removal of `worktreePath` fail the way git does after one delete fails.
 * Call `restore()` when the test ends, also on failure.
 */
export function armPartialWorktreeRemoval(
  worktreePath: string,
  options: PartialWorktreeRemovalOptions = {},
): PartialWorktreeRemoval {
  const shape = options.shape ?? "incomplete";
  const armedKey = pathKey(worktreePath);
  const survivor = options.survivor ?? readdirSync(worktreePath).sort().find((entry) => entry !== ".git");
  if (!survivor) throw new Error(`${worktreePath} has no entry to leave behind`);

  let fired = false;
  const originalRemove = NativeWorktreeBackend.prototype.remove;
  const removeSpy = vi.spyOn(NativeWorktreeBackend.prototype, "remove").mockImplementation(
    async function (this: NativeWorktreeBackend, input: WorktreeRemoveInput): Promise<void> {
      if (fired || pathKey(input.worktreePath) !== armedKey) return originalRemove.call(this, input);
      fired = true;
      const adminDirectory = adminDirectoryOf(input.worktreePath);
      for (const entry of readdirSync(input.worktreePath)) {
        if (entry === survivor || (entry === ".git" && shape === "unregistered")) continue;
        rmSync(join(input.worktreePath, entry), { recursive: true, force: true });
      }
      rmSync(adminDirectory, { recursive: true, force: true });
      throw gitRemovalFailure(input.worktreePath);
    },
  );

  const originalRemoveDirectory = worktreeRemovalRetry.removeDirectoryWithRetry;
  const residueSpy = options.holdResidue
    ? vi.spyOn(worktreeRemovalRetry, "removeDirectoryWithRetry").mockImplementation(async (input) => {
        if (pathKey(input.path) !== armedKey) return originalRemoveDirectory(input);
        return {
          removed: false,
          attempts: 1,
          benignAbsent: false,
          lastCode: "EBUSY",
          lastError: `EBUSY: resource busy or locked, rmdir '${input.path}'`,
        };
      })
    : undefined;

  let restored = false;
  return {
    survivor,
    fired: () => fired,
    restore: () => {
      if (restored) return;
      restored = true;
      removeSpy.mockRestore();
      residueSpy?.mockRestore();
    },
  };
}
