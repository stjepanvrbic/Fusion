import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Task, TaskStore } from "@fusion/core";
import { resolveRepoDeclaredScope } from "../worktree/workspace-paths.js";
import { createCommitRangeFilesReader, enforceSquashFileScopeInvariant, FileScopeViolationError, readMechanicalSquashFiles } from "./merger-file-scope.js";
import type { RunAuditor } from "../util/run-audit.js";

const execFileAsync = promisify(execFile);

export function resolveRepoDeclaredScopeTransform({ repoRel, repoKeys }: { repoRel: string; repoKeys: readonly string[] }) {
  return {
    transform(scope: string[]): string[] {
      return resolveRepoDeclaredScope(scope, repoRel, repoKeys).scope;
    },
    describe(scope: string[]): "repo-subset" | "unprefixed-fallback" | "foreign-repo-only" {
      return resolveRepoDeclaredScope(scope, repoRel, repoKeys).source;
    },
  };
}

/**
 * FNXC:FileScopeInvariant 2026-10-08-08:58:
 * KB-058: the pre-review and post-review checks must evaluate the same repo-local scope.
 * One builder owns the workspace transform and foreign-repo-only forced violation so the two cannot drift.
 */
function buildRepoScopeOptions(params: { repoRel?: string; repoKeys?: readonly string[] }): {
  scopeTransform?: (scope: string[]) => string[];
  forceViolation?: (resolvedScope: string[]) => boolean;
} {
  if (!params.repoRel) return {};
  const resolver = resolveRepoDeclaredScopeTransform({ repoRel: params.repoRel, repoKeys: params.repoKeys ?? [] });
  return {
    scopeTransform: (scope) => resolver.transform(scope),
    // FNXC:AIMerge 2026-08-15-05:50:
    // A foreign-only workspace declaration is an invariant violation, not an
    // empty scope: repo-b/`repo-a/feature.txt` must not borrow repo-a's scope.
    forceViolation: (scope) => resolver.describe(scope) === "foreign-repo-only",
  };
}

/**
 * FNXC:FileScopeInvariant 2026-10-08-08:58:
 * KB-058: a genuinely out-of-scope squash used to pay a full clean room, dependency install, merge agent, and reviewer
 * cycle (three cycles for KB-008) before the post-review check parked it. This pre-review check runs on the branch's
 * mechanical squash file list before any of that is spent and throws the identical `FileScopeViolationError`, so the
 * existing terminal park, graph mapping, workspace landFailure, and orphan-only recovery handle it unchanged.
 * It is an early exit only: `enforceAiMergeSquashGates` remains the invariant of record on the approved squash.
 * Fail open: an unavailable (`null`) or empty file list defers to the post-review check / empty-land path.
 * There is no clean room to reset; the reconciliation record is still dropped because a refusal is a verdict on the candidate.
 */
export async function preflightAiMergeSquashFileScope(params: {
  store: TaskStore;
  task: Task;
  taskId: string;
  repoRootDir: string;
  branch: string;
  tipSha: string;
  audit: RunAuditor;
  log: (message: string) => Promise<void>;
  repoRel?: string;
  repoKeys?: readonly string[];
  /** Test seam; production uses the real-git mechanical merge result. */
  squashFilesReader?: (repoRoot: string, tipSha: string, branch: string) => Promise<string[] | null>;
}): Promise<void> {
  const reader = params.squashFilesReader ?? readMechanicalSquashFiles;
  const files = await reader(params.repoRootDir, params.tipSha, params.branch);
  if (files === null) {
    await params.log("AI merge: pre-review file-scope check skipped — squash file list unavailable; the post-review check decides");
    return;
  }
  if (files.length === 0) return;
  try {
    await enforceSquashFileScopeInvariant({
      store: params.store,
      taskId: params.taskId,
      rootDir: params.repoRootDir,
      task: params.task,
      resetLabel: "ai-merge pre-review file-scope check",
      auditor: params.audit,
      stagedFilesReader: async () => files,
      phase: "pre-review",
      ...buildRepoScopeOptions(params),
    });
  } catch (error) {
    if (!(error instanceof FileScopeViolationError)) {
      // An early exit must not add failure modes: any other error defers to the post-review invariant of record.
      await params.log(`AI merge: pre-review file-scope check skipped \u2014 ${error instanceof Error ? error.message : String(error)}; the post-review check decides`);
      return;
    }
    await params.log(`AI merge: pre-review file-scope check refused the squash before any merge or review session: ${error.message}`);
    try {
      await params.store.updateTask(params.taskId, { aiMergeReviewReconciliation: null });
    } catch {
      // Best effort: the violation is the caller's answer and must not be masked by a store failure.
    }
    throw error;
  }
}

/*
FNXC:AIMerge 2026-08-16-05:28:
The pre-land diff-volume shrinkage gate (checkDiffVolume + merge:diff-volume-blocked audit)
was removed by operator decision: it blocked approved clean-room squashes whose review had
already accepted the diff, with no override path. File scope is the sole pre-land guard now;
the post-squash audit policy remains the shrinkage backstop.
*/
/** Apply the file-scope pre-land guard to the approved clean-room squash. */
export async function enforceAiMergeSquashGates(params: { store: TaskStore; task: Task; taskId: string; mergeRoot: string; branch: string; tipSha: string; squashSha: string; audit: RunAuditor; log: (message: string) => Promise<void>; repoRel?: string; repoKeys?: readonly string[] }): Promise<void> {
  try {
    await enforceSquashFileScopeInvariant({
      store: params.store,
      taskId: params.taskId,
      rootDir: params.mergeRoot,
      task: params.task,
      resetLabel: "ai-merge file-scope invariant violation",
      auditor: params.audit,
      stagedFilesReader: createCommitRangeFilesReader(params.tipSha, params.squashSha),
      ...buildRepoScopeOptions(params),
    });
  } catch (error) {
    if (!(error instanceof FileScopeViolationError)) throw error;
    /*
    FNXC:AIMergeRecovery 2026-08-15-06:37:
    A rejected approved squash must reset its clean room to the integration tip.
    Preexisting-clean-room recovery discovers candidates by HEAD, so leaving the
    rejected commit in place would make each retry select and reject it again.
    */
    await execFileAsync("git", ["reset", "--hard", params.tipSha], { cwd: params.mergeRoot });
    await execFileAsync("git", ["clean", "-fd"], { cwd: params.mergeRoot });
    /*
    FNXC:AIMergeReviewReconciliation 2026-08-23-22:05:
    Resetting the clean room is no longer enough to stop a retry re-selecting the rejected squash.
    FN-090 made `aiMergeReviewReconciliation` a SECOND selector: `mergeAndReview` skips its merge
    agent entirely while the record still carries a `candidateSha`, and pre-existing clean-room
    recovery admits that same twice-confirmed candidate. A file-scope violation is a verdict on the
    candidate itself, so the durable record must be dropped with the commit — otherwise every retry
    re-enters the gate on a squash the invariant already rejected and never re-merges.
    Best effort: the violation is the caller's answer and must not be masked by a store failure.
    */
    try {
      await params.store.updateTask(params.taskId, { aiMergeReviewReconciliation: null });
    } catch {
      // The clean-room reset already removed the HEAD-based selector; report the violation.
    }
    throw error;
  }
}
