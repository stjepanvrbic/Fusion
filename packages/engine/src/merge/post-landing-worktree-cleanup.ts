import { existsSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isLegacyWorkspaceWorktreeLayout, isStrictDescendantPath, resolveWorkspaceTaskWorktreeDir, type Settings, type Task, type TaskStore } from "@fusion/core";
import type { RunAuditor } from "../util/run-audit.js";
import {
  ActiveSessionWorktreeRemovalError,
  RemovalReason,
  removeWorktree,
} from "../worktree/worktree-backend.js";
import type { MergeWriteFence } from "./merge-write-fence.js";
import { activeSessionRegistry } from "../agents/active-session-registry.js";
import { canonicalizePath, classifyTaskWorktree, type TaskWorktreeClassificationResult } from "../worktree/worktree-pool.js";
import {
  inspectCheckoutGitEntry,
  isCheckoutResidue,
  pruneCheckoutAdminBestEffort,
  recordCheckoutRemovalPartial,
  settleFailedCheckoutRemoval,
  type CheckoutResidueClassification,
  type CheckoutResidueRemover,
  type CheckoutStateProbe,
  type FailedCheckoutRemovalSettlement,
} from "../worktree/remove-checkout.js";

/**
 * FNXC:WorktreeCleanup 2026-10-07-05:29:
 * KB-003 adds truthful outcomes for a checkout that is no longer usable. `partially-removed` means this
 * call's git removal unregistered the checkout but residual files remain; `residual-unusable` means the
 * checkout was already `.git`-less or unregistered before cleanup ran. `preserved-*` is reported only
 * while a usable, registered checkout really remains.
 */
export type LandedWorktreeCleanupOutcome =
  | "removed"
  | "nothing-to-remove"
  | "partially-removed"
  | "residual-unusable"
  | "preserved-deliverable"
  | "preserved-unverifiable"
  | "preserved-active-session";

type LandedWorktreeCleanupStore = Pick<TaskStore, "updateTask" | "logEntry"> & Partial<Pick<TaskStore, "getSettings">>;

/** Classifies a recorded checkout; defaults to the canonical `classifyTaskWorktree`. */
export type LandedWorktreeStateProbe = CheckoutStateProbe;

/** Deletes residual files git left behind; defaults to the bounded `removeDirectoryWithRetry`. */
export type LandedWorktreeResidualRemover = CheckoutResidueRemover;

export interface CleanupLandedTaskWorktreeInput {
  store: LandedWorktreeCleanupStore;
  taskId: string;
  worktreePath: string | null | undefined;
  rootDir: string | null | undefined;
  landedSha?: string;
  source: string;
  audit?: RunAuditor;
  log?: (message: string) => void | Promise<void>;
  fence?: Pick<MergeWriteFence, "assertOwned">;
  probeWorktreeState?: LandedWorktreeStateProbe;
  removeResidualDirectory?: LandedWorktreeResidualRemover;
}

export interface CleanupLandedTaskWorktreeResult {
  outcome: LandedWorktreeCleanupOutcome;
  removed: boolean;
  preservedReason?: string;
}

function preservedOutcomeFor(error: unknown): Pick<CleanupLandedTaskWorktreeResult, "outcome" | "preservedReason"> {
  if (error instanceof ActiveSessionWorktreeRemovalError) {
    return { outcome: "preserved-active-session", preservedReason: "active-session" };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(": status probe failed (")) {
    return { outcome: "preserved-unverifiable", preservedReason: "unverifiable" };
  }
  return { outcome: "preserved-deliverable", preservedReason: "deliverable" };
}

async function recordPreservedOutcome(
  input: Pick<CleanupLandedTaskWorktreeInput, "store" | "taskId" | "log">,
  worktreePath: string,
  result: Pick<CleanupLandedTaskWorktreeResult, "outcome" | "preservedReason">,
): Promise<void> {
  const message = `Post-landing worktree cleanup preserved ${worktreePath}: ${result.preservedReason ?? result.outcome}`;
  try {
    if (input.log) {
      await input.log(message);
      return;
    }
    await input.store.logEntry(
      input.taskId,
      "Post-landing worktree cleanup preserved",
      message,
    );
  } catch {
    // Cleanup observability must not turn a durable landing into a failed merge.
  }
}

async function recordCleanupMessage(
  input: Pick<CleanupLandedTaskWorktreeInput, "store" | "taskId" | "log">,
  title: string,
  message: string,
): Promise<void> {
  try {
    if (input.log) {
      await input.log(message);
      return;
    }
    await input.store.logEntry(input.taskId, title, message);
  } catch {
    // Cleanup observability must not turn a durable landing into a failed merge.
  }
}

function errorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split(/\r?\n/).find((line) => line.trim().length > 0) ?? message;
  return firstLine.length > 300 ? `${firstLine.slice(0, 300)}…` : firstLine;
}

/** Content refusals and live-session refusals are genuine preservation decisions made before git ran. */
function isPreservationRefusal(error: unknown): boolean {
  if (error instanceof ActiveSessionWorktreeRemovalError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("preserving ");
}

async function probeState(
  probe: LandedWorktreeStateProbe,
  rootDir: string,
  worktreePath: string,
): Promise<TaskWorktreeClassificationResult | undefined> {
  try {
    return await probe(rootDir, worktreePath);
  } catch {
    return undefined;
  }
}

const POST_LANDING_PRUNE_REASON = "post-landing-partial-removal";

/*
FNXC:WorktreeCleanup 2026-10-07-13:33:
KB-005 — the KB-003 live-session short-circuit in cleanupLandedTaskWorktree bypassed removeWorktree, which
was the sole writer of the `worktree:removal-refused-active-session` audit for this path. The refusal must
stay audited (pipeline S10 invariant "cleanup refusal is audited"), with the same metadata shape as
removeWorktree: owning session taskId, removal reason, and session kind. The session may be registered under
the raw or the canonical path (Windows / macOS `/private` aliasing), so both forms are looked up.
Audit persistence is best-effort: a missing, throwing, or rejecting sink never changes the cleanup outcome.

FNXC:WorktreeCleanup 2026-10-07-14:44:
KB-006 — workspace cleanup shares this helper and appends `repoRelPath` (the repo-relative identifier only)
via `extraMetadata`. Single-repo callers pass none, so their metadata stays exactly { taskId, reason, kind }.
*/
async function recordActiveSessionRefusalAudit(
  input: Pick<CleanupLandedTaskWorktreeInput, "audit" | "taskId">,
  worktreePath: string,
  extraMetadata?: { repoRelPath: string },
): Promise<void> {
  try {
    const record = activeSessionRegistry.lookupByPath(worktreePath)
      ?? activeSessionRegistry.lookupByPath(canonicalizePath(worktreePath));
    await input.audit?.git({
      type: "worktree:removal-refused-active-session",
      target: worktreePath,
      metadata: {
        taskId: record?.taskId ?? input.taskId,
        reason: RemovalReason.CompletionLandedCleanup,
        kind: record?.kind ?? "unknown",
        ...(extraMetadata ?? {}),
      },
    });
  } catch {
    // Audit persistence must not change worktree cleanup outcomes.
  }
}

type UnusablePathOutcome =
  | { kind: "settled"; outcome: "removed" | "partially-removed" | "residual-unusable" | "nothing-to-remove"; removed: boolean }
  | { kind: "preserved"; outcome: Extract<LandedWorktreeCleanupOutcome, "preserved-deliverable" | "preserved-unverifiable" | "preserved-active-session">; reason: string };

/*
FNXC:WorktreeCleanup 2026-10-07-05:29:
KB-001 (Windows) showed `git worktree remove` failing on a locked file after it had already deleted part
of the checkout: git continues to delete the admin dir after a failed work-tree delete, so the folder is
left `.git`-less and unregistered while the call still exits non-zero. The former catch-all mapped that
error to "preserved … deliverable", kept the task pointer, and every post-merge recheck reused the broken
folder. This core re-probes after a non-refusal failure and reports what actually happened.
Residual files are recursively deleted ONLY when this call's own git removal crossed the deletion
boundary (pre-probe usable + removeWorktree's content probe passed + post-probe unusable). A directory
that was already unusable before cleanup ran is never deleted here: its content was never proven
removable, and `git status` inside a `.git`-less folder resolves to the parent repository. Acquisition's
pinned orphan preservation owns that residue instead.
*/
async function cleanupLandedWorktreePath(params: {
  input: Pick<CleanupLandedTaskWorktreeInput, "store" | "log" | "audit" | "landedSha" | "source" | "probeWorktreeState" | "removeResidualDirectory" | "fence">;
  taskId: string;
  rootDir: string;
  worktreePath: string;
  settings: Partial<Settings>;
}): Promise<UnusablePathOutcome> {
  const { input, taskId, rootDir, worktreePath, settings } = params;
  const logInput = { store: input.store, taskId, log: input.log };
  const probe = input.probeWorktreeState ?? classifyTaskWorktree;

  const before = await probeState(probe, rootDir, worktreePath);
  if (before && !before.ok) {
    if (before.classification === "missing") {
      return { kind: "settled", outcome: "nothing-to-remove", removed: false };
    }
    /*
    FNXC:WorktreeCleanup 2026-10-07-19:23:
    A classifier "unregistered" verdict is residue only when the filesystem agrees (`.git` absent or a dangling `gitdir:`).
    A `.git` link that still resolves, or an unknown registration probe, falls through to `removeWorktree`, which re-probes; clearing the pointer on a transient `git worktree list` failure leaked a live checkout.
    */
    const fsState = isCheckoutResidue(before) ? await inspectCheckoutGitEntry(worktreePath) : undefined;
    const fsAgreesResidue = fsState === "absent" || fsState === "dangling" || fsState === "missing";
    const reprobeByRemoval = (isCheckoutResidue(before) && !fsAgreesResidue) || before.classification === "registration-unknown";
    if (isCheckoutResidue(before) && fsAgreesResidue) {
      await pruneCheckoutAdminBestEffort(rootDir, worktreePath, input.audit, POST_LANDING_PRUNE_REASON);
      await recordCheckoutRemovalPartial(input.audit, worktreePath, {
        taskId, source: input.source, classification: before.classification, phase: "pre-existing", residual: true,
      });
      await recordCleanupMessage(
        logInput,
        "Post-landing worktree cleanup found an unusable checkout",
        `Post-landing worktree cleanup found ${worktreePath} already unusable (${before.classification}); cleared the task worktree pointer and left the residue for orphan recovery`,
      );
      return { kind: "settled", outcome: "residual-unusable", removed: false };
    }
    if (!reprobeByRemoval) {
      // repo-root / outside-work-tree: fail closed, never delete what cannot be proven a task checkout.
      const preserved = { kind: "preserved" as const, outcome: "preserved-unverifiable" as const, reason: "unverifiable" };
      await recordPreservedOutcome(logInput, worktreePath, { outcome: preserved.outcome, preservedReason: preserved.reason });
      return preserved;
    }
  }

  const recordPartialRemoval = async (
    classification: CheckoutResidueClassification,
    residualRemoved: boolean,
    failureSummary: string,
  ): Promise<UnusablePathOutcome> => {
    await recordCleanupMessage(
      logInput,
      "Post-landing worktree cleanup partially removed",
      `Post-landing worktree cleanup partially removed ${worktreePath} (${classification}): git unregistered the checkout but ${failureSummary}; residual files ${residualRemoved ? "deleted" : "remain"}`,
    );
    return residualRemoved
      ? { kind: "settled", outcome: "removed", removed: true }
      : { kind: "settled", outcome: "partially-removed", removed: false };
  };

  const recordSettlement = async (
    settlement: FailedCheckoutRemovalSettlement,
    failureSummary: string,
  ): Promise<UnusablePathOutcome | undefined> => {
    switch (settlement.outcome) {
      case "removed":
        return { kind: "settled", outcome: "removed", removed: true };
      case "partially-removed":
        return recordPartialRemoval(settlement.classification, settlement.residualRemoved, failureSummary);
      case "residual-unusable":
        await recordCleanupMessage(
          logInput,
          "Post-landing worktree cleanup found an unusable checkout",
          `Post-landing worktree cleanup found ${worktreePath} unusable (${settlement.classification}) after ${failureSummary}; cleared the task worktree pointer and left the residue for orphan recovery`,
        );
        return { kind: "settled", outcome: "residual-unusable", removed: false };
      case "unresolved":
        return undefined;
    }
  };

  let removal: Awaited<ReturnType<typeof removeWorktree>>;
  try {
    input.fence?.assertOwned("finalization");
    removal = await removeWorktree({
      rootDir,
      worktreePath,
      settings,
      taskId,
      audit: input.audit,
      reason: RemovalReason.CompletionLandedCleanup,
      postLandingProof: { landedSha: input.landedSha, source: input.source },
      removeCheckoutResidue: input.removeResidualDirectory,
    });
  } catch (error) {
    /*
    FNXC:WorktreeCleanup 2026-10-07-15:11:
    removeWorktree now settles a proven partial removal itself; this re-probe covers what it cannot
    prove alone (a pre-probe that failed, or a classifier-only verdict) through the same shared seam,
    so post-landing and defensive removal share one set of residue rules.
    */
    if (!isPreservationRefusal(error)) {
      const settled = await recordSettlement(await settleFailedCheckoutRemoval({
        rootDir,
        worktreePath,
        deletionAuthorized: before?.ok === true,
        taskId,
        source: input.source,
        pruneReason: POST_LANDING_PRUNE_REASON,
        audit: input.audit,
        probe,
        removeResidue: input.removeResidualDirectory,
      }), errorSummary(error));
      if (settled) return settled;
    }
    const preserved = preservedOutcomeFor(error);
    await recordPreservedOutcome(logInput, worktreePath, preserved);
    return {
      kind: "preserved",
      outcome: preserved.outcome as Extract<LandedWorktreeCleanupOutcome, "preserved-deliverable" | "preserved-unverifiable" | "preserved-active-session">,
      reason: preserved.preservedReason ?? "deliverable",
    };
  }
  if (removal.classification === "partially-removed") {
    return recordPartialRemoval(removal.checkoutState, removal.residualRemoved, removal.failureSummary);
  }
  return removal.removed
    ? { kind: "settled", outcome: "removed", removed: true }
    : { kind: "settled", outcome: "nothing-to-remove", removed: false };
}

async function recordPointerClearPending(
  input: CleanupLandedTaskWorktreeInput,
  worktreePath: string,
  error: unknown,
): Promise<void> {
  const detail = error instanceof Error ? error.message : String(error);
  const message = `Post-landing worktree cleanup removed ${worktreePath}, but clearing the task worktree pointer is pending: ${detail}`;
  try {
    if (input.log) {
      await input.log(message);
      return;
    }
    await input.store.logEntry(
      input.taskId,
      "Post-landing worktree cleanup pointer clear pending",
      message,
    );
  } catch {
    // Cleanup observability must not turn a durable landing into a failed merge.
  }
}

/*
FNXC:WorktreeCleanup 2026-08-29-01:50:
FN-251's removed outcome requires both filesystem deletion and a cleared durable worktree pointer.
A transient pointer write failure stays non-fatal after a proven landing, but is recorded and retried
when convergence encounters the now-absent path instead of falsely reporting successful cleanup.
*/
async function clearWorktreePointer(
  input: CleanupLandedTaskWorktreeInput,
  worktreePath: string,
): Promise<boolean> {
  input.fence?.assertOwned("finalization");
  try {
    await input.store.updateTask(input.taskId, { worktree: null });
    return true;
  } catch (error) {
    await recordPointerClearPending(input, worktreePath, error);
    return false;
  }
}

/**
 * FNXC:WorktreeCleanup 2026-08-29-00:54:
 * FN-251 makes cleanup a proof-gated, non-fatal pre-completion action. A durable landing may discard
 * only ignored-only content; deliverable, unverifiable, and active-session worktrees stay intact and
 * are recorded so completion never retries or misreports an already-landed merge as a failure.
 */
export async function cleanupLandedTaskWorktree(
  input: CleanupLandedTaskWorktreeInput,
): Promise<CleanupLandedTaskWorktreeResult> {
  const worktreePath = input.worktreePath;
  if (!worktreePath || !input.rootDir) {
    return { outcome: "nothing-to-remove", removed: false };
  }
  if (!existsSync(worktreePath)) {
    await clearWorktreePointer(input, worktreePath);
    return { outcome: "nothing-to-remove", removed: false };
  }

  let settings = {};
  try {
    if (typeof input.store.getSettings === "function") {
      settings = await input.store.getSettings();
    }
  } catch (error) {
    const result = preservedOutcomeFor(new Error(`preserving ${worktreePath}: status probe failed (${error instanceof Error ? error.message : String(error)})`));
    await recordPreservedOutcome(input, worktreePath, result);
    return { ...result, removed: false };
  }

  // A live session owns the checkout: preserve it before any probe or git work touches the path.
  if (activeSessionRegistry.isPathActive(worktreePath) || activeSessionRegistry.isPathActive(canonicalizePath(worktreePath))) {
    const result = { outcome: "preserved-active-session" as const, preservedReason: "active-session" };
    await recordActiveSessionRefusalAudit(input, worktreePath);
    await recordPreservedOutcome(input, worktreePath, result);
    return { ...result, removed: false };
  }

  const pathOutcome = await cleanupLandedWorktreePath({
    input: { ...input, fence: undefined },
    taskId: input.taskId,
    rootDir: input.rootDir,
    worktreePath,
    settings,
  });
  if (pathOutcome.kind === "preserved") {
    return { outcome: pathOutcome.outcome, removed: false, preservedReason: pathOutcome.reason };
  }
  if (pathOutcome.outcome === "nothing-to-remove" && existsSync(worktreePath)) {
    return { outcome: "nothing-to-remove", removed: false };
  }

  /*
  FNXC:WorktreeCleanup 2026-10-07-05:29:
  Once the checkout is gone, unregistered, or half-deleted, the durable pointer is cleared so no later
  lifecycle step reuses an unusable folder as a session cwd. Pointer-clear failures stay non-fatal and
  never report `removed`.
  */
  if (!await clearWorktreePointer(input, worktreePath)) {
    return { outcome: "nothing-to-remove", removed: false };
  }
  return { outcome: pathOutcome.outcome, removed: pathOutcome.removed };
}

export interface CleanupLandedWorkspaceTaskWorktreesInput {
  store: LandedWorktreeCleanupStore;
  task: Pick<Task, "id" | "workspaceWorktrees">;
  workspaceRootDir: string;
  landedShas?: Record<string, string | undefined>;
  source: string;
  audit?: RunAuditor;
  log?: (message: string) => void | Promise<void>;
  fence?: Pick<MergeWriteFence, "assertOwned">;
  probeWorktreeState?: LandedWorktreeStateProbe;
  removeResidualDirectory?: LandedWorktreeResidualRemover;
}

export interface WorkspaceLandedWorktreePreservation {
  repoRel: string;
  worktreePath: string;
  outcome: Extract<LandedWorktreeCleanupOutcome, "preserved-deliverable" | "preserved-unverifiable" | "preserved-active-session">;
  reason: string;
}

export interface CleanupLandedWorkspaceTaskWorktreesResult {
  removedRepoRels: string[];
  preserved: WorkspaceLandedWorktreePreservation[];
  taskDirectoryRemoved: boolean;
  removed: boolean;
}

type WorkspacePathOutcome =
  | { kind: "settled"; removed: boolean }
  | { kind: "preserved"; outcome: WorkspaceLandedWorktreePreservation["outcome"]; reason: string };

/*
FNXC:WorktreeCleanup 2026-08-30-15:06:
Workspace post-landing cleanup applies the same proof-gated removal as singular finalization.
Recorded child paths stay durable after removal because the terminal workspace sweep still needs
those paths to delete the matching task branches; only empty directory shells are retired here.
*/
export async function cleanupLandedWorkspaceTaskWorktrees(
  input: CleanupLandedWorkspaceTaskWorktreesInput,
): Promise<CleanupLandedWorkspaceTaskWorktreesResult> {
  const entries = Object.entries(input.task.workspaceWorktrees ?? {})
    .filter(([, entry]) => Boolean(entry.worktreePath));
  const result: CleanupLandedWorkspaceTaskWorktreesResult = {
    removedRepoRels: [],
    preserved: [],
    taskDirectoryRemoved: false,
    removed: false,
  };
  const logInput = { ...input, taskId: input.task.id };
  if (entries.length === 0) return result;

  let settings: Settings = {} as Settings;
  try {
    if (typeof input.store.getSettings === "function") settings = await input.store.getSettings();
  } catch (error) {
    for (const [repoRel, entry] of entries) {
      const worktreePath = entry.worktreePath;
      const preserved = preservedOutcomeFor(new Error(`preserving ${worktreePath}: status probe failed (${error instanceof Error ? error.message : String(error)})`));
      await recordPreservedOutcome(logInput, worktreePath, preserved);
      result.preserved.push({ repoRel, worktreePath, outcome: preserved.outcome as WorkspaceLandedWorktreePreservation["outcome"], reason: preserved.preservedReason ?? "unverifiable" });
    }
    return result;
  }

  const outcomes = new Map<string, WorkspacePathOutcome>();
  for (const [, entry] of entries) {
    const worktreePath = entry.worktreePath;
    const key = canonicalizePath(worktreePath);
    if (outcomes.has(key)) continue;

    if (!existsSync(worktreePath)) {
      outcomes.set(key, { kind: "settled", removed: false });
      continue;
    }
    const repoRel = entries.find(([, candidate]) => canonicalizePath(candidate.worktreePath) === key)?.[0] ?? "";
    if (activeSessionRegistry.isPathActive(worktreePath) || activeSessionRegistry.isPathActive(key)) {
      const preservation: WorkspacePathOutcome = { kind: "preserved", outcome: "preserved-active-session", reason: "active-session" };
      outcomes.set(key, preservation);
      /*
      FNXC:WorktreeCleanup 2026-10-07-14:44:
      KB-006 — workspace cleanup's live-session short-circuit must leave the same best-effort refusal audit as
      single-repo cleanup, plus repoRelPath; one row per distinct canonical path (the first matching repoRel).
      The removeWorktree race-path refusal emits its own row, so nothing is emitted for it here.
      */
      await recordActiveSessionRefusalAudit({ audit: input.audit, taskId: input.task.id }, worktreePath, { repoRelPath: repoRel });
      await recordPreservedOutcome(logInput, worktreePath, { outcome: preservation.outcome, preservedReason: preservation.reason });
      continue;
    }

    /*
    FNXC:WorktreeCleanup 2026-10-07-05:29:
    KB-003 applies the singular truthful-outcome core per repository. A half-deleted or already
    unusable child settles (it is not a preserved checkout); recorded child paths stay durable for
    the terminal workspace branch sweep, and residue keeps the task directory via the empty-shell check.
    */
    const pathOutcome = await cleanupLandedWorktreePath({
      input: { ...input, landedSha: input.landedShas?.[repoRel] },
      taskId: input.task.id,
      rootDir: join(input.workspaceRootDir, repoRel),
      worktreePath,
      settings,
    });
    outcomes.set(key, pathOutcome.kind === "preserved"
      ? { kind: "preserved", outcome: pathOutcome.outcome, reason: pathOutcome.reason }
      : { kind: "settled", removed: pathOutcome.removed });
  }

  let everyEntrySettled = true;
  for (const [repoRel, entry] of entries) {
    const pathOutcome = outcomes.get(canonicalizePath(entry.worktreePath))!;
    if (pathOutcome.kind === "preserved") {
      everyEntrySettled = false;
      result.preserved.push({ repoRel, worktreePath: entry.worktreePath, outcome: pathOutcome.outcome, reason: pathOutcome.reason });
    } else if (pathOutcome.removed) {
      result.removedRepoRels.push(repoRel);
    }
  }
  result.removed = result.removedRepoRels.length > 0;

  const taskDir = resolveWorkspaceTaskWorktreeDir(input.workspaceRootDir, settings, input.task.id);
  if (!everyEntrySettled || isLegacyWorkspaceWorktreeLayout(input.task, taskDir)) return result;

  result.taskDirectoryRemoved = removeEmptyWorkspaceTaskDirectory(taskDir, entries.map(([, entry]) => entry.worktreePath));
  result.removed = result.removed || result.taskDirectoryRemoved;
  return result;
}

/**
 * Removes only empty workspace task-directory shells. Any unexpected residue
 * fails closed because neither the parents nor the task directory are removed
 * recursively.
 */
export function removeEmptyWorkspaceTaskDirectory(taskDir: string, worktreePaths: string[]): boolean {
  for (const worktreePath of worktreePaths) {
    let parent = dirname(worktreePath);
    while (isStrictDescendantPath(taskDir, parent)) {
      try {
        rmdirSync(parent);
      } catch {
        break;
      }
      parent = dirname(parent);
    }
  }
  try {
    rmdirSync(taskDir);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  }
}
