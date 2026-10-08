/**
 * FNXC:WorktreeStashIsolation 2026-10-08-08:29:
 * Git keeps ONE stash reflog (`refs/stash`) per repository, shared by the primary checkout and every linked worktree (including `.fusion/worktrees/*` and operator sessions).
 * Any position-based stash operation — `git stash pop`, `stash@{N}`, `rev-parse stash@{0}`, or a ref parsed from `stash push` output — races every other session in the repository.
 * On 2026-10-08 (KB-008) two sibling worktrees ran push/pop concurrently: each popped the other's entry, one session's edits vanished and foreign changes (one conflicted) appeared in its tree.
 *
 * Contract enforced here: an entry is addressed by a unique label at creation and by its commit SHA afterwards.
 * Restore is always `git stash apply <sha>` (never pop, never an implicit drop).
 * Drop verifies the positional ref still resolves to our SHA, then verifies git's `Dropped <ref> (<sha>)` report; a foreign entry dropped in the remaining window is immediately re-stored under its original subject.
 * Every git call uses `execFile` argument arrays (no shell strings) so labels survive Windows and POSIX quoting unchanged.
 * `src/__tests__/no-bare-git-stash.test.ts` ratchets the rule across `packages/engine/src` and `packages/cli/src`; this module is the only place allowed to issue `stash drop`.
 */
import * as childProcess from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const DEFAULT_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 16 * 1024 * 1024;
const DROP_ATTEMPTS = 5;

/** Result of a single git invocation through a {@link TaggedStashGitRunner}. */
export interface TaggedStashGitResult {
  stdout: string;
  stderr: string;
}

/**
 * Runs `git <args>` in `cwd`. Rejects on non-zero exit with an error carrying `stdout`/`stderr`.
 * Injectable so tests can interleave a foreign stash push at an exact point of a drop.
 */
export type TaggedStashGitRunner = (cwd: string, args: string[], timeoutMs?: number) => Promise<TaggedStashGitResult>;

/*
 * `execFile` is resolved lazily through the namespace import so modules whose
 * tests mock `node:child_process` with only `exec`/`execSync` still load.
 */
export const defaultTaggedStashGitRunner: TaggedStashGitRunner = async (cwd, args, timeoutMs = DEFAULT_TIMEOUT_MS) => {
  const run = promisify(childProcess.execFile) as unknown as (
    file: string,
    a: string[],
    o: object,
  ) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;
  const result = await run("git", args, { cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: "utf-8", windowsHide: true });
  return { stdout: String(result?.stdout ?? ""), stderr: String(result?.stderr ?? "") };
};

/** Thrown when a pushed entry cannot be resolved to exactly one SHA by its label. The entry (if any) is left untouched. */
export class TaggedStashUnresolvedError extends Error {
  readonly label: string;
  readonly matchCount: number;
  constructor(label: string, matchCount: number) {
    super(`stash entry labelled "${label}" could not be resolved to a single SHA (${matchCount} matches); refusing to guess a positional ref`);
    this.name = "TaggedStashUnresolvedError";
    this.label = label;
    this.matchCount = matchCount;
  }
}

export interface TaggedStashHandle {
  sha: string;
  label: string;
}

export interface TaggedStashLog {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
}

interface StashListEntry {
  sha: string;
  ref: string;
  subject: string;
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const e = err as Error & { stdout?: unknown; stderr?: unknown };
    return [e.stderr, e.stdout, e.message].map((v) => (v == null ? "" : String(v).trim())).filter(Boolean).join("\n") || e.message;
  }
  return String(err);
}

/** Append a collision-resistant nonce so concurrent sessions never share a label. */
export function makeUniqueStashLabel(base: string): string {
  return `${base}:${Date.now()}-${randomBytes(4).toString("hex")}`;
}

async function listStashEntries(cwd: string, runner: TaggedStashGitRunner): Promise<StashListEntry[]> {
  const { stdout } = await runner(cwd, ["stash", "list", "--format=%H%x09%gd%x09%gs"], LIST_TIMEOUT_MS);
  const entries: StashListEntry[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed.trim()) continue;
    const [sha, ref, ...rest] = trimmed.split("\t");
    if (!sha || !ref) continue;
    entries.push({ sha: sha.trim(), ref: ref.trim(), subject: rest.join("\t") });
  }
  return entries;
}

/** A stash subject matches a label when it is exactly the label (`stash store -m`) or ends with `: <label>` (`stash push -m`). */
function subjectMatchesLabel(subject: string, label: string): boolean {
  return subject === label || subject.endsWith(`: ${label}`);
}

/**
 * Push a labelled stash entry and resolve it to its SHA by label.
 * Returns `null` when git reports there was nothing to save.
 * Throws the git error when the push itself fails, and {@link TaggedStashUnresolvedError} when exactly one entry with the label cannot be found — never falls back to `stash@{0}`.
 */
export async function pushTaggedStash(
  cwd: string,
  label: string,
  opts: { includeUntracked?: boolean; runner?: TaggedStashGitRunner; timeoutMs?: number } = {},
): Promise<TaggedStashHandle | null> {
  const runner = opts.runner ?? defaultTaggedStashGitRunner;
  // One array literal so the no-bare-git-stash guard can see the `-m` label.
  const args = ["stash", "push", ...(opts.includeUntracked ? ["--include-untracked"] : []), "-m", label];
  const { stdout, stderr } = await runner(cwd, args, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (`${stdout}\n${stderr}`.includes("No local changes to save")) return null;
  let listed: StashListEntry[];
  try {
    listed = await listStashEntries(cwd, runner);
  } catch {
    // The entry was created but cannot be listed: it exists, unaddressed.
    throw new TaggedStashUnresolvedError(label, 0);
  }
  const matches = listed.filter((e) => subjectMatchesLabel(e.subject, label));
  if (matches.length !== 1) throw new TaggedStashUnresolvedError(label, matches.length);
  return { sha: matches[0]!.sha, label };
}

export type ApplyStashResult = { ok: true } | { ok: false; conflicted: boolean; error: string };

/** `git stash apply <sha>` — never pops and never drops, so a failed restore keeps the entry. */
export async function applyStashBySha(
  cwd: string,
  sha: string,
  opts: { runner?: TaggedStashGitRunner; timeoutMs?: number } = {},
): Promise<ApplyStashResult> {
  const runner = opts.runner ?? defaultTaggedStashGitRunner;
  try {
    await runner(cwd, ["stash", "apply", sha], opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return { ok: true };
  } catch (err: unknown) {
    const error = errorText(err);
    let conflicted = /CONFLICT|Merge conflict|could not apply/.test(error);
    if (!conflicted) {
      try {
        const { stdout } = await runner(cwd, ["diff", "--name-only", "--diff-filter=U"], LIST_TIMEOUT_MS);
        conflicted = stdout.trim().length > 0;
      } catch {
        // best-effort; conflicted stays false
      }
    }
    return { ok: false, conflicted, error };
  }
}

/** Resolve a stash SHA to its CURRENT positional ref (positions shift on every push/drop). Null when absent or unlistable. */
export async function findStashRefBySha(
  cwd: string,
  sha: string,
  opts: { runner?: TaggedStashGitRunner } = {},
): Promise<string | null> {
  try {
    const entry = (await listStashEntries(cwd, opts.runner ?? defaultTaggedStashGitRunner)).find((e) => e.sha === sha);
    return entry?.ref ?? null;
  } catch {
    return null;
  }
}

async function subjectForCommit(cwd: string, sha: string, runner: TaggedStashGitRunner): Promise<string> {
  try {
    return (await runner(cwd, ["log", "-1", "--format=%s", sha], LIST_TIMEOUT_MS)).stdout.trim() || `restored stash ${sha}`;
  } catch {
    return `restored stash ${sha}`;
  }
}

/**
 * Drop exactly the entry whose commit is `sha`.
 * Returns `{ dropped: true }` when our SHA is (or already was) absent from the list.
 * Never leaves a foreign entry dropped: git's drop report is checked and a mis-dropped entry is re-stored under its original subject before retrying.
 */
export async function dropStashBySha(
  cwd: string,
  sha: string,
  opts: { log?: TaggedStashLog; runner?: TaggedStashGitRunner } = {},
): Promise<{ dropped: boolean; reason?: string }> {
  const runner = opts.runner ?? defaultTaggedStashGitRunner;
  const log = opts.log ?? {};
  const short = sha.slice(0, 7);
  let lastReason = "exhausted retry attempts";
  for (let attempt = 0; attempt < DROP_ATTEMPTS; attempt++) {
    let entries: StashListEntry[];
    try {
      entries = await listStashEntries(cwd, runner);
    } catch (err: unknown) {
      lastReason = errorText(err);
      log.warn?.(`stash list failed (${lastReason}) on drop attempt ${attempt + 1} — retrying`);
      continue;
    }
    const ours = entries.find((e) => e.sha === sha);
    if (!ours) {
      log.debug?.(`autostash ${short} no longer in stash list (already dropped)`);
      return { dropped: true };
    }
    const ref = ours.ref;

    // Defend against the index-shift race: the ref must still resolve to our SHA.
    let refSha = "";
    try {
      refSha = (await runner(cwd, ["rev-parse", ref], LIST_TIMEOUT_MS)).stdout.trim();
    } catch (err: unknown) {
      lastReason = errorText(err);
      log.warn?.(`rev-parse ${ref} failed (${lastReason}) on drop attempt ${attempt + 1} — retrying`);
      continue;
    }
    if (refSha !== sha) {
      log.debug?.(`autostash ${short} shifted off ${ref} (now ${refSha.slice(0, 7)}); re-resolving`);
      continue;
    }

    let dropOutput: string;
    try {
      const out = await runner(cwd, ["stash", "drop", ref], DEFAULT_TIMEOUT_MS);
      dropOutput = `${out.stdout}\n${out.stderr}`;
    } catch (err: unknown) {
      lastReason = errorText(err);
      if (attempt === DROP_ATTEMPTS - 1) {
        log.warn?.(`failed to drop autostash ${ref} after ${attempt + 1} attempts (${lastReason}) — stash will linger in stash list`);
        return { dropped: false, reason: lastReason };
      }
      log.warn?.(`drop ${ref} attempt ${attempt + 1} failed (${lastReason}) — retrying`);
      continue;
    }

    // Post-drop verification: a sibling push between rev-parse and drop shifts
    // `ref` onto a foreign entry. Identify what git actually dropped.
    const reported = /Dropped\s+\S+\s+\(([0-9a-f]{7,64})\)/i.exec(dropOutput)?.[1];
    let droppedSha = reported ?? "";
    if (droppedSha && droppedSha.length < sha.length) {
      if (sha.startsWith(droppedSha)) droppedSha = sha;
      else {
        try {
          droppedSha = (await runner(cwd, ["rev-parse", droppedSha], LIST_TIMEOUT_MS)).stdout.trim() || droppedSha;
        } catch {
          // keep the abbreviated SHA; `stash store` accepts it
        }
      }
    }
    if (droppedSha === sha) return { dropped: true };
    if (droppedSha) {
      const subject = entries.find((e) => e.sha === droppedSha)?.subject ?? await subjectForCommit(cwd, droppedSha, runner);
      try {
        await runner(cwd, ["stash", "store", "-m", subject, droppedSha], DEFAULT_TIMEOUT_MS);
        log.warn?.(`drop of ${ref} removed foreign stash ${droppedSha.slice(0, 7)} instead of ${short}; re-stored it ("${subject}") and retrying`);
      } catch (err: unknown) {
        log.warn?.(`drop of ${ref} removed foreign stash ${droppedSha.slice(0, 7)} and re-storing it failed (${errorText(err)}); recover with: git stash store -m "${subject}" ${droppedSha}`);
      }
      lastReason = `dropped foreign entry ${droppedSha.slice(0, 7)} (re-stored)`;
      continue;
    }
    // Unparseable report: diff the list. Our SHA leaving it is the only acceptable
    // proof; any other pre-drop entry that vanished is re-stored.
    let after: StashListEntry[];
    try {
      after = await listStashEntries(cwd, runner);
    } catch (err: unknown) {
      lastReason = errorText(err);
      continue;
    }
    const afterShas = new Set(after.map((e) => e.sha));
    for (const lost of entries) {
      if (lost.sha === sha || afterShas.has(lost.sha)) continue;
      try {
        await runner(cwd, ["stash", "store", "-m", lost.subject, lost.sha], DEFAULT_TIMEOUT_MS);
        log.warn?.(`drop of ${ref} removed foreign stash ${lost.sha.slice(0, 7)}; re-stored it ("${lost.subject}")`);
      } catch (err: unknown) {
        log.warn?.(`re-storing foreign stash ${lost.sha.slice(0, 7)} failed (${errorText(err)}); recover with: git stash store -m "${lost.subject}" ${lost.sha}`);
      }
    }
    if (!afterShas.has(sha)) return { dropped: true };
    lastReason = "drop report unparseable and entry still listed";
    log.warn?.(`drop ${ref} attempt ${attempt + 1}: ${lastReason} — retrying`);
  }
  return { dropped: false, reason: lastReason };
}
