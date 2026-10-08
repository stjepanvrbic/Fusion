import type {
  ExperimentRunRecordPayload,
  ExperimentSession,
  ExperimentSessionRecord,
} from "@fusion/core";

import { makeUniqueStashLabel } from "../merge/tagged-stash.js";
import type { GitOps, StashHandle } from "./git-ops.js";

export const AUTORESEARCH_PRESERVED_PATHS = [
  "autoresearch.jsonl",
  "autoresearch.md",
  "autoresearch.ideas.md",
  "autoresearch.checks.sh",
  "autoresearch.config.json",
  "autoresearch.hooks/",
] as const;

export function isPreservedAutoresearchPath(pathname: string): boolean {
  return AUTORESEARCH_PRESERVED_PATHS.some((preserved) =>
    preserved.endsWith("/")
      ? pathname === preserved.slice(0, -1) || pathname.startsWith(preserved)
      : pathname === preserved,
  );
}

export class ExperimentRevertConflictError extends Error {
  constructor(message: string, public readonly causeError?: unknown) {
    super(message);
    this.name = "ExperimentRevertConflictError";
  }
}

export async function commitKept(opts: {
  session: ExperimentSession;
  runRecord: ExperimentSessionRecord;
  runPayload: ExperimentRunRecordPayload;
  git: GitOps;
  commitMessage?: string;
}): Promise<{ commit: string }> {
  const metricName = opts.session.metric.name;
  const metricValue = opts.runPayload.primaryMetric ?? "n/a";
  const message =
    opts.commitMessage ??
    `experiment(${opts.session.id}): keep ${opts.runRecord.id} — ${metricName}=${metricValue}`;

  await opts.git.add(["-A"]);
  const commit = await opts.git.commit(message);
  return { commit };
}

export async function revertDiscarded(opts: {
  session: ExperimentSession;
  git: GitOps;
  baselineCommit: string;
}): Promise<{ revertedTo: string; preservedPaths: string[] }> {
  const status = await opts.git.statusPorcelain();
  const preservedPaths = status
    .split(/\r?\n/)
    .map((line) => line.match(/^..\s+(.+)$/)?.[1]?.trim() ?? "")
    .filter(Boolean)
    .filter((pathname) => isPreservedAutoresearchPath(pathname));

  // FNXC:WorktreeStashIsolation 2026-10-08-08:29: unique label + SHA handle — the stash list is shared
  // across worktrees, so a positional `stash@{N}` could restore another session's entry (KB-008).
  let stash: StashHandle | null = null;
  if (preservedPaths.length > 0) {
    await opts.git.add(preservedPaths);
    stash = await opts.git.stashSave(makeUniqueStashLabel(`experiment-preserve-${opts.session.id}`));
  }

  await opts.git.resetHard(opts.baselineCommit);

  if (stash) {
    try {
      await opts.git.stashRestore(stash);
    } catch (error) {
      throw new ExperimentRevertConflictError(
        `Failed to restore preserved autoresearch artifacts for ${opts.session.id}`,
        error,
      );
    }
  }

  return { revertedTo: opts.baselineCommit, preservedPaths };
}
