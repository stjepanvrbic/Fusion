/*
FNXC:WorktreeCleanup 2026-10-07-15:11:
Shared seam for "git removal failed — what is actually left?". On Windows `git worktree remove` deletes
work-tree files first and then deletes the admin entry even when the work-tree delete fails on a locked
file, so a non-zero exit can leave a half-deleted, `.git`-less or unregistered folder. KB-003 fixed only
post-landing cleanup; every defensive removal (self-healing reclaim, pool prune, step-session cleanup,
merger cleanup, pre-execution release) now settles a failure through this module so callers clear their
task pointer instead of keeping one to a broken folder.

Deletion authority is narrow and filesystem-proven:
- Residue is deleted only when THIS call's git removal crossed the deletion boundary: the caller proved
  the checkout usable before removal (and its own content probe passed), git failed, and the folder is
  now `.git`-less or carries a dangling `gitdir:` pointer.
- A folder that still has a live `.git` link, a `.git` directory (an independent repository), or an
  unreadable `.git` is never deleted — that is a real refusal (dirty, locked, foreign) and stays preserved.
- A folder that was already unusable before removal is reported, never deleted (its content was never
  proven removable; `git status` inside a `.git`-less folder resolves to the parent repository).
The proof uses only async, bounded filesystem reads: no git subprocess, so a transient
`git worktree list` failure can never masquerade as "unregistered" and authorize deletion.
*/
import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { RunAuditor } from "../util/run-audit.js";
import type { TaskWorktreeClassificationResult } from "./worktree-pool.js";
import { pruneWorktreeAdminEntries } from "./worktree-prune.js";
import { removeDirectoryWithRetry } from "./worktree-removal-retry.js";

/** Classifies a checkout after a failed removal; post-landing cleanup injects the canonical classifier. */
export type CheckoutStateProbe = (rootDir: string, worktreePath: string) => Promise<TaskWorktreeClassificationResult>;

/** Deletes residual files git left behind; defaults to the bounded `removeDirectoryWithRetry`. */
export type CheckoutResidueRemover = (worktreePath: string) => Promise<{ removed: boolean }>;

/** Unusable-but-present checkout shapes a partial removal leaves behind. */
export type CheckoutResidueClassification = "incomplete" | "unregistered";

/**
 * Filesystem view of a checkout's `.git` entry.
 * - `missing`: the checkout directory itself is gone.
 * - `absent`: the directory exists without `.git` (half-deleted).
 * - `dangling`: `.git` is a `gitdir:` file whose admin directory is gone (unregistered).
 * - `linked`: `.git` is a `gitdir:` file whose admin directory exists (registered linked worktree).
 * - `repository`: `.git` is a directory (an independent repository — never residue).
 * - `unknown`: unreadable or unparseable; fails closed.
 */
export type CheckoutGitEntryState = "missing" | "absent" | "dangling" | "linked" | "repository" | "unknown";

function errnoCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

export async function inspectCheckoutGitEntry(worktreePath: string): Promise<CheckoutGitEntryState> {
  try {
    if (!(await lstat(worktreePath)).isDirectory()) return "unknown";
  } catch (error) {
    return errnoCode(error) === "ENOENT" ? "missing" : "unknown";
  }
  const dotGit = join(worktreePath, ".git");
  try {
    const entry = await lstat(dotGit);
    if (entry.isDirectory()) return "repository";
    if (!entry.isFile()) return "unknown";
  } catch (error) {
    return errnoCode(error) === "ENOENT" ? "absent" : "unknown";
  }
  let target: string;
  try {
    const match = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, "utf8"));
    if (!match) return "unknown";
    const raw = match[1]!.trim();
    target = isAbsolute(raw) ? raw : resolve(dirname(dotGit), raw);
  } catch (error) {
    // `.git` vanished between lstat and read: the deletion is still in flight or finished.
    return errnoCode(error) === "ENOENT" ? "absent" : "unknown";
  }
  try {
    await lstat(target);
    return "linked";
  } catch (error) {
    return errnoCode(error) === "ENOENT" ? "dangling" : "unknown";
  }
}

/*
FNXC:WorktreeCleanup 2026-10-07-19:23:
Deletion authority must survive a failed deletion. When a removal that held authority (content-proven clean, or explicit force) leaves residue it could not delete, it writes this marker into the residue.
Later sweeps (startup reaper, pinned and workspace acquisition, creation) delete `.git`-less or dangling residue only when the marker is present.
Unmarked residue, including folders post-landing cleanup reported as already unusable, is preserved: missing `.git` proves unusability, never that the files are disposable.
*/
export const CHECKOUT_REMOVAL_RESIDUE_MARKER = ".fusion-removal-residue";

/** Best-effort: a marker that cannot be written leaves the residue preserved, which is the safe failure. */
export async function markAuthorizedCheckoutResidue(
  worktreePath: string,
  metadata: { taskId?: string; source: string },
): Promise<boolean> {
  try {
    await writeFile(
      join(worktreePath, CHECKOUT_REMOVAL_RESIDUE_MARKER),
      `${JSON.stringify({ ...metadata, markedAt: new Date().toISOString() })}\n`,
    );
    return true;
  } catch {
    return false;
  }
}

/** True only for residue a deletion-authorized removal left behind: marker present and no live `.git`. */
export async function isAuthorizedCheckoutResidue(worktreePath: string): Promise<boolean> {
  const state = await inspectCheckoutGitEntry(worktreePath);
  if (state !== "absent" && state !== "dangling") return false;
  try {
    return (await lstat(join(worktreePath, CHECKOUT_REMOVAL_RESIDUE_MARKER))).isFile();
  } catch {
    return false;
  }
}

/**
 * Deletes marker-authorized residue with the bounded retry.
 * A partial failure re-writes the marker, because the deletion may have removed it while other files survived.
 */
export async function removeAuthorizedCheckoutResidue(
  worktreePath: string,
  metadata: { taskId?: string; source: string },
  remover: CheckoutResidueRemover = defaultCheckoutResidueRemover,
): Promise<{ removed: boolean }> {
  if (!await isAuthorizedCheckoutResidue(worktreePath)) return { removed: false };
  const result = await remover(worktreePath).catch(() => ({ removed: false }));
  if (!result.removed && await inspectCheckoutGitEntry(worktreePath) !== "missing") {
    await markAuthorizedCheckoutResidue(worktreePath, metadata);
  }
  return { removed: result.removed };
}

/**
 * Rolls back a checkout directory THIS call created (a failed `git worktree add` or identity-guard install).
 * Creation is deletion authority, so the bounded retry runs and surviving residue is marked; callers must never pass a path that existed before their create attempt.
 */
export async function rollbackCreatedCheckout(
  worktreePath: string,
  metadata: { taskId?: string; source: string },
  remover: CheckoutResidueRemover = defaultCheckoutResidueRemover,
): Promise<boolean> {
  const result = await remover(worktreePath).catch(() => ({ removed: false }));
  if (!result.removed && await inspectCheckoutGitEntry(worktreePath) !== "missing") {
    await markAuthorizedCheckoutResidue(worktreePath, metadata);
  }
  return result.removed;
}

/** Residue whose deletion is filesystem-proven safe: no live checkout link and no independent repository. */
function isProvenResidue(state: CheckoutGitEntryState): boolean {
  return state === "missing" || state === "absent" || state === "dangling";
}

function residueClassificationFor(state: CheckoutGitEntryState): CheckoutResidueClassification | undefined {
  if (state === "absent") return "incomplete";
  if (state === "dangling") return "unregistered";
  return undefined;
}

export function isCheckoutResidue(
  state: TaskWorktreeClassificationResult | undefined,
): state is { ok: false; classification: CheckoutResidueClassification; reason: string } {
  return !!state && !state.ok && (state.classification === "incomplete" || state.classification === "unregistered");
}

export type CheckoutRemovalPartialAuditMetadata = {
  taskId?: string;
  source: string;
  classification: string;
  phase: "pre-existing" | "during-removal";
  residual: boolean;
};

/**
 * FNXC:WorktreeCleanup 2026-10-07-15:11:
 * `worktree:removal-partial` keeps KB-003's ids/fixed-outcomes metadata shape for every surface that
 * settles residue. A sink failure never changes the removal outcome (the real auditor is bounded).
 */
export async function recordCheckoutRemovalPartial(
  audit: Pick<RunAuditor, "git"> | undefined,
  worktreePath: string,
  metadata: CheckoutRemovalPartialAuditMetadata,
): Promise<void> {
  try {
    await audit?.git({ type: "worktree:removal-partial", target: worktreePath, metadata });
  } catch {
    // Audit persistence must not change worktree cleanup outcomes.
  }
}

export async function pruneCheckoutAdminBestEffort(rootDir: string, worktreePath: string, audit: Pick<RunAuditor, "git"> | undefined, reason: string): Promise<void> {
  try {
    await pruneWorktreeAdminEntries({ rootDir, auditor: audit, reason, target: worktreePath });
  } catch {
    // Pruning stale administration is housekeeping; it never decides the cleanup outcome.
  }
}

export const defaultCheckoutResidueRemover: CheckoutResidueRemover = (worktreePath) =>
  removeDirectoryWithRetry({ path: worktreePath, rm });

export type FailedCheckoutRemovalSettlement =
  /** Git failed, but no checkout remains. */
  | { outcome: "removed" }
  /** This call's removal unregistered the checkout; residue deletion was attempted. */
  | { outcome: "partially-removed"; classification: CheckoutResidueClassification; residualRemoved: boolean }
  /** Unusable, but this call never proved it usable: reported, never deleted. */
  | { outcome: "residual-unusable"; classification: CheckoutResidueClassification }
  /** Still usable, unprovable, or unprobeable: the caller keeps its refusal/preservation contract. */
  | { outcome: "unresolved" };

/**
 * Settles a failed checkout removal. Callers must not invoke it for safety refusals raised before git
 * ran (content probe, active session); those are preservation decisions, not partial removals.
 */
export async function settleFailedCheckoutRemoval(input: {
  rootDir: string;
  worktreePath: string;
  /**
   * This removal held deletion authority: the caller proved the checkout usable and content-clean immediately before it, or it is an explicit force teardown.
   * Without it, residue is reported and preserved, never deleted.
   */
  deletionAuthorized: boolean;
  taskId?: string;
  source: string;
  pruneReason: string;
  audit?: Pick<RunAuditor, "git">;
  /** Optional classifier for the post-failure state; defaults to the filesystem proof alone. */
  probe?: CheckoutStateProbe;
  removeResidue?: CheckoutResidueRemover;
}): Promise<FailedCheckoutRemovalSettlement> {
  const { rootDir, worktreePath, audit } = input;
  const fsState = await inspectCheckoutGitEntry(worktreePath);

  let after: TaskWorktreeClassificationResult | undefined;
  if (input.probe) {
    try {
      after = await input.probe(rootDir, worktreePath);
    } catch {
      return { outcome: "unresolved" };
    }
  } else if (fsState === "missing") {
    after = { ok: false, classification: "missing", reason: "worktree directory does not exist" };
  } else {
    const classification = residueClassificationFor(fsState);
    after = classification ? { ok: false, classification, reason: `filesystem state ${fsState}` } : undefined;
  }

  if (after && !after.ok && after.classification === "missing") {
    await pruneCheckoutAdminBestEffort(rootDir, worktreePath, audit, input.pruneReason);
    return { outcome: "removed" };
  }
  if (!isCheckoutResidue(after)) return { outcome: "unresolved" };
  // The classifier and the filesystem must agree that nothing live remains before a pointer is cleared or anything is deleted.
  if (!isProvenResidue(fsState)) return { outcome: "unresolved" };

  if (!input.deletionAuthorized) {
    await pruneCheckoutAdminBestEffort(rootDir, worktreePath, audit, input.pruneReason);
    await recordCheckoutRemovalPartial(audit, worktreePath, {
      taskId: input.taskId, source: input.source, classification: after.classification, phase: "during-removal", residual: true,
    });
    return { outcome: "residual-unusable", classification: after.classification };
  }

  const residual = await (input.removeResidue ?? defaultCheckoutResidueRemover)(worktreePath)
    .catch(() => ({ removed: false }));
  if (!residual.removed && await inspectCheckoutGitEntry(worktreePath) !== "missing") {
    await markAuthorizedCheckoutResidue(worktreePath, { taskId: input.taskId, source: input.source });
  }
  await pruneCheckoutAdminBestEffort(rootDir, worktreePath, audit, input.pruneReason);
  await recordCheckoutRemovalPartial(audit, worktreePath, {
    taskId: input.taskId, source: input.source, classification: after.classification, phase: "during-removal", residual: !residual.removed,
  });
  return { outcome: "partially-removed", classification: after.classification, residualRemoved: residual.removed };
}
