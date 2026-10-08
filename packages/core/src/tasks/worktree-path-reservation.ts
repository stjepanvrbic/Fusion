import {createHash, randomUUID} from "node:crypto";
import {hostname} from "node:os";
import {dirname, join, resolve} from "node:path";
import {lstat, mkdir, readdir, readFile, rename, rm, rmdir, stat, unlink, writeFile} from "node:fs/promises";
import {normalizeAbsolutePath, pathIdentityKey} from "../fs/path-identity.js";

/**
 * FNXC:WorkflowLifecycle 2026-07-16-10:00:
 * Pinned worktrees are reused by independent engine processes, so archive and
 * acquisition share a host-scoped filesystem reservation. `claim/` is the
 * exclusive create-or-fail primitive; the durable state record is never
 * used as a lock because rename-over-destination does not exclude contenders.
 *
 * FNXC:WorkflowLifecycle 2026-10-07-18:06:
 * A claim must never exist without its owner, and a takeover must only ever remove the exact generation it judged stale.
 * A claim is published atomically: a private `.pending-<token>/` directory holding `<token>.json` is renamed onto `claim/`, so a crash or write failure leaves no ownerless claim.
 * Removal is generation-specific: a reclaimer renames away only the entry names it observed, then `rmdir(claim)`, which fails on a successor's non-empty claim. A stale reclaimer therefore cannot remove a successor's claim.
 * `state.json` remains the diagnostic and quarantine record beside the claim; self-healing reads it as liveness evidence, so its shape and `canonicalPath` spelling are unchanged.
 * Ownerless empty claims (legacy layout, or residue of an interrupted release or reclaim) are reclaimable after a short grace period unless a legacy held record names a live local process; a malformed owner needs the TTL plus proof the worktree is not live.
 *
 * FNXC:WorkflowLifecycle 2026-10-08-04:11:
 * On Windows a claim that a competing reclaimer is deleting (delete-pending) or that antivirus holds open answers lstat, readdir and stat with EPERM/EACCES/EBUSY.
 * That answer proves neither absence nor a live owner, so the acquirer neither publishes nor reclaims on it: it re-polls until its acquire timeout.
 *
 * FNXC:PathIdentity 2026-10-07-18:06:
 * The lock key hashes `pathIdentityKey`, so case, separator, extended-length and junction/symlink spellings of one checkout contend for one claim, including before the checkout exists.
 * Lock directories keyed by the pre-identity `resolve()` spelling are adopted once: a held or quarantined record there is treated as the prior state of the new key.
 */
export type WorktreeReservationState = "held" | "released" | "quarantined";
export interface WorktreePathReservation {
  canonicalPath: string;
  token: string;
  previousState: "free" | "quarantined";
  state: WorktreeReservationState;
  release(): Promise<void>;
  quarantine(reason: string): Promise<void>;
}
interface OwnerRecord {
  pid: number;
  hostname: string;
  startedAt: string;
  canonicalPath: string;
  token: string;
}
interface ReservationRecord extends OwnerRecord {
  state: "held" | "quarantined";
  reason?: string;
}
export interface WorktreePathReservationOptions {
  canonicalPath: string;
  worktreesDir: string;
  rootDir: string;
  isLiveWorktree?: (canonicalPath: string) => Promise<boolean>;
  reconcileQuarantined?: (canonicalPath: string) => Promise<void>;
  ttlMs?: number;
  pollMs?: number;
  acquireTimeoutMs?: number;
  /** Test seam: awaited after a claim is judged stale and before its removal. */
  __beforeReclaimForTest?: () => Promise<void>;
}

/** Owner publication is a few filesystem calls; an empty claim older than this is residue, not an in-flight owner. */
const OWNERLESS_CLAIM_GRACE_MS = 30_000;
const OWNER_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
/** Windows reports a contended or AV-scanned directory rename as EPERM/EACCES/EBUSY. */
const TRANSIENT_FS_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const LOCKS_DIRNAME = ".fusion-worktree-locks";

/**
 * Normalized absolute spelling of a worktree path. It preserves case and is not an identity: compare with `isSamePath` and key with `pathIdentityKey`.
 * Absent orphan paths stay valid inputs.
 */
export async function canonicalizeWorktreePath(path: string): Promise<string> {
  return normalizeAbsolutePath(path);
}

function containerFor(worktreesDir: string, key: string): string {
  return join(resolve(worktreesDir), LOCKS_DIRNAME, createHash("sha256").update(key).digest("hex"));
}
function paths(worktreesDir: string, canonicalPath: string) {
  const container = containerFor(worktreesDir, pathIdentityKey(canonicalPath));
  return {container, claim: join(container, "claim"), state: join(container, "state.json")};
}
/** The pre-identity layout keyed the raw `resolve()` spelling. */
function legacyStatePath(worktreesDir: string, canonicalPath: string): string {
  return join(containerFor(worktreesDir, resolve(canonicalPath)), "state.json");
}

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;

async function readRecord(statePath: string): Promise<ReservationRecord | null> {
  try {
    const value = JSON.parse(await readFile(statePath, "utf8")) as ReservationRecord;
    return value?.token && value?.canonicalPath ? value : null;
  } catch { return null; }
}
async function readOwner(ownerPath: string, expectedToken: string): Promise<OwnerRecord | null> {
  try {
    const value = JSON.parse(await readFile(ownerPath, "utf8")) as OwnerRecord;
    return value?.token === expectedToken && Number.isInteger(value.pid) && typeof value.hostname === "string" && typeof value.startedAt === "string" ? value : null;
  } catch { return null; }
}
async function writeRecord(statePath: string, record: ReservationRecord): Promise<void> {
  const temp = join(dirname(statePath), `.state-${process.pid}-${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(record), "utf8");
  for (let attempt = 0; ; attempt += 1) {
    try { await rename(temp, statePath); return; } catch (error) {
      if (!TRANSIENT_FS_CODES.has(errorCode(error) ?? "") || attempt >= 5) {
        await unlink(temp).catch(() => undefined);
        throw error;
      }
      await sleep(20 * (attempt + 1));
    }
  }
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return false;
    throw error;
  }
}
/** A transiently denied probe counts as present: absence is only proven by ENOENT/ENOTDIR. */
async function claimMayExist(claim: string): Promise<boolean> {
  try { return await exists(claim); } catch (error) {
    if (TRANSIENT_FS_CODES.has(errorCode(error) ?? "")) return true;
    throw error;
  }
}
async function removeEmptyClaim(claim: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try { await rmdir(claim); return; } catch (error) {
      const code = errorCode(error);
      // ENOTEMPTY/EEXIST: a successor already published here; leave it.
      if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") return;
      if (!TRANSIENT_FS_CODES.has(code ?? "") || attempt >= 5) return;
      await sleep(20 * (attempt + 1));
    }
  }
}
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error: unknown) {
    return errorCode(error) === "EPERM";
  }
}
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

type ClaimObservation =
  | {kind: "absent"}
  | {kind: "unobservable"}
  | {kind: "present"; entries: string[]; owner: OwnerRecord | null; ageMs: number};

async function observeClaim(claim: string): Promise<ClaimObservation> {
  try {
    const entries = await readdir(claim);
    const claimStat = await stat(claim);
    const ownerName = entries.length === 1 && OWNER_FILE.test(entries[0]!) ? entries[0]! : undefined;
    const owner = ownerName ? await readOwner(join(claim, ownerName), ownerName.slice(0, -".json".length)) : null;
    return {kind: "present", entries, owner, ageMs: Date.now() - claimStat.mtimeMs};
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return {kind: "absent"};
    if (TRANSIENT_FS_CODES.has(errorCode(error) ?? "")) return {kind: "unobservable"};
    throw error;
  }
}

type PublishOutcome = "acquired" | "contended" | "retry";

async function publishClaim(layout: ReturnType<typeof paths>, owner: OwnerRecord): Promise<PublishOutcome> {
  // An existing claim, even an empty legacy one, is never replaced: POSIX rename would silently overwrite an empty directory.
  if (await claimMayExist(layout.claim)) return "contended";
  const pending = join(layout.container, `.pending-${owner.token}`);
  await mkdir(pending);
  try {
    await writeFile(join(pending, `${owner.token}.json`), JSON.stringify(owner), "utf8");
    await rename(pending, layout.claim);
    return "acquired";
  } catch (error) {
    await rm(pending, {recursive: true, force: true}).catch(() => undefined);
    const code = errorCode(error) ?? "";
    if (code === "EEXIST" || code === "ENOTEMPTY" || TRANSIENT_FS_CODES.has(code)) {
      if (await claimMayExist(layout.claim)) return "contended";
      if (TRANSIENT_FS_CODES.has(code)) return "retry";
    }
    throw error;
  }
}

/** Remove exactly the observed generation: entry names are token-unique, and rmdir refuses a successor's non-empty claim. */
async function reclaimObservedGeneration(layout: ReturnType<typeof paths>, entries: readonly string[]): Promise<void> {
  const moved: string[] = [];
  try {
    for (const name of entries) {
      const target = join(layout.container, `.reclaim-${randomUUID()}`);
      try { await rename(join(layout.claim, name), target); moved.push(target); } catch (error) {
        const code = errorCode(error) ?? "";
        if (code === "ENOENT" || TRANSIENT_FS_CODES.has(code)) return;
        throw error;
      }
    }
    await removeEmptyClaim(layout.claim);
  } finally {
    await Promise.all(moved.map((target) => rm(target, {recursive: true, force: true}).catch(() => undefined)));
  }
}

async function isLive(options: WorktreePathReservationOptions, canonicalPath: string): Promise<boolean> {
  // Fail closed: inability to prove non-liveness never steals a claim.
  try { return await (options.isLiveWorktree?.(canonicalPath) ?? Promise.resolve(true)); } catch { return true; }
}

async function isStaleClaim(
  observation: Extract<ClaimObservation, {kind: "present"}>,
  layout: ReturnType<typeof paths>,
  options: WorktreePathReservationOptions,
  canonicalPath: string,
  ttlMs: number,
): Promise<boolean> {
  const localHost = hostname();
  const {owner} = observation;
  if (owner) {
    if (owner.hostname === localHost && !pidAlive(owner.pid)) return true;
    const age = Date.now() - Date.parse(owner.startedAt);
    return age > ttlMs && !(await isLive(options, canonicalPath));
  }
  if (observation.entries.length === 0) {
    const legacy = await readRecord(layout.state);
    if (legacy?.state === "held") {
      if (legacy.hostname === localHost && !pidAlive(legacy.pid)) return true;
      const age = Date.now() - Date.parse(legacy.startedAt);
      return age > ttlMs && !(await isLive(options, canonicalPath));
    }
    return observation.ageMs > OWNERLESS_CLAIM_GRACE_MS;
  }
  // Unreadable or unexpected claim contents: conservative TTL plus liveness evidence.
  return observation.ageMs > ttlMs && !(await isLive(options, canonicalPath));
}

async function sweepContainerResidue(container: string): Promise<void> {
  try {
    for (const name of await readdir(container)) {
      if (!name.startsWith(".pending-") && !name.startsWith(".reclaim-")) continue;
      const entry = join(container, name);
      const entryStat = await stat(entry).catch(() => undefined);
      if (entryStat && Date.now() - entryStat.mtimeMs > OWNERLESS_CLAIM_GRACE_MS) await rm(entry, {recursive: true, force: true}).catch(() => undefined);
    }
  } catch { /* best-effort hygiene */ }
}

/** Resolve the operator-safe directory containing this path's durable reservation state. */
export async function resolveWorktreePathReservationDirectory(options: Pick<WorktreePathReservationOptions, "canonicalPath" | "worktreesDir">): Promise<string> {
  const canonicalPath = await canonicalizeWorktreePath(options.canonicalPath);
  return paths(options.worktreesDir, canonicalPath).container;
}

/** Read the durable record; it is diagnostic only and does not imply ownership. */
export async function readWorktreePathReservation(options: Pick<WorktreePathReservationOptions, "canonicalPath" | "worktreesDir">): Promise<ReservationRecord | null> {
  const canonicalPath = await canonicalizeWorktreePath(options.canonicalPath);
  return readRecord(paths(options.worktreesDir, canonicalPath).state);
}

export async function acquireWorktreePathReservation(options: WorktreePathReservationOptions): Promise<WorktreePathReservation> {
  const canonicalPath = await canonicalizeWorktreePath(options.canonicalPath);
  const layout = paths(options.worktreesDir, canonicalPath);
  const legacyState = legacyStatePath(options.worktreesDir, canonicalPath);
  const pollMs = options.pollMs ?? 25;
  const timeoutMs = options.acquireTimeoutMs ?? 30_000;
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  const started = Date.now();
  await mkdir(layout.container, {recursive: true});

  for (;;) {
    const token = randomUUID();
    const owner: OwnerRecord = {pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString(), canonicalPath, token};
    const outcome = await publishClaim(layout, owner);
    if (outcome === "acquired") {
      const ownerPath = join(layout.claim, `${token}.json`);
      try {
        const prior = await readRecord(layout.state)
          ?? (legacyState !== layout.state ? await readRecord(legacyState) : null);
        await writeRecord(layout.state, {...owner, state: "held"});
        let state: WorktreeReservationState = "held";
        const settle = async (quarantineReason?: string): Promise<void> => {
          if (state !== "held") return;
          // Our generation was reclaimed by someone who judged us stale; never touch their state.
          if (!(await exists(ownerPath))) { state = "released"; return; }
          if (quarantineReason !== undefined) {
            await writeRecord(layout.state, {...owner, state: "quarantined", reason: quarantineReason});
          } else {
            const current = await readRecord(layout.state);
            if (current?.token === token) await rm(layout.state, {force: true, maxRetries: 5, retryDelay: 20});
          }
          await rm(ownerPath, {force: true, maxRetries: 5, retryDelay: 20});
          await removeEmptyClaim(layout.claim);
          state = quarantineReason !== undefined ? "quarantined" : "released";
        };
        const previousState = prior?.state === "quarantined" || prior?.state === "held" ? "quarantined" : "free";
        if (previousState === "quarantined" && options.reconcileQuarantined) {
          /*
          FNXC:WorkflowLifecycle 2026-07-16-10:00:
          A failed archive removal is retried by the successor while its exclusive
          claim is held. Re-quarantine on failure so it cannot attempt creation at
          the still-occupied pinned path.
          */
          try {
            await options.reconcileQuarantined(canonicalPath);
          } catch (error) {
            await settle(error instanceof Error ? error.message : String(error));
            throw error;
          } finally {
            if (legacyState !== layout.state) await rm(legacyState, {force: true}).catch(() => undefined);
          }
        } else if (legacyState !== layout.state && prior) {
          await rm(legacyState, {force: true}).catch(() => undefined);
        }
        void sweepContainerResidue(layout.container);
        return {canonicalPath, token, previousState, get state() { return state; }, release: () => settle(), quarantine: (reason) => settle(reason)};
      } catch (error) {
        // A failure before the handle reaches the caller must not strand a live-looking claim.
        // A quarantine settle has already removed the owner file, so this only runs for unsettled claims.
        if (await exists(ownerPath)) {
          const current = await readRecord(layout.state);
          if (current?.token === token) await rm(layout.state, {force: true}).catch(() => undefined);
          await rm(ownerPath, {force: true}).catch(() => undefined);
          await removeEmptyClaim(layout.claim);
        }
        throw error;
      }
    }

    if (outcome === "contended") {
      const observation = await observeClaim(layout.claim);
      if (observation.kind === "absent") continue;
      if (observation.kind === "present" && await isStaleClaim(observation, layout, options, canonicalPath, ttlMs)) {
        await options.__beforeReclaimForTest?.();
        await reclaimObservedGeneration(layout, observation.entries);
        continue;
      }
    }
    if (Date.now() - started >= timeoutMs) throw new Error(`Timed out acquiring worktree reservation for ${canonicalPath} after ${timeoutMs}ms`);
    await sleep(pollMs);
  }
}

export async function withWorktreePathReservation<T>(options: WorktreePathReservationOptions, fn: (reservation: WorktreePathReservation) => Promise<T>): Promise<T> {
  const reservation = await acquireWorktreePathReservation(options);
  try { return await fn(reservation); } finally { if (reservation.state === "held") await reservation.release(); }
}
