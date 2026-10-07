import { rename as fsRename } from "node:fs/promises";

/*
FNXC:WindowsAtomicWrites 2026-10-07-21:40:
On Windows a rename over an existing file fails transiently with EPERM, EACCES or EBUSY while antivirus, the search indexer
or a concurrent writer holds the target. task.json, PROMPT.md, config.json and agent bundle files are published by
temp-file-then-rename, so one such failure surfaced as a failed mutation. Retry those codes on win32 with a short bounded
backoff; POSIX rename does not wait on open handles, so it is attempted once. This mirrors the engine's
retryTransientFilesystemOperation, which core cannot import.
*/
const TRANSIENT_RENAME_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);

/** Win32 retry policy: attempts include the first; delays double from the base up to the cap (about 0.8s of waiting in all). */
export const WIN32_RENAME_RETRY_POLICY = Object.freeze({ maxAttempts: 6, baseDelayMs: 25, maxDelayMs: 400 });

export type RenameWithTransientRetryOptions = {
  platform?: NodeJS.Platform | string;
  rename?: (from: string, to: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
};

function errorCode(error: unknown): string | undefined {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Rename `from` over `to`, retrying transient Windows sharing failures; any other failure is thrown at once. */
export async function renameWithTransientRetry(from: string, to: string, options: RenameWithTransientRetryOptions = {}): Promise<void> {
  const rename = options.rename ?? fsRename;
  const sleep = options.sleep ?? defaultSleep;
  const retries = (options.platform ?? process.platform) === "win32";
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (!retries || attempt >= WIN32_RENAME_RETRY_POLICY.maxAttempts || !TRANSIENT_RENAME_CODES.has(errorCode(error) ?? "")) throw error;
      await sleep(Math.min(WIN32_RENAME_RETRY_POLICY.maxDelayMs, WIN32_RENAME_RETRY_POLICY.baseDelayMs * 2 ** (attempt - 1)));
    }
  }
}
