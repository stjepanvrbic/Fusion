/*
FNXC:WorktreeCleanup 2026-08-20-02:04:
AI-merge clean rooms can retain Windows handle locks or read-only Git files after dependency setup. This helper owns the bounded filesystem retry only; call sites retain liveness, age, audit, and Git-registration decisions so a retry can never expand deletion authority.

Node's internal rm retry is intentionally not combined with this loop: externally controlled attempts make audit results observable and keep tests deterministic without real sleeps.
*/
import { chmod as chmodAsync, readdir } from "node:fs/promises";

const RETRYABLE_REMOVAL_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY", "EMFILE", "ENFILE"]);

type RemovalError = Error & { code?: unknown; stderr?: unknown };
type RemovalOptions = { recursive: true; force: true };

export type DirectoryRemovalResult = {
  removed: boolean;
  attempts: number;
  benignAbsent: boolean;
  lastCode?: string;
  lastError?: string;
  /** Original failure is retained for consumers whose established contract rethrows it. */
  lastFailure?: unknown;
};

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as RemovalError).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

function errorDescription(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = error && typeof error === "object" ? (error as RemovalError).stderr : undefined;
  return typeof stderr === "string" && stderr.trim() ? `${message}: ${stderr.trim()}` : message;
}

/** Shared idempotency classification for Git's stale registration and fs ENOENT outcomes. */
export function isBenignAbsentRemovalError(error: unknown): boolean {
  if (errorCode(error) === "ENOENT") return true;
  return /is not a working tree|No such file or directory|spawn\s+.*\bENOENT\b/i.test(errorDescription(error));
}

/** Retry errno failures rather than version-specific Git wording. */
export function isRetryableRemovalError(error: unknown): boolean {
  return RETRYABLE_REMOVAL_CODES.has(errorCode(error) ?? "");
}

async function clearReadOnlyAttributes(
  path: string,
  chmod: (path: string, mode: number) => void | Promise<void>,
): Promise<void> {
  try {
    await chmod(path, 0o700);
  } catch {
    // A concurrent delete or an unchangeable child must not hide the original removal retry.
  }

  try {
    const children = await readdir(path, { withFileTypes: true });
    // Worktree contents are task-controlled; never follow a repository symlink while restoring writability.
    await Promise.all(children.filter((child) => !child.isSymbolicLink()).map((child) => clearReadOnlyAttributes(`${path}/${child.name}`, chmod)));
  } catch {
    // The path may have disappeared or may not be readable while an external handle drains.
  }
}

/*
FNXC:WorktreeCleanup 2026-10-07-15:11:
Windows keeps handles to a just-deleted checkout open for seconds (antivirus and indexer scans, exiting
agent child processes), so the former ~1s linear retry window ended before they drained and every AI
merge clean room logged "Directory not empty". Win32 now uses exponential backoff bounded by a ~10s
total wait; POSIX keeps its ~1s window because its unlink semantics do not wait on open handles. The
budget counts planned sleeps rather than wall-clock time so injected sleeps keep tests deterministic.
*/
export type FilesystemRetryPolicy = {
  /** Upper bound on operation attempts, including the first. */
  maxAttempts: number;
  /** First retry delay; each later delay doubles up to `maxDelayMs`. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** Total planned sleep across all retries. */
  budgetMs: number;
};

export const WIN32_FILESYSTEM_RETRY_POLICY: Readonly<FilesystemRetryPolicy> = Object.freeze({
  maxAttempts: 12,
  baseDelayMs: 100,
  maxDelayMs: 2_000,
  budgetMs: 10_000,
});

export const POSIX_FILESYSTEM_RETRY_POLICY: Readonly<FilesystemRetryPolicy> = Object.freeze({
  maxAttempts: 5,
  baseDelayMs: 100,
  maxDelayMs: 400,
  budgetMs: 1_100,
});

export function filesystemRetryPolicyFor(platform: NodeJS.Platform | string = process.platform): FilesystemRetryPolicy {
  return { ...(platform === "win32" ? WIN32_FILESYSTEM_RETRY_POLICY : POSIX_FILESYSTEM_RETRY_POLICY) };
}

/** Delay before the next attempt, or undefined once the attempt or wait budget is spent. */
function nextRetryDelayMs(policy: FilesystemRetryPolicy, completedAttempts: number, waitedMs: number): number | undefined {
  if (completedAttempts >= policy.maxAttempts) return undefined;
  const delay = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (completedAttempts - 1));
  return waitedMs + delay > policy.budgetMs ? undefined : delay;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type TransientFilesystemRetryResult<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; error: unknown; attempts: number };

/**
 * Bounded retry for one filesystem operation that can fail while external handles drain. Only errors the
 * caller classifies as transient are retried; every other failure is returned after one attempt.
 */
export async function retryTransientFilesystemOperation<T>(input: {
  operation: (attempt: number) => Promise<T>;
  isRetryable: (error: unknown) => boolean;
  policy?: FilesystemRetryPolicy;
  platform?: NodeJS.Platform | string;
  sleep?: (ms: number) => void | Promise<void>;
  beforeRetry?: (error: unknown, attempt: number, delayMs: number) => void | Promise<void>;
}): Promise<TransientFilesystemRetryResult<T>> {
  const policy = input.policy ?? filesystemRetryPolicyFor(input.platform);
  const sleep = input.sleep ?? defaultSleep;
  let waitedMs = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      return { ok: true, value: await input.operation(attempt), attempts: attempt };
    } catch (error) {
      const delay = input.isRetryable(error) ? nextRetryDelayMs(policy, attempt, waitedMs) : undefined;
      if (delay === undefined) return { ok: false, error, attempts: attempt };
      await input.beforeRetry?.(error, attempt, delay);
      await sleep(delay);
      waitedMs += delay;
    }
  }
}

export async function removeDirectoryWithRetry(input: {
  path: string;
  /** Explicit attempt cap; replaces the platform wait budget. */
  attempts?: number;
  /** Explicit first retry delay. */
  backoffMs?: number;
  rm: (path: string, options: RemovalOptions) => void | Promise<void>;
  chmod?: (path: string, mode: number) => void | Promise<void>;
  sleep?: (ms: number) => void | Promise<void>;
  platform?: NodeJS.Platform | string;
  log?: (message: string) => void;
}): Promise<DirectoryRemovalResult> {
  const platform = input.platform ?? process.platform;
  const policy = filesystemRetryPolicyFor(platform);
  if (input.attempts !== undefined) {
    policy.maxAttempts = Math.max(1, Math.trunc(input.attempts));
    policy.budgetMs = Number.POSITIVE_INFINITY;
  }
  if (input.backoffMs !== undefined) {
    policy.baseDelayMs = Math.max(0, Math.trunc(input.backoffMs));
    policy.maxDelayMs = Math.max(policy.maxDelayMs, policy.baseDelayMs);
  }
  const chmod = input.chmod ?? chmodAsync;
  let benignAbsent: unknown;

  const result = await retryTransientFilesystemOperation({
    policy,
    sleep: input.sleep,
    isRetryable: isRetryableRemovalError,
    operation: async () => {
      try {
        await input.rm(input.path, { recursive: true, force: true });
      } catch (error) {
        if (!isBenignAbsentRemovalError(error)) throw error;
        benignAbsent = error;
      }
    },
    beforeRetry: async (error, attempt) => {
      if (platform === "win32" && (errorCode(error) === "EPERM" || errorCode(error) === "EACCES")) {
        await clearReadOnlyAttributes(input.path, chmod);
      }
      input.log?.(`retrying removal of ${input.path} after ${errorCode(error) ?? "unknown"} (attempt ${attempt})`);
    },
  });

  if (result.ok) {
    return benignAbsent === undefined
      ? { removed: true, attempts: result.attempts, benignAbsent: false }
      : { removed: true, attempts: result.attempts, benignAbsent: true, lastCode: errorCode(benignAbsent), lastError: errorDescription(benignAbsent) };
  }
  return {
    removed: false,
    attempts: result.attempts,
    benignAbsent: false,
    lastCode: errorCode(result.error),
    lastError: errorDescription(result.error),
    lastFailure: result.error,
  };
}
