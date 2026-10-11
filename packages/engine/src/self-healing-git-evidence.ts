/*
FNXC:SelfHealingSubstrate 2026-07-27-05:10 (U4 substrate decomposition, PR1):
GIT-EVIDENCE SUBSTRATE — pure evidence readers extracted from self-healing.ts.

These read git and the task row to answer factual questions: does this commit
belong to this task, is this branch tip foreign, did this task already land, what
did it change. None of them mutates the store. They are the safest cut in the
decomposition and the most valuable to test directly, which is why they go first.

RELOCATION, NOT REWRITE. Every body below is byte-identical to its original in
self-healing.ts. The mechanical proof is in the PR: each moved body diffed against
its pre-move text with import lines stripped. Three deviations were structurally
unavoidable and are enumerated there rather than hidden here:
  1. `private` -> `protected` on the 14 methods and the `options` field, because a
     subclass cannot call a `private` base member;
  2. two `SelfHealingManager["readCommitTaskOwnership"]` type annotations rewritten
     to reference this class, since the original would be a circular import;
  3. four module-level helpers moved with them and re-exported, because
     `escapeRegex` / `shellQuote` still have call sites left behind in
     self-healing.ts and the import must stay one-directional.

WHY A BASE CLASS AND NOT FREE FUNCTIONS: these are `private async` METHODS that
close over `this.options`. Converting them to free functions would change every
signature, which is a behavior-adjacent edit riding in a file move — exactly the
combination that hid the last four safeguard regressions. An abstract base keeps
`this` semantics and every body unchanged.

FNXC:LandedCommitProvenance 2026-10-11-07:40:
The byte-identical claim above no longer holds for `findLandedTaskCommit`: it now routes every candidate through the shared landed-commit provenance verdict, with the stored-sha, scope and task-branch probes added beside it (`assessStoredLandedCommit`, `assessLandedCommitCandidate`, `landedCommitScope`, `isCommitOnTaskBranch`).
The local `commitOwnedByTask` regex was replaced by the shared `getCommitTaskOwnership` classifier.
*/
import { promisify } from "node:util";
import { exec } from "node:child_process";
import { bindPosixShell } from "@fusion/core";
/* NOTE: `findAlreadyMergedTaskCommit` here is the FREE function from the
   detector module — it shares a name with the protected method below, and inside
   the class body the bare identifier resolves to this import. That collision
   pre-dates the move and is preserved exactly. */
import { findAlreadyMergedTaskCommit, getCommitTaskOwnership } from "./merge/already-merged-detector.js";
import { createLogger } from "./logger.js";
import {
  parseCommitTimeSeconds,
  resolveLandedCommitProvenance,
  type LandedCommitProvenanceVerdict,
  type LandedCommitScope,
} from "./merge/landed-commit-provenance.js";
import { resolveTaskWorkingBranch } from "./worktree/worktree-names.js";
import type { Task } from "@fusion/core";

const log = createLogger("self-healing");
/* TYPE-ONLY import: erased at runtime, so it creates no module cycle even though
   self-healing.ts imports this file's class at definition time. */
import type { SelfHealingOptions } from "./self-healing.js";

export const execAsync = bindPosixShell(promisify(exec));

/**
 * FNXC:Workspace 2026-08-15-04:42:
 * Evidence unavailable must never be laundered into proof that a branch is absent: the sole
 * consumer turns absence into an irreversible `status:"failed"` park. `git show-ref --verify
 * --quiet` exits 0 for present, 1 for absent, and 128 for a non-repository/ref-read failure;
 * only its clean numeric exit 1 is absence evidence. Spawn, timeout, signal, and malformed
 * errors are unknown so later sweeps can retry.
 */
export function classifyBranchProbeError(error: unknown): "absent" | "unknown" {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === 1 &&
    !(error as { killed?: unknown }).killed &&
    ((error as { signal?: unknown }).signal === null || (error as { signal?: unknown }).signal === undefined)
  ) {
    return "absent";
  }
  return "unknown";
}

export interface LandedTaskCommit {
  sha: string;
  subject?: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  rebaseBaseSha?: string;
}

/** Outcome of re-proving a stored `mergeDetails.commitSha` against the landed-commit provenance verdict. */
export type StoredLandedCommitAssessment =
  | { kind: "absent" }
  | { kind: "unreachable" }
  | { kind: "assessed"; sha: string; subject: string; verdict: LandedCommitProvenanceVerdict };

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function parseShortstat(output: string): Pick<LandedTaskCommit, "filesChanged" | "insertions" | "deletions"> {
  const normalized = output.trim().replace(/\n/g, " ");
  const filesMatch = normalized.match(/(\d+) files? changed/);
  const insertionsMatch = normalized.match(/(\d+) insertions?\(\+\)/);
  const deletionsMatch = normalized.match(/(\d+) deletions?\(-\)/);

  return {
    filesChanged: filesMatch ? Number.parseInt(filesMatch[1], 10) : 0,
    insertions: insertionsMatch ? Number.parseInt(insertionsMatch[1], 10) : 0,
    deletions: deletionsMatch ? Number.parseInt(deletionsMatch[1], 10) : 0,
  };
}

/**
 * Abstract base carrying the git-evidence readers. `SelfHealingManager` extends
 * it, so every call site stays `this.<method>(...)` and every body below is the
 * original text.
 */
export abstract class SelfHealingGitEvidence {
  protected abstract readonly options: SelfHealingOptions;


  /*
  FNXC:LandedCommitProvenance 2026-10-11-07:40:
  "Did this task land?" is answered only by a commit PROVEN to belong to the task (see `merge/landed-commit-provenance.ts`).
  A subject or trailer naming the ID is not enough on its own: recycled IDs make old commits match, and accepting one finalizes the card and lets cleanup delete the unmerged branch and worktree.
  Every candidate from every strategy and range goes through `assessLandedCommitProvenance`. A strategy whose candidates are all rejected falls through to the next candidate, then to the full-HEAD re-scan, then to the next strategy; when nothing is accepted the finder returns null and each caller's "not landed" branch runs.
  The legitimate fallbacks are preserved: squash with a rewritten subject (trailers), includeTaskIdInCommit=false (lineage trailer), and a baseCommitSha advanced past the landing (full-HEAD re-scan with the creation-time guard).
  */
  protected async findLandedTaskCommit(
    task: Task,
    options?: { preferEarliestOwnedCommit?: boolean },
  ): Promise<LandedTaskCommit | null> {
    // Search strategies, tried in order of reliability:
    //   1. mergeDetails.commitSha — already stored by the merger; verify it's
    //      reachable from HEAD and still provably owned before trusting it.
    //   2. Fusion-Task-Lineage trailer — canonical immutable lineage marker.
    //   3. Fusion-Task-Id trailer — legacy human task-id marker.
    //   4. Subject grep — legacy/AI commits where the task ID lives in the
    //      subject line (e.g. `feat(FN-123): …`).
    //
    // (1) gives us the right sha even if the commit subject is exotic; (2)
    // covers includeTaskIdInCommit=false setups where (3) would silently
    // miss; (3) catches commits authored before the trailer was introduced.
    const nowMs = Date.now();
    const rejected: string[] = [];
    const reportRejections = () => {
      if (rejected.length === 0) return;
      log.warn(
        `Landed-commit lookup for ${task.id} declined ${rejected.length} candidate(s) without ownership proof: ${rejected.slice(0, 5).join(", ")}`,
      );
    };
    const noteRejection = (sha: string, verdict: LandedCommitProvenanceVerdict) => {
      if (!verdict.accepted && (verdict.reason === "predates-task" || verdict.reason === "subject-only-outside-task-range")) {
        rejected.push(`${sha.slice(0, 8)} (${verdict.reason})`);
      }
    };

    // ── (1) Stored sha ────────────────────────────────────────────────────
    const rebaseBaseSha = task.mergeDetails?.rebaseBaseSha;
    const stored = await this.assessStoredLandedCommit(task, nowMs);
    if (stored.kind === "assessed") {
      if (stored.verdict.accepted) {
        const commit: LandedTaskCommit = { sha: stored.sha, subject: stored.subject, rebaseBaseSha };
        try {
          const shortstat = await this.readShortstatForSha(stored.sha, rebaseBaseSha);
          if (shortstat) {
            Object.assign(commit, shortstat);
          }
        } catch { /* stats are optional */ }
        reportRejections();
        return commit;
      }
      noteRejection(stored.sha, stored.verdict);
    }

    const readLog = async (range: string, grepArg: string, fixedStrings: boolean) => {
      const command = [
        "git log",
        "--format=%H%x1f%s%x1f%ct",
        "--max-count=20",
        ...(options?.preferEarliestOwnedCommit ? ["--reverse"] : []),
        ...(fixedStrings ? ["--fixed-strings"] : ["-E"]),
        `--grep=${grepArg}`,
        shellQuote(range),
      ].join(" ");

      return execAsync(command, {
        cwd: this.options.rootDir,
        maxBuffer: 1024 * 1024,
      });
    };

    // A verdict depends only on the commit, so a sha rejected under one
    // strategy or range is never re-evaluated under another.
    const evaluated = new Set<string>(stored.kind === "assessed" ? [stored.sha] : []);

    // FN-5441/FN-5446 regression: `git log --grep=FN-XXXX` matches the entire
    // commit message, including prose body mentions, so every candidate's body
    // is classified by the shared ownership anchor before the provenance verdict.
    const acceptFirstProven = async (stdout: string): Promise<{ sha: string; subject: string } | null> => {
      for (const line of stdout.trim().split("\n").filter(Boolean)) {
        const [candidateSha, candidateSubject = "", candidateTime] = line.split("\x1f");
        if (!candidateSha || evaluated.has(candidateSha)) continue;
        evaluated.add(candidateSha);
        try {
          const { stdout: bodyOut } = await execAsync(
            `git log -1 --format=%b ${shellQuote(candidateSha)}`,
            { cwd: this.options.rootDir, maxBuffer: 1024 * 1024 },
          );
          const verdict = await this.assessLandedCommitCandidate(task, {
            sha: candidateSha,
            subject: candidateSubject,
            body: bodyOut,
            commitTimeMs: parseCommitTimeSeconds(candidateTime),
            nowMs,
          });
          if (verdict.accepted) return { sha: candidateSha, subject: candidateSubject };
          noteRejection(candidateSha, verdict);
        } catch {
          // If we can't read the body, conservatively skip this candidate.
        }
      }
      return null;
    };

    // Search the bounded range first, then all of HEAD whenever the bounded
    // walk produced no accepted candidate: a baseCommitSha advanced past the
    // landing excludes it from the bounded range.
    const search = async (grepArg: string, fixedStrings: boolean): Promise<{ sha: string; subject: string } | null> => {
      const ranges = task.baseCommitSha ? [`${task.baseCommitSha}..HEAD`, "HEAD"] : ["HEAD"];
      for (const range of ranges) {
        let out: string;
        try {
          out = (await readLog(range, grepArg, fixedStrings)).stdout;
        } catch (err: unknown) {
          // A failing full-HEAD read after a bounded attempt is a real git failure; surface it as before.
          if (range === "HEAD" && task.baseCommitSha) throw err;
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.warn(
            `Failed to read git log for landed commit lookup (${task.id}): ${errorMessage} — retrying with HEAD range`,
          );
          continue;
        }
        const accepted = await acceptFirstProven(out);
        if (accepted) return accepted;
      }
      return null;
    };

    // (2) Canonical lineage trailer, (3) legacy task-id trailer, (4) subject grep.
    let found: { sha: string; subject: string } | null = null;
    if (task.lineageId) {
      found = await search(shellQuote(`^Fusion-Task-Lineage: ${task.lineageId}$`), false);
    }
    if (!found) {
      found = await search(shellQuote(`^Fusion-Task-Id: ${task.id}$`), false);
    }
    if (!found) {
      found = await search(shellQuote(task.id), true);
    }
    reportRejections();
    if (!found) return null;

    const { sha, subject } = found;
    const commit: LandedTaskCommit = { sha, subject, rebaseBaseSha };
    try {
      const shortstat = await this.readShortstatForSha(sha, rebaseBaseSha);
      if (shortstat) {
        Object.assign(commit, shortstat);
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn(
        `Failed to read shortstat for landed commit ${sha} (${task.id}): ${errorMessage} — continuing without stats`,
      );
      // Stats are useful for the task detail view but not required for recovery.
    }

    return commit;
  }

  /**
   * Re-prove the stored `mergeDetails.commitSha`: `unreachable` when it is not an
   * ancestor of HEAD (or unreadable), otherwise the provenance verdict.
   * `recoverDoneTaskMergeMetadata` uses this to clear a stored sha only when it is
   * positively disproven, not merely unprovable.
   */
  protected async assessStoredLandedCommit(task: Task, nowMs: number = Date.now()): Promise<StoredLandedCommitAssessment> {
    const storedSha = task.mergeDetails?.commitSha;
    if (!storedSha) return { kind: "absent" };
    let sha: string;
    let subject: string;
    let commitTime: string | undefined;
    let body: string;
    try {
      await execAsync(
        `git merge-base --is-ancestor ${shellQuote(storedSha)} HEAD`,
        { cwd: this.options.rootDir },
      );
      const { stdout } = await execAsync(
        `git log -1 --format=%H%x1f%s%x1f%ct%x1f%b ${shellQuote(storedSha)}`,
        { cwd: this.options.rootDir, maxBuffer: 1024 * 1024 },
      );
      const [resolvedSha = "", resolvedSubject = "", resolvedTime, ...bodyParts] = stdout.trim().split("\x1f");
      sha = resolvedSha;
      subject = resolvedSubject;
      commitTime = resolvedTime;
      body = bodyParts.join("\x1f");
    } catch {
      // Not reachable (rebased away, branch reset, etc.).
      return { kind: "unreachable" };
    }
    if (!sha) return { kind: "unreachable" };
    const verdict = await this.assessLandedCommitCandidate(task, {
      sha,
      subject,
      body,
      commitTimeMs: parseCommitTimeSeconds(commitTime),
      nowMs,
    });
    return { kind: "assessed", sha, subject, verdict };
  }

  /** Classify ownership, then probe scope and task-branch membership only as far as the verdict needs. */
  protected async assessLandedCommitCandidate(
    task: Task,
    candidate: { sha: string; subject: string; body: string; commitTimeMs?: number; nowMs: number },
  ): Promise<LandedCommitProvenanceVerdict> {
    const ownership = getCommitTaskOwnership(task.id, task.lineageId, candidate.subject, candidate.body);
    const input = {
      ownership,
      scope: "unbounded" as LandedCommitScope,
      commitTimeMs: candidate.commitTimeMs,
      taskCreatedAt: task.createdAt,
      taskLineageId: task.lineageId,
      nowMs: candidate.nowMs,
    };
    if (ownership.owned) {
      input.scope = await this.landedCommitScope(candidate.sha, task.baseCommitSha);
    }
    return resolveLandedCommitProvenance(input, () => this.isCommitOnTaskBranch(candidate.sha, task));
  }

  /** `bounded` only when the commit strictly descends from the task's recorded base. */
  protected async landedCommitScope(sha: string, baseCommitSha: string | undefined): Promise<LandedCommitScope> {
    if (!baseCommitSha) return "unbounded";
    const isAncestor = async (ancestor: string, descendant: string) => {
      try {
        await execAsync(
          `git merge-base --is-ancestor ${shellQuote(ancestor)} ${shellQuote(descendant)}`,
          { cwd: this.options.rootDir },
        );
        return true;
      } catch {
        return false;
      }
    };
    if (!(await isAncestor(baseCommitSha, sha))) return "unbounded";
    return (await isAncestor(sha, baseCommitSha)) ? "unbounded" : "bounded";
  }

  /** Whether the commit is in the history of the task's own working branch (which must still exist). */
  protected async isCommitOnTaskBranch(sha: string, task: Task): Promise<boolean> {
    const branchRef = `refs/heads/${resolveTaskWorkingBranch(task)}`;
    try {
      await execAsync(`git rev-parse --verify --quiet ${shellQuote(branchRef)}`, { cwd: this.options.rootDir });
      await execAsync(
        `git merge-base --is-ancestor ${shellQuote(sha)} ${shellQuote(branchRef)}`,
        { cwd: this.options.rootDir },
      );
      return true;
    } catch {
      return false;
    }
  }

  protected async findAlreadyMergedTaskCommit(input: {
    taskId: string;
    lineageId?: string;
    repoDir: string;
    baseBranch: string;
    taskBranch?: string;
    baseCommitSha?: string;
  }) {
    return findAlreadyMergedTaskCommit(input);
  }

  protected async refreshRemoteBaseRef(baseBranch: string): Promise<string | null> {
    // Already a remote ref — nothing local to refresh.
    if (baseBranch.startsWith("origin/")) return null;
    const remoteRef = `origin/${baseBranch}`;
    try {
      await execAsync(`git fetch origin ${shellQuote(baseBranch)}`, {
        cwd: this.options.rootDir,
        timeout: 60_000,
      });
    } catch {
      // Swallow: fall through to the existing remote-tracking ref if present.
    }
    try {
      await execAsync(`git rev-parse --verify ${shellQuote(remoteRef)}`, {
        cwd: this.options.rootDir,
        timeout: 30_000,
      });
      return remoteRef;
    } catch {
      return null;
    }
  }

  protected async readCommitTaskOwnership(sha: string, taskId: string, lineageId?: string) {
    const { stdout } = await execAsync(`git show -s --format=%s%x1f%b ${shellQuote(sha)}`, {
      cwd: this.options.rootDir,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const [subject = "", body = ""] = stdout.split("\x1f");
    return getCommitTaskOwnership(taskId, lineageId, subject, body);
  }

  protected async branchHasNoUniqueDiff(branchTip: string, baseBranch: string): Promise<boolean> {
    const { stdout: mergeBaseStdout } = await execAsync(`git merge-base ${shellQuote(branchTip)} ${shellQuote(baseBranch)}`, {
      cwd: this.options.rootDir,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const mergeBase = mergeBaseStdout.trim();
    if (!mergeBase) return false;

    await execAsync(`git diff --quiet ${shellQuote(mergeBase)}..${shellQuote(branchTip)}`, {
      cwd: this.options.rootDir,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return true;
  }

  protected async baseHasExplicitTaskOwnership(taskId: string, lineageId: string | undefined, baseBranch: string): Promise<boolean> {
    const patterns = lineageId
      ? [`^Fusion-Task-Lineage: ${escapeRegex(lineageId)}$`, `^Fusion-Task-Id: ${escapeRegex(taskId)}$`]
      : [`^Fusion-Task-Id: ${escapeRegex(taskId)}$`];
    for (const pattern of patterns) {
      const { stdout } = await execAsync(`git log --grep=${shellQuote(pattern)} -E --max-count=1 --format=%H ${shellQuote(baseBranch)}`, {
        cwd: this.options.rootDir,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      if (stdout.trim()) return true;
    }
    return false;
  }

  protected async foreignTipRejection(input: {
    taskId: string;
    lineageId?: string;
    branchTip: string;
    baseBranch: string;
    ownership: Awaited<ReturnType<SelfHealingGitEvidence["readCommitTaskOwnership"]>>;
  }): Promise<{ reason: "foreign-task-tip" | "foreign-lineage-tip"; owner?: string } | null> {
    const { taskId, lineageId, branchTip, baseBranch, ownership } = input;
    if (ownership.rejectionReason !== "foreign-task" && ownership.rejectionReason !== "foreign-lineage") return null;

    const hasNoUniqueDiff = await this.branchHasNoUniqueDiff(branchTip, baseBranch).catch(() => false);
    const baseAlreadyHasCurrentTask = hasNoUniqueDiff
      ? await this.baseHasExplicitTaskOwnership(taskId, lineageId, baseBranch).catch(() => false)
      : false;
    if (hasNoUniqueDiff && !baseAlreadyHasCurrentTask) return null;

    return ownership.rejectionReason === "foreign-task"
      ? { reason: "foreign-task-tip", owner: ownership.ownerTaskId }
      : { reason: "foreign-lineage-tip", owner: ownership.ownerLineageId };
  }

  protected async branchTipForeignOwnership(input: {
    taskId: string;
    lineageId?: string;
    branch: string;
    baseBranch: string;
  }): Promise<{ sha: string; owner?: string; reason: "foreign-task-tip" | "foreign-lineage-tip" | "ownership-unverifiable" } | null> {
    const { taskId, lineageId, branch, baseBranch } = input;
    let stdout = "";
    try {
      ({ stdout } = await execAsync(`git rev-parse ${shellQuote(branch)}`, {
        cwd: this.options.rootDir,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      }));
    } catch {
      return { sha: "unverified", reason: "ownership-unverifiable" };
    }
    const sha = stdout.trim();
    if (!sha) return null;
    let ownership: Awaited<ReturnType<SelfHealingGitEvidence["readCommitTaskOwnership"]>>;
    try {
      ownership = await this.readCommitTaskOwnership(sha, taskId, lineageId);
    } catch {
      return { sha, reason: "ownership-unverifiable" };
    }
    /*
    FNXC:WorkflowRecovery 2026-07-03-21:35:
    Already-merged recovery must classify no-diff task branches before enforcing branch-tip trailers. A branch created from main can point at a previous task's landed commit and later sit behind main after unrelated commits; reject foreign trailers only when merge-base-to-tip diff proof shows the branch contains real task-branch content.

    FNXC:WorkflowRecovery 2026-07-25-09:40:
    That diff-proof classification now lives in `foreignTipRejection` so this path, branch-misbound recovery, and the reclaim sweep cannot drift apart again.
    */
    const rejection = await this.foreignTipRejection({ taskId, lineageId, branchTip: sha, baseBranch, ownership });
    if (rejection) return { sha, owner: rejection.owner, reason: rejection.reason };
    return null;
  }

  protected async isCommitReachableFromBranch(commitSha: string | undefined, branch: string): Promise<boolean> {
    if (!commitSha) return true;
    try {
      await execAsync(`git merge-base --is-ancestor ${shellQuote(commitSha)} ${shellQuote(branch)}`, {
        cwd: this.options.rootDir,
      });
      return true;
    } catch {
      return false;
    }
  }

  protected async findWorktreePathForBranch(branchName: string): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync("git worktree list --porcelain", {
        cwd: this.options.rootDir,
        timeout: 30_000,
      });
      const lines = stdout.split("\n");
      let currentWorktree: string | undefined;
      let currentBranch: string | undefined;
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          if (currentWorktree && currentBranch === branchName) return currentWorktree;
          currentWorktree = undefined;
          currentBranch = undefined;
          continue;
        }
        if (line.startsWith("worktree ")) {
          currentWorktree = line.slice("worktree ".length).trim();
          continue;
        }
        if (line.startsWith("branch refs/heads/")) {
          currentBranch = line.slice("branch refs/heads/".length).trim();
        }
      }
      if (currentWorktree && currentBranch === branchName) return currentWorktree;
      return undefined;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn(`[self-healing] reconcileCompletedTask: failed to read worktree list for ${branchName}: ${errorMessage}`);
      return undefined;
    }
  }

  /**
   * FNXC:Workspace 2026-08-15-04:42:
   * `show-ref --verify --quiet` distinguishes present (0), absent (clean 1), and unreadable
   * repository evidence (128/error), unlike `rev-parse --verify`, which returns 128 for both a
   * missing ref and a non-repository cwd. The irreversible partial-land park may consume only
   * absence proof; all other errors remain unknown for a later sweep.
   */
  protected async probeRepoBranch(repoRootDir: string, branch: string): Promise<"present" | "absent" | "unknown"> {
    try {
      await this.execBranchProbe(repoRootDir, branch);
      return "present";
    } catch (err: unknown) {
      const outcome = classifyBranchProbeError(err);
      if (outcome === "unknown") {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.warn(`[self-healing] branch evidence unavailable for ${repoRootDir} (${branch}): ${errorMessage}`);
      }
      return outcome;
    }
  }

  /**
   * FNXC:Workspace 2026-08-15-04:42:
   * This protected seam sits below the real probe classifier so fixture tests can inject timeout
   * and spawn-error shapes without mocking module-local `execAsync`. It deliberately has no
   * catch: `probeRepoBranch` maps only a clean show-ref exit 1 to absence evidence.
   */
  protected async execBranchProbe(repoRootDir: string, branch: string): Promise<void> {
    await execAsync(`git show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}`, {
      cwd: repoRootDir,
      timeout: 30_000,
    });
  }

  protected async readShortstatForSha(
    sha: string,
    rebaseBaseSha?: string,
  ): Promise<{ filesChanged: number; insertions: number; deletions: number } | null> {
    try {
      const command = rebaseBaseSha
        ? `git diff --shortstat ${shellQuote(`${rebaseBaseSha}..${sha}`)}`
        : `git show --shortstat --format= ${shellQuote(sha)}`;
      const stats = await execAsync(command, {
        cwd: this.options.rootDir,
        maxBuffer: 1024 * 1024,
      });
      const parsed = parseShortstat(stats.stdout);
      return {
        filesChanged: parsed.filesChanged ?? 0,
        insertions: parsed.insertions ?? 0,
        deletions: parsed.deletions ?? 0,
      };
    } catch {
      return null;
    }
  }

  protected async readLandedFilesForSha(sha: string, rebaseBaseSha?: string): Promise<string[] | null> {
    try {
      const command = rebaseBaseSha
        ? `git diff --name-only ${shellQuote(`${rebaseBaseSha}..${sha}`)}`
        : `git show --name-only --format= ${shellQuote(sha)}`;
      const result = await execAsync(command, {
        cwd: this.options.rootDir,
        maxBuffer: 1024 * 1024,
      });
      const files = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      return files.length > 0 ? Array.from(new Set(files)) : [];
    } catch {
      return null;
    }
  }

  /**
   * FNXC:LandedReviewReconciliation 2026-09-20-02:17:
   * A still-present branch is safe to reconcile only after proving it contributes
   * no task-owned commit beyond the target. This preserves the branch-presence
   * recovery path without mistaking an externally merged prefix for all work.
   */
  protected async hasUnlandedTaskOwnedContent(input: {
    branch: string;
    baseBranch: string;
    taskId: string;
    lineageId?: string;
  }): Promise<boolean> {
    /*
    FNXC:LandedReviewReconciliation 2026-09-20-02:40:
    An external squash retains the original task commits in `base..branch`, even
    though the aggregate branch tree is already on the target. Check aggregate
    content first; a later task-owned suffix makes this diff non-empty and still
    reaches the trailer scan below, preserving the unlanded-work refusal.
    */
    try {
      await execAsync(
        `git diff --quiet ${shellQuote(`${input.baseBranch}..${input.branch}`)}`,
        { cwd: this.options.rootDir, timeout: 30_000, maxBuffer: 1024 * 1024 },
      );
      return false;
    } catch {
      // A non-zero diff is expected for a branch with remaining content; inspect ownership below.
    }

    const { stdout } = await execAsync(
      `git log --format=%H ${shellQuote(`${input.baseBranch}..${input.branch}`)}`,
      { cwd: this.options.rootDir, timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    for (const sha of stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      const ownership = await this.readCommitTaskOwnership(sha, input.taskId, input.lineageId);
      if (ownership.ownerTaskId === input.taskId || (input.lineageId && ownership.ownerLineageId === input.lineageId)) {
        return true;
      }
    }
    return false;
  }

  protected async isBranchTipMisboundToTask(input: {
    branch: string;
    taskId: string;
    lineageId?: string;
    baseBranch: string;
  }): Promise<{ misbound: boolean; branchMissing: boolean; branchTip: string; landed: Awaited<ReturnType<typeof findAlreadyMergedTaskCommit>>; rejection?: { reason: "foreign-task-tip" | "foreign-lineage-tip"; owner?: string } }> {
    const { branch, taskId, lineageId, baseBranch } = input;
    let tipOut = "";
    try {
      ({ stdout: tipOut } = await execAsync(`git rev-parse ${shellQuote(branch)}`, {
        cwd: this.options.rootDir,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missingRevision = /unknown revision|ambiguous argument|Needed a single revision/i.test(message);
      if (classifyBranchProbeError(error) !== "absent" && !missingRevision) throw error;
      /*
      FNXC:WorkflowRecovery 2026-09-17-06:00 (FN-9304):
      A branch removed after its merge is an expected steady state, not a git failure. Classify it
      as `branchMissing` and still inspect base-branch trailers for ownership-anchored landed
      content — a deleted tip has no ref to read ancestry from, but the base branch's own commit
      trailers are proof regardless of what happened to the source branch.
      */
      const landed = await this.findAlreadyMergedTaskCommit({
        taskId,
        lineageId,
        repoDir: this.options.rootDir,
        baseBranch,
        taskBranch: branch,
      });
      return { misbound: false, branchMissing: true, branchTip: "", landed };
    }
    const branchTip = tipOut.trim();
    const ownership = await this.readCommitTaskOwnership(branchTip, taskId, lineageId);
    /*
    FNXC:WorkflowRecovery 2026-07-03-21:39:
    Branch-misbound recovery shares the no-op inheritance edge case with already-merged recovery. Check merge-base-to-tip diff state first so a branch with no unique task content is not mislabeled misbound solely because its inherited tip belongs to the previously landed task, even after base advances.

    FNXC:WorkflowRecovery 2026-07-25-09:40:
    Shared with already-merged recovery and the reclaim sweep via `foreignTipRejection`.
    */
    const rejection = await this.foreignTipRejection({ taskId, lineageId, branchTip, baseBranch, ownership });
    if (rejection) {
      return { misbound: false, branchMissing: false, branchTip, landed: null, rejection };
    }
    const hasTaskId = ownership.ownerTaskId === taskId;
    const hasLineage = lineageId ? ownership.ownerLineageId === lineageId : false;
    const landed = await this.findAlreadyMergedTaskCommit({
      taskId,
      lineageId,
      repoDir: this.options.rootDir,
      baseBranch,
      taskBranch: branch,
    });
    return { misbound: !hasTaskId && !hasLineage, branchMissing: false, branchTip, landed };
  }
}
