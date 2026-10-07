/**
 * CliResumeCoordinator — engine-restart recovery for CLI agent sessions
 * (CLI Agent Executor, U8).
 *
 * On engine start, sessions persisted as live (starting / ready / busy /
 * waitingOnInput) were orphaned by the engine's death — there is no live PTY
 * behind them. This coordinator finds those records, classifies them as
 * `engineDeath`, and queues a resume that respects the session-manager
 * concurrency ceiling.
 *
 * Resume semantics (KTD — termination taxonomy, resume-the-CLI):
 * - Eligibility: ONLY `crashed` and `engineDeath` are resume-eligible
 *   (`isResumeEligible`). `killed` / `userExited` are never auto-resumed;
 *   `authFailed` and `completed` are never resumed. A record found live on
 *   restart is reclassified to `engineDeath` (it had no chance to record a
 *   terminal reason), making it eligible.
 * - Worktree-existence precondition: the recorded worktree MUST still exist —
 *   a missing worktree routes the session to `needsAttention`, NEVER a CLI
 *   spawned into a vanished directory.
 * - Dirty-tree detection: a dirty `git status` is logged and flagged on the
 *   session record (under `autonomyPosture.resumeDirtyWorktree`), then resume
 *   PROCEEDS — the flag surfaces to the UI.
 * - Relaunch: via the manager's resume path (adapter `buildResume` with the
 *   recorded `nativeSessionId`, in the recorded worktree) with the launch
 *   settings recorded at the original launch. Telemetry is re-attached BEFORE
 *   the relaunch (a fresh hook token + scripts via the hub) so the CLI starts
 *   with its hooks. The coordinator injects no prompt itself: the task's
 *   re-dispatched cli-agent node adopts the resumed session
 *   (`claimResumedSession`) and re-drives it with a continuation prompt.
 * - Attempt cap: 2 attempts with backoff (tracked on `resumeAttempts`), counting
 *   every attempt, successful or not, across engine restarts.
 *   Exhaustion, an adapter without resume support, a missing vendor session
 *   store, or an immediate spawn error route to `needsAttention` (a permanent
 *   failure path, NOT an infinite retry loop).
 *
 * The coordinator NEVER imports dashboard code. The worktree-existence check
 * and the dirty-tree probe are injected seams so tests need no real git/FS.
 */

import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CliSession, CliSessionStore, CliTerminationReason } from "@fusion/core";
import type { CliSessionManager } from "./session-manager.js";
import {
  CliConcurrencyLimitError,
  CliResumeUnsupportedError,
  CliSessionAlreadyLiveError,
  recordedLaunchSettings,
} from "./session-manager.js";
import type { CliAdapterRegistry } from "./adapter.js";
import { isResumeEligible } from "./state-machine.js";

const execFileAsync = promisify(execFile);

/** Persisted-as-live states that, found on restart, imply an orphaned PTY. */
const ORPHANED_LIVE_STATES = new Set<CliSession["agentState"]>([
  "starting",
  "ready",
  "busy",
  "waitingOnInput",
]);

/** Default resume attempt cap (KTD = 2). */
export const DEFAULT_MAX_RESUME_ATTEMPTS = 2;
/** Default base backoff (ms) between resume attempts; doubled per attempt. */
export const DEFAULT_RESUME_BACKOFF_BASE_MS = 1000;

/** Outcome of a single session's resume disposition. */
export type ResumeDisposition =
  | "resumed"
  | "needsAttention-missingWorktree"
  | "needsAttention-ineligible"
  | "needsAttention-exhausted"
  | "needsAttention-resumeUnsupported"
  | "needsAttention-spawnError"
  | "skipped-noCapacity"
  | "skipped-superseded";

export interface ResumeResult {
  sessionId: string;
  taskId: string | null;
  disposition: ResumeDisposition;
  /** Whether the worktree was dirty at resume (flag also persisted on the record). */
  dirtyWorktree?: boolean;
  /** Reason string for needsAttention dispositions. */
  reason?: string;
}

export interface CliResumeCoordinatorOptions {
  store: CliSessionStore;
  manager: CliSessionManager;
  registry: CliAdapterRegistry;
  /**
   * Re-attach telemetry for a session about to be resumed — typically mints a
   * fresh hook token and writes the hook scripts via the TelemetryHub. Called
   * BEFORE the relaunch so the returned hook launch settings reach the CLI.
   * Best-effort; a throw is logged and the resume proceeds without hooks.
   */
  reattachTelemetry?: (session: CliSession) => ResumeTelemetry | void | Promise<ResumeTelemetry | void>;
  /** Undo `reattachTelemetry` when the relaunch then fails (invalidate the minted token). */
  detachTelemetry?: (session: CliSession) => void;
  /** Max resume attempts before needsAttention. Default 2 (KTD). */
  maxResumeAttempts?: number;
  /** Base backoff (ms); doubled per prior attempt. Default 1000. */
  resumeBackoffBaseMs?: number;
  /** Worktree-existence probe (injected for tests). Default `fs.existsSync`. */
  worktreeExists?: (worktreePath: string) => boolean;
  /**
   * Dirty-tree probe (injected for tests). Returns true when `git status` shows
   * uncommitted changes. Default: runs `git status --porcelain` in the worktree.
   */
  isWorktreeDirty?: (worktreePath: string) => Promise<boolean>;
  /** Best-effort logger. */
  log?: (msg: string) => void;
}

/** What `reattachTelemetry` hands back for the relaunch. */
export interface ResumeTelemetry {
  /** Scratch dir holding the session's hook scripts; the adopting task session cleans it up. */
  hookDir?: string;
  /** Hook launch settings (script paths) merged over the recorded launch settings. */
  settings?: Record<string, unknown>;
}

/** A session this coordinator resumed in this engine run, waiting for its task to adopt it. */
export interface ResumedCliSession {
  sessionId: string;
  hookDir: string | null;
}

/** Default dirty-tree probe: `git status --porcelain` is non-empty. */
async function defaultIsWorktreeDirty(worktreePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: worktreePath,
    });
    return stdout.trim().length > 0;
  } catch {
    // Not a git worktree / git unavailable: treat as not-dirty (don't block resume).
    return false;
  }
}

export class CliResumeCoordinator {
  private readonly store: CliSessionStore;
  private readonly manager: CliSessionManager;
  private readonly registry: CliAdapterRegistry;
  private readonly reattachTelemetry?: (session: CliSession) => ResumeTelemetry | void | Promise<ResumeTelemetry | void>;
  private readonly detachTelemetry?: (session: CliSession) => void;
  /** Resumed-but-unowned sessions, keyed by session id, for `claimResumedSession`. */
  private readonly resumedUnowned = new Map<string, { taskId: string | null; hookDir: string | null }>();
  private readonly maxResumeAttempts: number;
  private readonly resumeBackoffBaseMs: number;
  private readonly worktreeExists: (worktreePath: string) => boolean;
  private readonly isWorktreeDirty: (worktreePath: string) => Promise<boolean>;
  private readonly log: (msg: string) => void;

  constructor(opts: CliResumeCoordinatorOptions) {
    this.store = opts.store;
    this.manager = opts.manager;
    this.registry = opts.registry;
    this.reattachTelemetry = opts.reattachTelemetry;
    this.detachTelemetry = opts.detachTelemetry;
    this.maxResumeAttempts = opts.maxResumeAttempts ?? DEFAULT_MAX_RESUME_ATTEMPTS;
    this.resumeBackoffBaseMs = opts.resumeBackoffBaseMs ?? DEFAULT_RESUME_BACKOFF_BASE_MS;
    this.worktreeExists = opts.worktreeExists ?? ((p) => existsSync(p));
    this.isWorktreeDirty = opts.isWorktreeDirty ?? defaultIsWorktreeDirty;
    this.log = opts.log ?? (() => {});
  }

  /**
   * The set of worktree paths backing resume-eligible session records. Exposed
   * for the self-healing seam so idle-worktree sweeps treat them as in-use. A
   * record is resume-eligible if it is found live-on-restart (→ engineDeath) or
   * already carries a resume-eligible termination reason AND has not exhausted
   * its attempt cap. The path is `resolve`d-free (raw recorded path); callers
   * normalize as needed.
   */
  resumeReservedWorktrees(): Set<string> {
    const reserved = new Set<string>();
    for (const session of this.store.listSessions()) {
      if (!session.worktreePath) continue;
      if (!this.isRecordResumeEligible(session)) continue;
      reserved.add(session.worktreePath);
    }
    return reserved;
  }

  /** Whether a recorded session is currently resume-eligible (for sweep skipping). */
  isRecordResumeEligible(session: CliSession): boolean {
    if (session.resumeAttempts >= this.maxResumeAttempts) return false;
    // Found-live-on-restart → engineDeath (eligible).
    if (ORPHANED_LIVE_STATES.has(session.agentState)) return true;
    // Reaped-but-resumable: a dead record whose recorded reason is resume-eligible.
    if (
      session.agentState === "dead" &&
      session.terminationReason != null &&
      isResumeEligible(session.terminationReason)
    ) {
      return true;
    }
    return false;
  }

  /**
   * Engine-start sweep. Finds orphaned-live sessions, classifies engineDeath,
   * and resumes each (respecting the manager's concurrency ceiling). Returns a
   * per-session disposition list. Idempotent: a second run after a successful
   * resume finds the session live (re-spawned record is `starting`/`ready`) but
   * the manager's `isLive` guard prevents a duplicate spawn — see `resumeOne`.
   */
  async recoverOnStart(): Promise<ResumeResult[]> {
    const candidates = this.store
      .listSessions()
      .filter((s) => ORPHANED_LIVE_STATES.has(s.agentState))
      // Never reclaim a session the manager already owns (idempotent re-run).
      .filter((s) => !this.manager.isLive(s.id));

    const results: ResumeResult[] = [];
    for (const session of candidates) {
      // Concurrency ceiling: stop queuing once slots are exhausted. The
      // remaining records stay persisted-live and are picked up next sweep.
      if (this.manager.availableSlots() <= 0) {
        results.push({
          sessionId: session.id,
          taskId: session.taskId,
          disposition: "skipped-noCapacity",
        });
        continue;
      }
      results.push(await this.resumeOne(session));
    }
    return results;
  }

  /**
   * Resume a single orphaned session through the eligibility predicate and
   * worktree precondition. Public for targeted tests.
   */
  async resumeOne(session: CliSession): Promise<ResumeResult> {
    const base = { sessionId: session.id, taskId: session.taskId };

    // Idempotency: the manager already owns a live PTY for this id → no-op.
    if (this.manager.isLive(session.id)) {
      return { ...base, disposition: "resumed" };
    }

    // Reclassify a found-live record to engineDeath (it never recorded a reason).
    // A dead record keeps its recorded reason (crashed / killed / userExited / …).
    const reason: CliTerminationReason = ORPHANED_LIVE_STATES.has(session.agentState)
      ? "engineDeath"
      : session.terminationReason ?? "engineDeath";

    // Eligibility predicate: only crashed / engineDeath ever resume.
    if (!isResumeEligible(reason)) {
      this.toNeedsAttention(session, reason, `ineligible termination reason: ${reason}`);
      return { ...base, disposition: "needsAttention-ineligible", reason };
    }

    // Attempt-cap exhaustion → permanent needsAttention (never a third spawn).
    if (session.resumeAttempts >= this.maxResumeAttempts) {
      this.toNeedsAttention(session, reason, `resume attempts exhausted (${session.resumeAttempts})`);
      return { ...base, disposition: "needsAttention-exhausted", reason };
    }

    // Worktree-existence precondition: never spawn into a vanished directory.
    const worktreePath = session.worktreePath;
    if (!worktreePath || !this.worktreeExists(worktreePath)) {
      this.toNeedsAttention(session, reason, `recorded worktree missing: ${worktreePath ?? "<none>"}`);
      return { ...base, disposition: "needsAttention-missingWorktree", reason };
    }

    // Adapter must support resume.
    const adapter = (() => {
      try {
        return this.registry.get(session.adapterId);
      } catch {
        return undefined;
      }
    })();
    if (!adapter || !adapter.capabilities.supportsResume || typeof adapter.buildResume !== "function") {
      this.toNeedsAttention(session, reason, `adapter does not support resume: ${session.adapterId}`);
      return { ...base, disposition: "needsAttention-resumeUnsupported", reason };
    }

    // Vendor session store precondition: a captured native id is required.
    if (!session.nativeSessionId) {
      this.toNeedsAttention(session, reason, "missing native session id (no vendor session store)");
      return { ...base, disposition: "needsAttention-spawnError", reason };
    }

    // Dirty-tree detection: log + flag, then PROCEED.
    let dirty = false;
    try {
      dirty = await this.isWorktreeDirty(worktreePath);
    } catch {
      dirty = false;
    }
    if (dirty) {
      this.log(`[cli-resume] session ${session.id}: worktree dirty at resume — flagged, proceeding`);
      this.flagDirty(session);
    }

    /*
    FNXC:ProcessLifecycle 2026-10-07-18:00:
    Resume is bounded and yields a session observed the same way as the original.
    Every attempt, successful or not, is counted before the relaunch, so a session that keeps dying is resumed at most maxResumeAttempts times across restarts.
    Telemetry is re-attached BEFORE the relaunch and the recorded launch settings are replayed with the fresh hook paths, so the CLI is launched with its model, flags and hooks; the resumed session is then held for its task to adopt.
    */
    if (session.taskId && this.store.listByTask(session.taskId).some((s) => s.id !== session.id && this.manager.isLive(s.id))) {
      // The task already re-ran with a fresh session; resuming this one would put two CLIs in one worktree.
      this.log(`[cli-resume] session ${session.id}: superseded by a live session for task ${session.taskId}`);
      this.store.updateSession(session.id, { agentState: "dead", terminationReason: "killed" });
      return { ...base, disposition: "skipped-superseded" };
    }

    const attempts = session.resumeAttempts + 1;
    this.store.updateSession(session.id, { resumeAttempts: attempts });

    let telemetry: ResumeTelemetry | void = undefined;
    if (this.reattachTelemetry) {
      try {
        telemetry = await this.reattachTelemetry(this.store.getSession(session.id) ?? session);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`[cli-resume] session ${session.id}: telemetry re-attach failed (${msg}); resuming without hooks`);
      }
    }

    // Relaunch via the manager's resume path (adapter buildResume + native id),
    // reusing the existing record so no duplicate session row is created.
    try {
      await this.manager.spawn({
        adapterId: session.adapterId,
        projectId: session.projectId,
        purpose: session.purpose,
        taskId: session.taskId,
        chatSessionId: session.chatSessionId,
        worktreePath,
        posture: session.autonomyPosture,
        settings: { ...recordedLaunchSettings(session), ...(telemetry?.settings ?? {}) },
        resume: { sessionId: session.id, nativeSessionId: session.nativeSessionId },
      });
    } catch (err) {
      try {
        this.detachTelemetry?.(session);
      } catch {
        // best-effort
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof CliConcurrencyLimitError || err instanceof CliSessionAlreadyLiveError) {
        // Capacity raced away, or another resume owns it: not an attempt; leave it for the next sweep.
        this.store.updateSession(session.id, { resumeAttempts: session.resumeAttempts });
        return { ...base, disposition: "skipped-noCapacity" };
      }
      // Immediate spawn failure / unsupported resume / missing vendor store is
      // permanent per the KTD: do NOT loop. Route to needsAttention now.
      this.log(`[cli-resume] session ${session.id}: resume spawn failed (${msg})`);
      this.toNeedsAttention(session, reason, `resume spawn failed: ${msg}`);
      return {
        ...base,
        disposition: err instanceof CliResumeUnsupportedError ? "needsAttention-resumeUnsupported" : "needsAttention-spawnError",
        reason: msg,
      };
    }

    this.resumedUnowned.set(session.id, { taskId: session.taskId, hookDir: telemetry?.hookDir ?? null });
    this.log(`[cli-resume] session ${session.id}: resumed (native ${session.nativeSessionId}) in ${worktreePath} (attempt ${attempts})`);
    return { ...base, disposition: "resumed", dirtyWorktree: dirty };
  }

  /**
   * Hand a session this coordinator resumed to its task's owner (the cli-agent graph node), once.
   * Returns null when nothing live is waiting for the task.
   */
  claimResumedSession(taskId: string): ResumedCliSession | null {
    for (const [sessionId, entry] of this.resumedUnowned) {
      if (entry.taskId !== taskId) continue;
      this.resumedUnowned.delete(sessionId);
      if (this.manager.isLive(sessionId)) return { sessionId, hookDir: entry.hookDir };
    }
    return null;
  }

  /** Backoff (ms) before the next resume attempt for a given attempt count. */
  backoffForAttempt(attemptsSoFar: number): number {
    return this.resumeBackoffBaseMs * 2 ** attemptsSoFar;
  }

  /** Route a session to needsAttention, preserving the precise termination reason. */
  private toNeedsAttention(session: CliSession, reason: CliTerminationReason, why: string): void {
    this.log(`[cli-resume] session ${session.id} → needsAttention: ${why}`);
    this.store.updateSession(session.id, {
      agentState: "needsAttention",
      terminationReason: reason,
    });
  }

  /** Persist the dirty-worktree flag on the session record (extensible posture). */
  private flagDirty(session: CliSession): void {
    const posture = { ...(session.autonomyPosture ?? {}), resumeDirtyWorktree: true };
    this.store.updateSession(session.id, { autonomyPosture: posture });
  }
}
