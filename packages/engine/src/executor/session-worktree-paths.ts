/**
 * FNXC:CodeOrganization 2026-08-03-07:45:
 * Session worktree path helpers peeled from executor.ts.
 */
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { canonicalizePath as canonicalizePathIdentity, type Settings } from "@fusion/core";
import type { GitRepoDetection } from "../worktree/worktree-pool.js";
import { resolveWorktreesDir } from "../worktree/worktree-paths.js";

/**
 * FNXC:PathIdentity 2026-10-08-16:08:
 * Delegates to the shared `@fusion/core` canonicalizer (`realpathSync.native`), which expands Windows 8.3 short aliases and on-disk case so the result matches what git reports.
 * JavaScript `realpathSync` kept `RUNNER~1`-style aliases, so a worktree spelled short never equalled the git-reported root (KB-082). Never throws.
 */
export function canonicalizePath(path: string): string {
  return canonicalizePathIdentity(path);
}

/*
FNXC:CodeOrganization 2026-08-03-12:15:
PR #3317 security feedback: do not interpolate rootDir into the copy-paste safe.directory remedy.
A path with quotes/metacharacters can alter the command if pasted into a shell. Keep the real path
in the descriptive sentence only; use a fixed <project-directory> placeholder in the shell command.
*/
export function formatGitRepositoryDetectionError(rootDir: string, detection: Extract<GitRepoDetection, { status: "error" }>): string {
  const stderr = detection.stderr.trim() || "git rev-parse --git-dir failed without stderr";
  const remedy = detection.reason === "dubious-ownership"
    ? " Resolve Git safe-directory ownership with: git config --global --add safe.directory <project-directory>"
    : "";
  return `Git repository detection failed for project directory "${rootDir}". Fusion could not verify worktree support because git reported: ${stderr}.${remedy}`;
}

export function buildSessionWorktreePathRegex(rootDir: string, settings: Partial<Settings>): RegExp {
  const configuredBase = resolveWorktreesDir(rootDir, settings).split(/[\\/]/).filter(Boolean).pop() ?? ".worktrees";
  const escapedBase = configuredBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`([A-Za-z]:)?[^"'\\s]*(?:\\.worktrees|${escapedBase})[\\\\/][^"'\\s]+`, "g");
}

export function normalizeWorktreePath(pathValue: string): string {
  return resolvePath(pathValue).replace(/\\/g, "/").replace(/\/+$/, "");
}

export async function extractPersistedSessionWorktreePath(
  sessionFile: string,
  rootDir: string,
  settings: Partial<Settings>,
): Promise<string | null> {
  try {
    const content = await readFile(sessionFile, "utf-8");
    const matches = content.match(buildSessionWorktreePathRegex(rootDir, settings)) ?? [];
    if (matches.length === 0) return null;

    const normalizedCounts = new Map<string, number>();
    for (const match of matches) {
      const normalized = normalizeWorktreePath(match);
      normalizedCounts.set(normalized, (normalizedCounts.get(normalized) ?? 0) + 1);
    }

    let best: { path: string; count: number } | null = null;
    for (const [path, count] of normalizedCounts.entries()) {
      if (!best || count > best.count) best = { path, count };
    }
    return best?.path ?? null;
  } catch {
    return null;
  }
}

export function isSessionWorktreeCompatible(
  persistedWorktreePath: string | null,
  currentWorktreePath: string,
): boolean {
  if (!persistedWorktreePath) return true;
  return persistedWorktreePath === normalizeWorktreePath(currentWorktreePath);
}
