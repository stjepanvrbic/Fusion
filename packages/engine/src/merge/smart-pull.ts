import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  applyStashBySha,
  dropStashBySha,
  makeUniqueStashLabel,
  pushTaggedStash,
  TaggedStashUnresolvedError,
} from "./tagged-stash.js";

const execFileAsync = promisify(execFile);

export type SmartPullMode = "ff-only" | "stash-and-ff";

export interface SmartPullAuditEvent {
  mutationType: "pull:fast-forward" | "stash:push" | "stash:pop" | "stash:pop-conflict";
  metadata: Record<string, unknown>;
}

export type SmartPullAuditEmitter = (event: SmartPullAuditEvent) => void | Promise<void>;

export interface SmartPullInput {
  worktreePath: string;
  integrationBranch: string;
  mode: SmartPullMode;
  taskId?: string;
  emit?: SmartPullAuditEmitter;
}

export type SmartPullResult =
  | { kind: "clean-pull"; fromSha: string; toSha: string }
  | { kind: "stash-pull-pop"; fromSha: string; toSha: string; stashSha: string; stashLabel: string }
  | { kind: "stash-pop-conflict"; fromSha: string; toSha: string; stashSha: string; stashLabel: string; conflictedFiles: string[] }
  | { kind: "skipped-dirty"; fromSha: string; reason: "ff-only-mode-requires-clean-tree" }
  | { kind: "skipped-not-on-branch"; currentBranch: string }
  | { kind: "failed"; fromSha: string; stage: "stash" | "pull" | "pop"; error: string; stashSha?: string; stashLabel?: string };

async function runGit(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    encoding: "utf-8",
  });
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "stdout" in result) {
    return String((result as { stdout?: unknown }).stdout ?? "");
  }
  return "";
}

function commandError(err: unknown): string {
  if (err instanceof Error) {
    const anyErr = err as Error & { stdout?: string; stderr?: string };
    return [anyErr.stderr, anyErr.stdout, anyErr.message].filter(Boolean).join("\n").trim() || anyErr.message;
  }
  return String(err);
}

function isConflictMessage(message: string): boolean {
  return message.includes("CONFLICT") || message.includes("Merge conflict") || message.includes("could not apply");
}

async function listConflictedFiles(cwd: string): Promise<string[]> {
  try {
    const out = await runGit(["diff", "--name-only", "--diff-filter=U"], cwd, 5_000);
    return out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

async function hasLocalChanges(cwd: string): Promise<boolean> {
  const out = await runGit(["status", "--porcelain=v1", "--untracked-files=all"], cwd, 10_000);
  return out.trim().length > 0;
}

async function currentBranch(cwd: string): Promise<string> {
  return (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd, 5_000)).trim();
}

async function headSha(cwd: string): Promise<string> {
  return (await runGit(["rev-parse", "HEAD"], cwd, 5_000)).trim();
}

/**
 * Stash-aware fast-forward pull for a single worktree on its integration branch.
 *
 * Mirrors the dashboard's `POST /api/git/smart-pull` semantics so both the user-
 * triggered Pull button and the merger's post-ref-advance auto-sync hook share
 * one implementation. Returns a discriminated result instead of throwing for
 * recoverable conditions (dirty tree in ff-only mode, stash-pop conflict). Only
 * truly unexpected failures throw.
 */
export async function smartPull(input: SmartPullInput): Promise<SmartPullResult> {
  const { worktreePath, integrationBranch, mode, taskId, emit } = input;
  const emitSafe = async (event: SmartPullAuditEvent): Promise<void> => {
    if (!emit) return;
    try {
      await emit(event);
    } catch {
      // never let audit emission break the pull pipeline
    }
  };

  const branch = await currentBranch(worktreePath);
  if (branch !== integrationBranch) {
    return { kind: "skipped-not-on-branch", currentBranch: branch };
  }

  const fromSha = await headSha(worktreePath);
  const dirty = await hasLocalChanges(worktreePath);

  if (!dirty) {
    await runGit(["pull", "--ff-only"], worktreePath, 30_000);
    const toSha = await headSha(worktreePath);
    await emitSafe({
      mutationType: "pull:fast-forward",
      metadata: { taskId, worktreePath, integrationBranch, fromSha, toSha, succeeded: true },
    });
    return { kind: "clean-pull", fromSha, toSha };
  }

  if (mode === "ff-only") {
    return { kind: "skipped-dirty", fromSha, reason: "ff-only-mode-requires-clean-tree" };
  }

  // stash-and-ff path
  /*
  FNXC:WorktreeStashIsolation 2026-10-08-08:29:
  The stash list is shared by every worktree of the repository. A `rev-parse stash@{0}` + bare `stash pop`
  round-trip restored a sibling session's entry whenever it pushed during our pull (KB-008). The entry is now
  pushed under a unique `fusion-auto-stash-` label, resolved to its SHA by that label, restored with
  `stash apply <sha>`, and dropped by SHA only after a clean restore; a failed restore keeps the entry.
  */
  const stashLabel = makeUniqueStashLabel(`fusion-auto-stash-${taskId ?? "manual"}`);
  let handle: { sha: string; label: string } | null;
  try {
    handle = await pushTaggedStash(worktreePath, stashLabel, { includeUntracked: true, timeoutMs: 15_000 });
  } catch (err: unknown) {
    if (err instanceof TaggedStashUnresolvedError) {
      return { kind: "failed", fromSha, stage: "stash", error: err.message, stashLabel };
    }
    return { kind: "failed", fromSha, stage: "stash", error: commandError(err) };
  }

  if (!handle) {
    // race: tree went clean between hasLocalChanges and stash push
    await runGit(["pull", "--ff-only"], worktreePath, 30_000);
    const toSha = await headSha(worktreePath);
    await emitSafe({
      mutationType: "pull:fast-forward",
      metadata: { taskId, worktreePath, integrationBranch, fromSha, toSha, succeeded: true },
    });
    return { kind: "clean-pull", fromSha, toSha };
  }

  const stashSha = handle.sha;
  await emitSafe({
    mutationType: "stash:push",
    metadata: { taskId, worktreePath, stashSha, stashLabel, untrackedIncluded: true },
  });

  /** Apply our entry by SHA; drop it only after a clean restore. */
  const restore = async () => {
    const applied = await applyStashBySha(worktreePath, stashSha, { timeoutMs: 20_000 });
    if (applied.ok) await dropStashBySha(worktreePath, stashSha);
    return applied;
  };

  try {
    await runGit(["pull", "--ff-only"], worktreePath, 30_000);
  } catch (pullErr: unknown) {
    const pullMessage = commandError(pullErr);
    await emitSafe({
      mutationType: "pull:fast-forward",
      metadata: { taskId, worktreePath, integrationBranch, fromSha, toSha: fromSha, succeeded: false, error: pullMessage },
    });
    const restored = await restore();
    if (!restored.ok) {
      if (restored.conflicted || isConflictMessage(restored.error)) {
        const conflictedFiles = await listConflictedFiles(worktreePath);
        await emitSafe({
          mutationType: "stash:pop-conflict",
          metadata: { taskId, worktreePath, stashSha, stashLabel, conflictedFiles, advice: "Resolve conflicts, then drop stash when complete." },
        });
        const toSha = await headSha(worktreePath);
        return { kind: "stash-pop-conflict", fromSha, toSha, stashSha, stashLabel, conflictedFiles };
      }
      return { kind: "failed", fromSha, stage: "pop", error: restored.error, stashSha, stashLabel };
    }
    return { kind: "failed", fromSha, stage: "pull", error: pullMessage, stashSha, stashLabel };
  }

  const toSha = await headSha(worktreePath);
  await emitSafe({
    mutationType: "pull:fast-forward",
    metadata: { taskId, worktreePath, integrationBranch, fromSha, toSha, succeeded: true },
  });

  const restored = await restore();
  if (restored.ok) {
    await emitSafe({
      mutationType: "stash:pop",
      metadata: { taskId, worktreePath, stashSha, stashLabel },
    });
    return { kind: "stash-pull-pop", fromSha, toSha, stashSha, stashLabel };
  }
  // Apply failed or conflicted: the entry is retained (apply never drops).
  const conflictedFiles = await listConflictedFiles(worktreePath);
  await emitSafe({
    mutationType: "stash:pop-conflict",
    metadata: { taskId, worktreePath, stashSha, stashLabel, conflictedFiles, advice: "Resolve conflicts, then drop stash when complete." },
  });
  return { kind: "stash-pop-conflict", fromSha, toSha, stashSha, stashLabel, conflictedFiles };
}
