import { execFile } from "node:child_process";
import { selectIntegrationBranch, type ProjectSettings } from "@fusion/core";

/*
FNXC:IntegrationBranchReadiness 2026-10-11-22:50:
Every git read in this module launches git directly with an argument list; none goes through a shell.
A command string costs one extra `cmd.exe` per read on Windows, and this resolver runs at the start of every merge, worktree acquisition and recovery pass.
It is also wrong on POSIX hosts: `git for-each-ref --format=%(refname:short) <prefix>` as a `/bin/sh` command string is a syntax error at the parenthesis, so both branch lists came back empty there and inference always fell back to `main`.
The async runner takes node's callback form, so a passthrough mock of `node:child_process` observes the same calls production makes.
*/
const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 1024 * 1024;

/** Runs one git command without a shell; resolves its stdout and rejects on a non-zero exit, timeout or spawn failure. */
function runGit(rootDir: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: rootDir, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

const ORIGIN_HEAD_ARGS = ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"] as const;
const REMOTE_LIST_ARGS = ["remote"] as const;
const CURRENT_HEAD_ARGS = ["symbolic-ref", "--quiet", "--short", "HEAD"] as const;

function branchRefsArgs(refPrefix: string): string[] {
  return ["for-each-ref", "--format=%(refname:short)", refPrefix];
}

export type IntegrationBranchSettings =
  | ProjectSettings
  | (Pick<ProjectSettings, "integrationBranch"> & { baseBranch?: unknown })
  | undefined
  | null;

export const INTEGRATION_BRANCH_FALLBACK = "main";
const warnedFallbackRootDirs = new Set<string>();

function normalize(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\/origin\//, "")
    .replace(/^origin\//, "");
}

/*
FNXC:IntegrationBranchReadiness 2026-08-24-00:47:
FN-183 lets inferred fallback inspect local refs and origin's remote-tracking refs through the
shared selection ladder, but never chooses an arbitrary non-origin remote such as gitlab. When
that ladder has no candidate, preserve the actionable remote diagnostic that directs operators to
add an origin alias or configure integrationBranch explicitly.
*/
function warnFallback(rootDir: string, logger: Pick<Console, "warn">, remotes: string[] = []): void {
  if (warnedFallbackRootDirs.has(rootDir)) {
    return;
  }
  warnedFallbackRootDirs.add(rootDir);
  if (remotes.length > 0) {
    const remoteList = remotes.join(", ");
    const originState = remotes.includes("origin") ? "origin/HEAD is unset" : "origin is absent";
    logger.warn(`[integration-branch] falling back to 'main' — auto-detect checks origin/HEAD, but ${originState}; found remote ${remoteList}. Add an origin alias or set integrationBranch manually.`);
    return;
  }
  logger.warn("[integration-branch] falling back to 'main' — origin/HEAD unset and no project override");
}

function resolveFromSettings(settings: IntegrationBranchSettings): string {
  const fromIntegration = normalize(settings?.integrationBranch);
  if (fromIntegration.length > 0) {
    return fromIntegration;
  }

  return normalize((settings as { baseBranch?: unknown } | null | undefined)?.baseBranch);
}

async function resolveFromOriginHead(rootDir: string): Promise<string> {
  try {
    return normalize(await runGit(rootDir, ORIGIN_HEAD_ARGS));
  } catch {
    return "";
  }
}

function parseRemotes(stdout: string): string[] {
  return [...new Set(stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean))];
}

async function listGitRemotes(rootDir: string): Promise<string[]> {
  try {
    return parseRemotes(await runGit(rootDir, REMOTE_LIST_ARGS));
  } catch {
    return [];
  }
}

function parseBranchRefs(stdout: string, dropRemoteHead = false): string[] {
  return [...new Set(stdout
    .split(/\r?\n/)
    .map(normalize)
    .filter((branch) => branch.length > 0 && (!dropRemoteHead || branch !== "HEAD")))];
}

async function listBranchRefs(rootDir: string, refPrefix: string, dropRemoteHead = false): Promise<string[]> {
  try {
    return parseBranchRefs(await runGit(rootDir, branchRefsArgs(refPrefix)), dropRemoteHead);
  } catch {
    return [];
  }
}

/*
FNXC:IntegrationBranchReadiness 2026-08-24-00:46:
FN-183 keeps explicit project settings and origin/HEAD authoritative, then delegates every
inferred fallback to the core selection ladder shared with registration. Worktree acquisition,
merge, recovery, and branch-conflict paths have no branch naming logic beyond this resolver,
so this single boundary is their shared regression coverage rather than separate per-consumer tests.
*/
async function resolveInferredBranch(rootDir: string): Promise<ReturnType<typeof selectIntegrationBranch>> {
  const [localBranches, currentHeadOutput, remoteBranches] = await Promise.all([
    listBranchRefs(rootDir, "refs/heads/"),
    resolveCurrentHead(rootDir),
    listBranchRefs(rootDir, "refs/remotes/origin/", true),
  ]);
  return selectIntegrationBranch({
    localBranches,
    currentBranch: currentHeadOutput,
    remoteBranches,
  });
}

async function resolveCurrentHead(rootDir: string): Promise<string> {
  try {
    return normalize(await runGit(rootDir, CURRENT_HEAD_ARGS));
  } catch {
    return "";
  }
}

function warnInferredBranch(
  rootDir: string,
  logger: Pick<Console, "warn">,
  branch: string,
  source: string,
): void {
  if (branch === INTEGRATION_BRANCH_FALLBACK || warnedFallbackRootDirs.has(rootDir)) {
    return;
  }
  warnedFallbackRootDirs.add(rootDir);
  logger.warn(`[integration-branch] adopted '${branch}' from ${source} inference instead of falling back to 'main'.`);
}

/*
FNXC:IntegrationBranchReadiness 2026-10-12-02:45:
Branch resolution is asynchronous only, because the engine shares one event loop with every task it runs.
A synchronous copy of this ladder had no caller and forced every ladder change to be made twice.
A caller that cannot await must be handed the resolved branch by its own caller instead of resolving it again.
*/
export async function resolveIntegrationBranch(
  rootDir: string,
  settings: IntegrationBranchSettings,
  opts: { logger?: Pick<Console, "warn"> } = {},
): Promise<string> {
  const logger = opts.logger ?? console;

  const fromSettings = resolveFromSettings(settings);
  if (fromSettings.length > 0) {
    return fromSettings;
  }

  const fromOrigin = await resolveFromOriginHead(rootDir);
  if (fromOrigin.length > 0) {
    return fromOrigin;
  }

  const inferred = await resolveInferredBranch(rootDir);
  if (inferred) {
    warnInferredBranch(rootDir, logger, inferred.branch, inferred.source);
    return inferred.branch;
  }

  const remotes = await listGitRemotes(rootDir);
  warnFallback(rootDir, logger, remotes);
  return INTEGRATION_BRANCH_FALLBACK;
}

export function __resetIntegrationBranchCacheForTests(): void {
  warnedFallbackRootDirs.clear();
}
