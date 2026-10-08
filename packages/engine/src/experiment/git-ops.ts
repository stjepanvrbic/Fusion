import { commitIdentityArgs, resolveCommitIdentity } from "../git-identity.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  applyStashBySha,
  dropStashBySha,
  pushTaggedStash,
  type TaggedStashHandle,
} from "../merge/tagged-stash.js";
import {
  ExperimentFinalizeBranchExistsError,
  ExperimentFinalizeCherryPickConflictError,
  ExperimentFinalizeMergeBaseError,
} from "./finalize-types.js";

const execAsync = promisify(exec);
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

export type StashHandle = TaggedStashHandle;

export interface GitOps {
  head(): Promise<string>;
  add(paths: string[]): Promise<void>;
  commit(message: string): Promise<string>;
  resetHard(ref: string): Promise<void>;
  /**
   * Set aside the working-tree changes under a unique label; null when there is nothing to save.
   * FNXC:WorktreeStashIsolation 2026-10-08-08:29: the stash list is shared by every worktree of the
   * repository (KB-008), so entries are addressed by SHA, never by `stash@{N}` position.
   */
  stashSave(label: string): Promise<StashHandle | null>;
  /** Re-apply a saved entry by SHA, then drop it by SHA. Throws (and keeps the entry) when the apply fails. */
  stashRestore(handle: StashHandle): Promise<void>;
  statusPorcelain(): Promise<string>;
  mergeBase(refA: string, refB: string): Promise<string>;
  branchExists(name: string): Promise<boolean>;
  createBranch(name: string, startPoint: string): Promise<void>;
  cherryPick(commit: string): Promise<void>;
  checkout(ref: string): Promise<void>;
  currentBranch(): Promise<string | null>;
  deleteBranch(name: string, opts?: { force?: boolean }): Promise<void>;
}

async function runGit(cwd: string, args: string[], opts: { keepLeadingWhitespace?: boolean } = {}): Promise<string> {
  const command = `git ${args.join(" ")}`;
  try {
    const { stdout } = await execAsync(command, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return opts.keepLeadingWhitespace ? stdout.trimEnd() : stdout.trim();
  } catch (error) {
    const err = error as Error & { stderr?: string; stdout?: string };
    const stderr = err.stderr?.trim();
    const stdout = err.stdout?.trim();
    const detail = stderr || stdout || err.message;
    throw new Error(`Git command failed (${command}): ${detail}`);
  }
}

export function defaultGitOps(cwd: string): GitOps {
  return {
    async head() {
      return await runGit(cwd, ["rev-parse", "HEAD"]);
    },
    async add(paths: string[]) {
      await runGit(cwd, ["add", ...paths]);
    },
    async commit(message: string) {
      // FNXC:GitIdentity 2026-08-18-07:55: explicit identity — experiment commits must not depend on
      // ambient git config either (a host without one cannot commit at all).
      await runGit(cwd, [...commitIdentityArgs(resolveCommitIdentity()), "commit", "-m", JSON.stringify(message)]);
      return await runGit(cwd, ["rev-parse", "HEAD"]);
    },
    async resetHard(ref: string) {
      await runGit(cwd, ["reset", "--hard", ref]);
    },
    async stashSave(label: string) {
      return await pushTaggedStash(cwd, label, { timeoutMs: GIT_TIMEOUT_MS });
    },
    async stashRestore(handle: StashHandle) {
      const applied = await applyStashBySha(cwd, handle.sha, { timeoutMs: GIT_TIMEOUT_MS });
      if (!applied.ok) {
        throw new Error(`Git stash apply failed for ${handle.sha} (${handle.label}); entry kept: ${applied.error}`);
      }
      await dropStashBySha(cwd, handle.sha);
    },
    async statusPorcelain() {
      // FNXC:ExperimentRevert 2026-10-08-08:29: porcelain lines start with a status column that may be a
      // space (" M path"); trimming the leading whitespace corrupted the first line and revertDiscarded missed it.
      return await runGit(cwd, ["status", "--porcelain"], { keepLeadingWhitespace: true });
    },
    async mergeBase(refA: string, refB: string) {
      try {
        return await runGit(cwd, ["merge-base", refA, refB]);
      } catch (error) {
        const err = error as Error;
        throw new ExperimentFinalizeMergeBaseError(`Unable to resolve merge-base for ${refA} and ${refB}: ${err.message}`);
      }
    },
    async branchExists(name: string) {
      try {
        await runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
        return true;
      } catch {
        return false;
      }
    },
    async createBranch(name: string, startPoint: string) {
      const exists = await this.branchExists(name);
      if (exists) {
        throw new ExperimentFinalizeBranchExistsError(`Branch already exists: ${name}`);
      }
      await runGit(cwd, ["branch", name, startPoint]);
    },
    async cherryPick(commit: string) {
      try {
        await runGit(cwd, ["cherry-pick", commit]);
      } catch (error) {
        const err = error as Error;
        try {
          await runGit(cwd, ["cherry-pick", "--abort"]);
        } catch {
          // best effort
        }
        throw new ExperimentFinalizeCherryPickConflictError(`Cherry-pick failed for ${commit}`, {
          groupId: "unknown",
          commit,
          stderr: err.message,
        });
      }
    },
    async checkout(ref: string) {
      await runGit(cwd, ["checkout", ref]);
    },
    async currentBranch() {
      try {
        return await runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
      } catch {
        return null;
      }
    },
    async deleteBranch(name: string, opts?: { force?: boolean }) {
      await runGit(cwd, ["branch", opts?.force ? "-D" : "-d", name]);
    },
  };
}
