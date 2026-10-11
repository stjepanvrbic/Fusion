import { exec, execFile } from "node:child_process";
import { bindPosixShell } from "@fusion/core";

import { canonicalFusionBranchName, resolveTaskWorkingBranch } from "../worktree/worktree-names.js";

/*
FNXC:AlreadyLandedDetection 2026-10-11-08:40:
Single git commands run without a shell, through `execFile("git", argv)`.
On Windows every Git Bash launch is two extra processes (`Git\bin\bash.exe`, then `usr\bin\bash.exe`), which made shell launches the largest cost of one detection; argv also removes the shell-quoting layer.
Only the two `… | git patch-id` pipelines need a shell, and they keep the POSIX-shell seam.
Both runners take node's callback form, so a passthrough mock of `node:child_process` observes the same calls production makes.
*/
const execPosixShell = bindPosixShell(exec);

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 1024 * 1024;

/** Runs one git command without a shell; resolves its stdout and rejects on a non-zero exit, timeout or spawn failure. */
function runGit(repoDir: string, args: readonly string[], maxBuffer = GIT_MAX_BUFFER): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: repoDir, timeout: GIT_TIMEOUT_MS, maxBuffer, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/** Runs a `… | git patch-id` pipeline under the POSIX shell. */
function runPatchIdPipeline(repoDir: string, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execPosixShell(command, { cwd: repoDir, timeout: 60_000, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export type AlreadyMergedDetectionStrategy = "trailer" | "ancestry" | "patch-id" | "tree-equal" | "no-diff";

export interface AlreadyMergedLookupInput {
  taskId: string;
  lineageId?: string;
  repoDir: string;
  baseBranch: string;
  taskBranch?: string;
  baseCommitSha?: string;
}

export type AlreadyMergedOwnershipProof =
  | "task-trailer"
  | "lineage-trailer"
  | "subject-anchor"
  | "canonical-branch-patch"
  | "canonical-branch-tree"
  | "canonical-branch-no-diff";

export interface AlreadyMergedLookupResult {
  sha: string;
  strategy: AlreadyMergedDetectionStrategy;
  ownershipProof?: AlreadyMergedOwnershipProof;
}

export interface CommitTaskOwnership {
  owned: boolean;
  proof?: Extract<AlreadyMergedOwnershipProof, "task-trailer" | "lineage-trailer" | "subject-anchor">;
  ownerTaskId?: string;
  ownerLineageId?: string;
  rejectionReason?: "foreign-task" | "foreign-lineage";
}

interface DetectAlreadyLandedInput {
  rootDir: string;
  taskId: string;
  lineageId?: string;
  baseBranch: string;
  taskBranch?: string;
  baseCommitSha?: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstTrailerValue(body: string, trailer: "Fusion-Task-Id" | "Fusion-Task-Lineage"): string | undefined {
  const match = body.match(new RegExp(`(?:^|\\n)${trailer}:\\s*([^\\n]+?)\\s*(?:\\n|$)`));
  return match?.[1]?.trim();
}

/**
 * Ownership anchor shared with self-healing's already-merged recovery guards.
 *
 * The 2026-05-23 lost-work incident (bug #2) was a `git log --grep=<taskId>`
 * first-hit attribution: a commit whose body merely *mentioned* a task ID in
 * prose was accepted as that task's landed commit, stranding/mis-attributing
 * the real work. The FN-7143/FN-7187 incident added the inverse guard: explicit
 * foreign Fusion trailers are rejection evidence even when a stale branch tip,
 * patch-id, or tree-equality fallback otherwise appears to match.
 */
export function getCommitTaskOwnership(
  taskId: string,
  lineageId: string | undefined,
  subject: string,
  body: string,
): CommitTaskOwnership {
  const ownerTaskId = firstTrailerValue(body, "Fusion-Task-Id");
  const ownerLineageId = firstTrailerValue(body, "Fusion-Task-Lineage");
  if (ownerTaskId && ownerTaskId !== taskId) {
    return { owned: false, ownerTaskId, ownerLineageId, rejectionReason: "foreign-task" };
  }
  if (lineageId && ownerLineageId && ownerLineageId !== lineageId) {
    return { owned: false, ownerTaskId, ownerLineageId, rejectionReason: "foreign-lineage" };
  }
  if (ownerTaskId === taskId) {
    return { owned: true, proof: "task-trailer", ownerTaskId, ownerLineageId };
  }
  if (lineageId && ownerLineageId === lineageId) {
    return { owned: true, proof: "lineage-trailer", ownerTaskId, ownerLineageId };
  }
  // Subject anchor MUST mention the task ID — either inside a conventional
  // scope (`<type>(<…taskId…>): …`) or as a leading `<taskId>: …`. The scope
  // group is intentionally NOT optional here: a bare `feat: …` with no task ID
  // is NOT ownership evidence (a prose commit such as `feat: unrelated change`
  // whose body merely mentions the task must be rejected — incident bug #2).
  const subjectAnchor = new RegExp(
    `^(?:[A-Za-z]+\\([^)]*\\b${escapeRegex(taskId)}\\b[^)]*\\):|${escapeRegex(taskId)}:)`,
  );
  if (subjectAnchor.test(subject)) {
    return { owned: true, proof: "subject-anchor", ownerTaskId, ownerLineageId };
  }
  return { owned: false, ownerTaskId, ownerLineageId };
}

async function commitHasForeignTaskOwnership(
  repoDir: string,
  sha: string,
  taskId: string,
  lineageId: string | undefined,
): Promise<boolean> {
  const stdout = await runGit(repoDir, ["show", "-s", "--format=%s%x1f%b", sha]);
  const [subject = "", body = ""] = stdout.split("\x1f");
  const ownership = getCommitTaskOwnership(taskId, lineageId, subject, body);
  return ownership.rejectionReason === "foreign-task" || ownership.rejectionReason === "foreign-lineage";
}

async function branchHasNoUniqueDiff(
  repoDir: string,
  branchTip: string,
  mergeBaseOf: (tip: string) => Promise<string>,
): Promise<boolean> {
  const mergeBase = await mergeBaseOf(branchTip);
  if (!mergeBase) return false;

  await runGit(repoDir, ["diff", "--quiet", `${mergeBase}..${branchTip}`]);
  return true;
}

export async function findAlreadyMergedTaskCommit(
  input: AlreadyMergedLookupInput,
): Promise<AlreadyMergedLookupResult | null> {
  const { taskId, lineageId, repoDir, baseBranch, taskBranch, baseCommitSha } = input;
  // One merge-base computation per tip and detection: the no-unique-diff proof and the patch-id step need the same value.
  const mergeBases = new Map<string, Promise<string>>();
  const mergeBaseOf = (tip: string): Promise<string> => {
    let mergeBase = mergeBases.get(tip);
    if (!mergeBase) {
      mergeBase = runGit(repoDir, ["merge-base", tip, baseBranch]).then((stdout) => stdout.trim());
      mergeBases.set(tip, mergeBase);
    }
    return mergeBase;
  };

  try {
    if (lineageId) {
      const lineagePattern = `^Fusion-Task-Lineage: ${escapeRegex(lineageId)}$`;
      const lineage = await runGit(repoDir, ["log", `--grep=${lineagePattern}`, "-E", "--max-count=1", "--format=%H", baseBranch]);
      const lineageSha = lineage.trim();
      if (lineageSha) {
        return { sha: lineageSha, strategy: "trailer", ownershipProof: "lineage-trailer" };
      }
    }

    const trailerPattern = `^Fusion-Task-Id: ${escapeRegex(taskId)}$`;
    const stdout = await runGit(repoDir, ["log", `--grep=${trailerPattern}`, "-E", "--max-count=1", "--format=%H", baseBranch]);
    const sha = stdout.trim();
    if (sha) {
      return { sha, strategy: "trailer", ownershipProof: "task-trailer" };
    }
  } catch {
    // Fall through to ancestry/patch-id checks.
  }

  let branchTip: string | null = null;
  const branchName = resolveTaskWorkingBranch({ id: taskId, branch: taskBranch });
  const canonicalBranchName = canonicalFusionBranchName(taskId);
  /*
  FNXC:WorkflowRecovery 2026-06-28-21:36:
  FN-7143/FN-7187 proved patch-id and tree-equal fallbacks need branch identity proof, not just content equivalence. Only the canonical task branch may imply ownership for fallback matches, and any explicit foreign Fusion trailer on the branch tip or candidate commit rejects the recovery.
  */
  const hasCanonicalBranchIdentity = branchName === canonicalBranchName;
  let branchTipOwnershipVerified = false;
  let branchTipHasNoUniqueDiff = false;
  let branchTipForeignNoDiff = false;
  try {
    branchTip = (await runGit(repoDir, ["rev-parse", "--verify", branchName])).trim();
    if (hasCanonicalBranchIdentity) {
      branchTipHasNoUniqueDiff = await branchHasNoUniqueDiff(repoDir, branchTip, mergeBaseOf).catch(() => false);
    }
    /*
    FNXC:WorkflowRecovery 2026-07-03-21:31:
    A new no-op task branch can inherit the current main tip and therefore a previous task's Fusion trailer. Prove the branch has no unique diff from its merge-base before applying the FN-7143/FN-7187 foreign-tip guard; the base branch may have advanced since the no-op branch was created, so current base-tree equality is not part of ownership classification.
    */
    const branchTipHasForeignOwnership = await commitHasForeignTaskOwnership(repoDir, branchTip, taskId, lineageId);
    if (!branchTipHasNoUniqueDiff && branchTipHasForeignOwnership) {
      return null;
    }
    branchTipForeignNoDiff = branchTipHasNoUniqueDiff && branchTipHasForeignOwnership;
    branchTipOwnershipVerified = true;

    await runGit(repoDir, ["merge-base", "--is-ancestor", branchTip, baseBranch]);
    if (branchTipForeignNoDiff) {
      return { sha: branchTip, strategy: "no-diff", ownershipProof: "canonical-branch-no-diff" };
    }

    // FN-5441/5446 (2026-05-23 lost-work bug #2): `--grep=<taskId>` is a loose
    // match that also hits commits merely mentioning the task ID in prose.
    // Gather candidates (bounded) and accept only the first whose subject/body
    // is OWNERSHIP-anchored on the task — never the first raw grep hit.
    const stdout = await runGit(
      repoDir,
      ["log", "--first-parent", "-E", "--format=%H%x1f%s%x1f%b%x1e", `--grep=${escapeRegex(taskId)}`, "--max-count=20", baseBranch],
      4 * 1024 * 1024,
    );
    const records = stdout
      .split("\x1e")
      .map((record) => record.trim())
      .filter((record) => record.length > 0);
    for (const record of records) {
      const [candidateSha, candidateSubject = "", candidateBody = ""] = record.split("\x1f");
      const sha = candidateSha?.trim();
      const ownership = getCommitTaskOwnership(taskId, lineageId, candidateSubject, candidateBody);
      if (sha && ownership.owned) {
        return { sha, strategy: "ancestry", ownershipProof: ownership.proof };
      }
    }
  } catch {
    // Fall through to patch-id checks.
  }

  try {
    if (!hasCanonicalBranchIdentity) {
      return null;
    }
    if (!branchTip || !branchTipOwnershipVerified) {
      branchTip = (await runGit(repoDir, ["rev-parse", "--verify", branchName])).trim();
      if (hasCanonicalBranchIdentity) {
        branchTipHasNoUniqueDiff = await branchHasNoUniqueDiff(repoDir, branchTip, mergeBaseOf).catch(() => false);
      }
      const branchTipHasForeignOwnership = await commitHasForeignTaskOwnership(repoDir, branchTip, taskId, lineageId);
      if (!branchTipHasNoUniqueDiff && branchTipHasForeignOwnership) {
        return null;
      }
      branchTipForeignNoDiff = branchTipHasNoUniqueDiff && branchTipHasForeignOwnership;
      branchTipOwnershipVerified = true;
    }

    let branchBase = baseCommitSha?.trim();
    if (!branchBase) {
      branchBase = await mergeBaseOf(branchTip);
    }

    if (!branchBase) {
      return null;
    }

    const branchPatchIdCommand = `git diff ${shellQuote(branchBase)}..${shellQuote(branchTip)} | git patch-id`;
    const branchPatchIdOut = await runPatchIdPipeline(repoDir, branchPatchIdCommand);
    const branchPatchIdLine = branchPatchIdOut
      .trim()
      .split("\n")
      .find((line) => line.trim().length > 0);
    const branchPatchId = branchPatchIdLine?.trim().split(/\s+/)[0];
    if (branchPatchId) {
      const basePatchMapCommand = `git log -n 200 -p --format='%H' ${shellQuote(baseBranch)} | git patch-id`;
      const basePatchIdsOut = await runPatchIdPipeline(repoDir, basePatchMapCommand);

      const basePatchMap = new Map<string, string>();
      for (const line of basePatchIdsOut.split("\n")) {
        const [patchId, sha] = line.trim().split(/\s+/);
        if (!patchId || !sha) continue;
        basePatchMap.set(patchId, sha);
      }

      const matchedSha = basePatchMap.get(branchPatchId);
      if (matchedSha && !await commitHasForeignTaskOwnership(repoDir, matchedSha, taskId, lineageId)) {
        return { sha: matchedSha, strategy: "patch-id", ownershipProof: "canonical-branch-patch" };
      }
    }
  } catch {
    // Fall through to null when patch-id detection fails.
  }

  try {
    const treeBranchName = resolveTaskWorkingBranch({ id: taskId, branch: taskBranch });
    if (treeBranchName !== canonicalBranchName) {
      return null;
    }
    await runGit(repoDir, ["rev-parse", "--verify", treeBranchName]);

    const baseTreeStdout = await runGit(repoDir, ["rev-parse", `${baseBranch}^{tree}`]);
    const branchTreeStdout = await runGit(repoDir, ["rev-parse", `${treeBranchName}^{tree}`]);

    const baseTree = baseTreeStdout.trim();
    const branchTree = branchTreeStdout.trim();
    if (baseTree && branchTree && baseTree === branchTree) {
      const baseHeadStdout = await runGit(repoDir, ["rev-parse", baseBranch]);
      const baseHead = baseHeadStdout.trim();
      if (baseHead && (branchTipForeignNoDiff || !await commitHasForeignTaskOwnership(repoDir, baseHead, taskId, lineageId))) {
        return { sha: baseHead, strategy: "tree-equal", ownershipProof: "canonical-branch-tree" };
      }
    }
  } catch {
    // Fall through to null when tree-equality detection fails.
  }

  return null;
}

export async function detectAlreadyLandedOnMain(
  input: DetectAlreadyLandedInput,
): Promise<AlreadyMergedLookupResult | null> {
  return findAlreadyMergedTaskCommit({
    taskId: input.taskId,
    lineageId: input.lineageId,
    repoDir: input.rootDir,
    baseBranch: input.baseBranch,
    taskBranch: input.taskBranch,
    baseCommitSha: input.baseCommitSha,
  });
}
