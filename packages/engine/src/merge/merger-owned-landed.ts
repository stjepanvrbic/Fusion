/**
 * FNXC:CodeOrganization 2026-07-15-14:30:
 * Owned-landed commit classification helpers peeled from merger.ts.
 */
import type { Task } from "@fusion/core";
import { promisify } from "node:util";
import * as childProcess from "node:child_process";
import { parseDiffStat } from "./merger-file-scope.js";
import { resolveTaskWorkingBranch } from "../worktree/worktree-names.js";
import { getCommitTaskOwnership } from "./already-merged-detector.js";
import { parseCommitTimeSeconds, resolveLandedCommitProvenance, type LandedCommitScope } from "./landed-commit-provenance.js";

const execFileAsync: (file: string, args: string[], opts?: import("node:child_process").ExecFileOptions) => Promise<{ stdout: string; stderr: string }> = (file, args, opts) =>
  (promisify(childProcess.execFile) as (f: string, a: string[], o?: object) => Promise<{ stdout: string; stderr: string }>)(file, args, opts);

/** FNXC:MergeOwnership 2026-07-15-13:25: Task-id trailer key used to prove merge-commit ownership during recovery. */
export const FUSION_TASK_ID_TRAILER_KEY = "Fusion-Task-Id";

interface OwnedLandedCommit {
  sha: string;
  subject?: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
}

export type OwnedLandedClassification =
  | { kind: "owned-commit"; commit: OwnedLandedCommit }
  | { kind: "proven-no-op"; baseRef: string; ownDiffEmpty: true }
  | {
    kind: "no-changes-finalized";
    baseRef: string;
    details: {
      branchExists: boolean;
      aheadCount: number | null;
      baseReachableFromTarget: boolean;
    };
  }
  | {
    kind: "unproven";
    reason: "foreign-start-point" | "no-owned-commit-foreign-deltas" | "missing-evidence";
    details: Record<string, unknown>;
  };

/**
 * FNXC:LandedCommitProvenance 2026-10-11-07:40:
 * This finder answers the same "did this task land?" question as self-healing's `findLandedTaskCommit`, for `classifyOwnedLandedEvidence` (merger zero-ahead and branch-missing paths, self-healing finalize sweeps).
 * It used to scan all of HEAD and take the first hit, with a local ownership regex whose optional scope let a bare `feat:` subject plus a prose mention count as ownership (the 2026-05-23 incident bug #2 shape).
 * It now classifies with the shared `getCommitTaskOwnership`, walks every candidate, and accepts only a commit the shared landed-commit provenance verdict proves, so a recycled task ID can no longer finalize a task against an older unrelated commit.
 */
async function findOwnedLandedCommitForTask(rootDir: string, task: Task): Promise<OwnedLandedCommit | null> {
  const nowMs = Date.now();
  const gitOk = async (args: string[]): Promise<boolean> => {
    try {
      await execFileAsync("git", args, { cwd: rootDir });
      return true;
    } catch {
      return false;
    }
  };
  const scopeOf = async (sha: string): Promise<LandedCommitScope> => {
    if (!task.baseCommitSha) return "unbounded";
    if (!(await gitOk(["merge-base", "--is-ancestor", task.baseCommitSha, sha]))) return "unbounded";
    return (await gitOk(["merge-base", "--is-ancestor", sha, task.baseCommitSha])) ? "unbounded" : "bounded";
  };
  const onTaskBranch = async (sha: string): Promise<boolean> => {
    const branchRef = `refs/heads/${resolveTaskWorkingBranch(task)}`;
    return (await gitOk(["rev-parse", "--verify", "--quiet", branchRef]))
      && (await gitOk(["merge-base", "--is-ancestor", sha, branchRef]));
  };

  const evaluated = new Set<string>();
  const tryHydrate = async (sha: string): Promise<OwnedLandedCommit | null> => {
    if (evaluated.has(sha)) return null;
    evaluated.add(sha);
    try {
      await execFileAsync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: rootDir });
      const { stdout } = await execFileAsync("git", ["log", "-1", "--format=%H%x1f%s%x1f%ct%x1f%b", sha], {
        cwd: rootDir,
        encoding: "utf-8",
      });
      const [resolvedSha, subject = "", commitTime, ...bodyParts] = stdout.trim().split("\x1f");
      if (!resolvedSha) return null;
      const ownership = getCommitTaskOwnership(task.id, task.lineageId, subject, bodyParts.join("\x1f"));
      const verdict = await resolveLandedCommitProvenance({
        ownership,
        scope: ownership.owned ? await scopeOf(resolvedSha) : "unbounded",
        commitTimeMs: parseCommitTimeSeconds(commitTime),
        taskCreatedAt: task.createdAt,
        taskLineageId: task.lineageId,
        nowMs,
      }, () => onTaskBranch(resolvedSha));
      if (!verdict.accepted) return null;
      const owned: OwnedLandedCommit = { sha: resolvedSha, subject };
      try {
        const { stdout: statsOut } = await execFileAsync("git", ["show", "--shortstat", "--format=", resolvedSha], {
          cwd: rootDir,
          encoding: "utf-8",
        });
        Object.assign(owned, parseDiffStat(statsOut));
      } catch {
        // stats optional
      }
      return owned;
    } catch {
      return null;
    }
  };

  if (task.mergeDetails?.commitSha) {
    const ownedStored = await tryHydrate(task.mergeDetails.commitSha);
    if (ownedStored) return ownedStored;
  }

  const trailer = `${FUSION_TASK_ID_TRAILER_KEY}: ${task.id}`;
  const searches: string[][] = [
    ...(task.lineageId
      ? [["log", "--format=%H", "--max-count=20", "--fixed-strings", `--grep=Fusion-Task-Lineage: ${task.lineageId}`, "HEAD"]]
      : []),
    ["log", "--format=%H", "--max-count=20", "--fixed-strings", `--grep=${trailer}`, "HEAD"],
    ["log", "--format=%H", "--max-count=20", "--fixed-strings", `--grep=${task.id}`, "HEAD"],
  ];

  for (const args of searches) {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd: rootDir, encoding: "utf-8" });
      for (const sha of stdout.trim().split("\n").map((line) => line.trim()).filter(Boolean)) {
        const owned = await tryHydrate(sha);
        if (owned) return owned;
      }
    } catch {
      // continue
    }
  }

  return null;
}

export function toTaskToken(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export async function classifyOwnedLandedEvidence(
  rootDir: string,
  task: Task,
  opts: { mergeTargetBranch: string },
): Promise<OwnedLandedClassification> {
  const branch = resolveTaskWorkingBranch(task);
  const mergeTargetBranch = opts.mergeTargetBranch;

  const ownedCommit = await findOwnedLandedCommitForTask(rootDir, task);
  if (ownedCommit) {
    try {
      await execFileAsync("git", ["merge-base", "--is-ancestor", ownedCommit.sha, mergeTargetBranch], { cwd: rootDir });
      return { kind: "owned-commit", commit: ownedCommit };
    } catch {
      // fall through
    }
  }

  let aheadCount: number | null = null;
  try {
    const { stdout } = await execFileAsync("git", ["rev-list", "--count", `${mergeTargetBranch}..${branch}`], {
      cwd: rootDir,
      encoding: "utf-8",
    });
    aheadCount = Number.parseInt(stdout.trim(), 10);
    if (!Number.isFinite(aheadCount)) aheadCount = null;
  } catch {
    aheadCount = null;
  }

  let baseReachableFromTarget = false;
  if (task.baseCommitSha) {
    try {
      await execFileAsync("git", ["merge-base", "--is-ancestor", task.baseCommitSha, mergeTargetBranch], { cwd: rootDir });
      baseReachableFromTarget = true;
    } catch {
      baseReachableFromTarget = false;
    }
  }

  if (aheadCount === 0 && (baseReachableFromTarget || !task.baseCommitSha)) {
    return { kind: "proven-no-op", baseRef: mergeTargetBranch, ownDiffEmpty: true };
  }

  /*
   * FNXC:MergeOwnership 2026-07-15-13:25:
   * FN-5345/FN-5377 empty-own-diff detection preserves the no-op policy for
   * branches whose commits leave no net change against their integration base.
   */
  //
  // A branch with one or more own commits whose net tree change vs its own
  // merge-base with the integration branch is empty (e.g. a verification-only
  // task that produced a `git commit --allow-empty` handoff commit) is
  // logically equivalent to `proven-no-op` — there is nothing to land.
  //
  // We require the merge-base to be reachable from the integration target so
  // we never claim no-op for a branch rooted off some other ref. This pairs
  // with the FN-5345/FN-5377 pre-commit empty-commit refusal hook (which
  // prevents the bad state from being created going forward) and recovers
  // any tasks already wedged in this state.
  if (aheadCount !== null && aheadCount > 0) {
    try {
      const { stdout: mergeBaseOut } = await execFileAsync(
        "git",
        ["merge-base", mergeTargetBranch, branch],
        { cwd: rootDir, encoding: "utf-8" },
      );
      const mergeBase = mergeBaseOut.trim();
      if (mergeBase) {
        let ownDiffEmpty = false;
        try {
          await execFileAsync(
            "git",
            ["diff", "--quiet", `${mergeBase}..${branch}`],
            { cwd: rootDir },
          );
          ownDiffEmpty = true;
        } catch {
          // exit non-zero — net diff exists, NOT empty-own-diff
          ownDiffEmpty = false;
        }
        if (ownDiffEmpty) {
          let mergeBaseReachable = baseReachableFromTarget;
          if (!mergeBaseReachable) {
            try {
              await execFileAsync(
                "git",
                ["merge-base", "--is-ancestor", mergeBase, mergeTargetBranch],
                { cwd: rootDir },
              );
              mergeBaseReachable = true;
            } catch {
              mergeBaseReachable = false;
            }
          }
          if (mergeBaseReachable) {
            return { kind: "proven-no-op", baseRef: mergeTargetBranch, ownDiffEmpty: true };
          }
        }
      }
    } catch {
      // merge-base lookup failed — fall through to existing classifications
    }
  }

  let branchExists = false;
  try {
    await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: rootDir });
    branchExists = true;
  } catch {
    branchExists = false;
  }

  if (!ownedCommit && !branchExists && aheadCount === null && (baseReachableFromTarget || !task.baseCommitSha)) {
    return {
      kind: "no-changes-finalized",
      baseRef: mergeTargetBranch,
      details: {
        branchExists,
        aheadCount,
        baseReachableFromTarget,
      },
    };
  }

  if (task.baseCommitSha && !baseReachableFromTarget) {
    try {
      const { stdout } = await execFileAsync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads/fusion"], {
        cwd: rootDir,
        encoding: "utf-8",
      });
      const refs = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
      for (const ref of refs) {
        if (ref === branch) continue;
        try {
          await execFileAsync("git", ["merge-base", "--is-ancestor", task.baseCommitSha, ref], { cwd: rootDir });
          return {
            kind: "unproven",
            reason: "foreign-start-point",
            details: { branch, mergeTargetBranch, baseCommitSha: task.baseCommitSha, foreignRef: ref, aheadCount },
          };
        } catch {
          // continue
        }
      }
    } catch {
      // continue to missing evidence
    }
  }

  if (aheadCount !== null && aheadCount > 0) {
    try {
      const { stdout } = await execFileAsync("git", ["log", "--format=%s%x1f%b", `${mergeTargetBranch}..${branch}`], {
        cwd: rootDir,
        encoding: "utf-8",
      });
      const currentToken = toTaskToken(task.id);
      const lines = stdout.split("\n").filter(Boolean);
      let foreignCount = 0;
      for (const line of lines) {
        const [subject = "", body = ""] = line.split("\x1f");
        const trailerMatch = body.match(/Fusion-Task-Id:\s*([^\n\r]+)/i);
        const trailerToken = trailerMatch ? toTaskToken(trailerMatch[1] || "") : "";
        const subjectTokenMatch = subject.match(/\((FN-[^)]+)\)/i);
        const subjectToken = subjectTokenMatch ? toTaskToken(subjectTokenMatch[1] || "") : "";
        if ((trailerToken && trailerToken !== currentToken) || (subjectToken && subjectToken !== currentToken)) {
          foreignCount += 1;
        }
      }
      if (foreignCount > 0) {
        return {
          kind: "unproven",
          reason: "no-owned-commit-foreign-deltas",
          details: { branch, mergeTargetBranch, aheadCount, foreignCommitCount: foreignCount },
        };
      }
    } catch {
      // continue
    }
  }

  return {
    kind: "unproven",
    reason: "missing-evidence",
    details: {
      branch,
      mergeTargetBranch,
      aheadCount,
      branchExists,
      baseCommitShaPresent: Boolean(task.baseCommitSha),
      baseReachableFromTarget,
      hasOwnedCommit: Boolean(ownedCommit),
    },
  };
}


// ── Deterministic merge verification ──────────────────────────────────

/**
 * Run verification commands deterministically in the engine.
 * Executes testCommand first, then buildCommand (when both are configured).
 * Returns structured results so failures are logged with actionable detail.
 * Throws VerificationError on failure with command details.
 */
