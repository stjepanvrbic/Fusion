import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/*
FNXC:EngineTests 2026-10-08-08:47:
KB-056 root cause of the executor-task-done-summary quarantine (register entry 28). Worktree acquisition reserves the
pinned path through `acquireWorktreePathReservation`, which writes a REAL claim under
`<worktreesDir>/.fusion-worktree-locks/<sha256(path)>/claim` with real `node:fs/promises`. About 80 engine
files run `new TaskExecutor(store, "/tmp/test")` with task FN-001, so they all contend for one claim directory.
engine-default runs `pool: "threads"`, so every worker shares one `process.pid`, and a claim whose owner pid is
alive is never stale (no `isLiveWorktree` probe means liveness is assumed). A test file whose executor was still
running in the background (an unbounded in-place retry loop, because its mock store never persists
`taskDoneRetryCount`) when vitest tore its worker down abandoned a held claim. The next FN-001 file then blocked
in acquisition for the 30 s `acquireTimeoutMs` (its first case timed out), while that stalled run kept the
process-wide graph-routing entry, so the remaining cases' `execute()` were dropped as duplicates (`null`).

The harness therefore gives every test file its own reservation domain: each distinct `worktreesDir` maps to a
directory under one per-module temp root, so real reservation semantics (exclusive claims, contention, quarantine
reconciliation) still hold inside a file while no other file's claims can be observed. `canonicalPath` is never
rewritten, so worktree path assertions are unaffected. Production keeps the shared directory: one engine process
releases its claims in `finally`, and a dead process's claims are reclaimed by pid.
*/

/** Shape shared by the `@fusion/core` reservation exports this module wraps. */
type ReservationOptions = { worktreesDir: string } & Record<string, unknown>;
type ReservationFn = (options: ReservationOptions, ...rest: unknown[]) => unknown;

/** Reservation exports whose `worktreesDir` is remapped into the per-file domain. */
export const ISOLATED_RESERVATION_EXPORTS = [
  "acquireWorktreePathReservation",
  "withWorktreePathReservation",
  "readWorktreePathReservation",
  "resolveWorktreePathReservationDirectory",
] as const;

/**
 * Exports that create the lock container in production. Their wrapper still creates the real `worktreesDir` first,
 * so an unusable root (for example a file) fails acquisition with the same ENOTDIR/EACCES as production; only the
 * claim state moves into the per-file domain.
 */
const CREATING_RESERVATION_EXPORTS = new Set<string>(["acquireWorktreePathReservation", "withWorktreePathReservation"]);

/** Prefix of every per-file lock root; cleanup targets this prefix only. */
export const ISOLATED_RESERVATION_ROOT_PREFIX = "fusion-engine-test-locks-";

let isolatedRoot: Promise<string> | undefined;

function isolatedReservationRoot(): Promise<string> {
  isolatedRoot ??= mkdtemp(join(tmpdir(), ISOLATED_RESERVATION_ROOT_PREFIX));
  return isolatedRoot;
}

/** Map a real `worktreesDir` to this module instance's private reservation domain. */
export async function isolatedWorktreesDir(worktreesDir: string): Promise<string> {
  const key = createHash("sha256").update(resolve(worktreesDir)).digest("hex").slice(0, 16);
  return join(await isolatedReservationRoot(), key);
}

/**
 * Wrap the `@fusion/core` reservation exports so every call uses the per-file domain.
 */
export function isolateWorktreePathReservations(actual: Record<string, unknown>): Record<string, unknown> {
  const wrapped: Record<string, unknown> = {};
  for (const name of ISOLATED_RESERVATION_EXPORTS) {
    const original = actual[name] as ReservationFn | undefined;
    if (typeof original !== "function") continue;
    const creates = CREATING_RESERVATION_EXPORTS.has(name);
    wrapped[name] = async (options: ReservationOptions, ...rest: unknown[]) => {
      if (creates) await mkdir(options.worktreesDir, { recursive: true });
      return original({ ...options, worktreesDir: await isolatedWorktreesDir(options.worktreesDir) }, ...rest);
    };
  }
  return wrapped;
}

/**
 * Build the harness `@fusion/core` mock: the actual module with the reservation exports isolated.
 * vitest throws on reading an export a factory did not return, while the real module yields `undefined`. The
 * engine-core gate aliases `@fusion/core` to a deliberately narrow barrel, so the proxy reports every string key
 * as present and keeps the real-module `undefined` instead of turning a narrow barrel into a throw.
 */
export function createIsolatedCoreMock(actual: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...actual, ...isolateWorktreePathReservations(actual) };
  return new Proxy(merged, {
    has: (target, prop) => (typeof prop === "string" && prop !== "then") || Reflect.has(target, prop),
  });
}

/** Best-effort removal of this module instance's lock root (a known path, never a temp-dir scan). */
export async function removeIsolatedReservationRoot(): Promise<void> {
  if (!isolatedRoot) return;
  const root = await isolatedRoot.catch(() => undefined);
  if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
