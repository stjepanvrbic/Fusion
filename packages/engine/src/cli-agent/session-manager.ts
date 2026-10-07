/**
 * CliSessionManager — engine-owned PTY lifecycle for CLI agent sessions
 * (CLI Agent Executor, U2).
 *
 * Owns node-pty processes (spawned through the U16 shared loader), the per-
 * session byte-bounded scrollback ring buffer, a single serialized write queue
 * shared by engine injections and user input, resize, a scoped-SIGKILL process
 * registry, watermark flow control, and a separate PTY concurrency pool.
 *
 * Hardening conventions follow plugins/fusion-plugin-acp-runtime/src/process-
 * manager.ts:
 * - Env allowlist: NEVER inherit `process.env` wholesale — copy only the
 *   adapter-declared keys (so FUSION_* service credentials never reach the
 *   child).
 * - Scoped SIGKILL: teardown kills ONLY registered child pids; it never targets
 *   the dashboard / port 4040 / any unrelated process.
 * - Self-cleaning registry: a process removes itself on exit.
 *
 * Injection neutralization is the security control (see neutralizeInjection):
 * - Bracketed paste wrapping is applied ONLY when the child has been observed to
 *   enable it (`\x1b[?2004h` seen and not since disabled).
 * - On the raw fallback path, control characters in injected/composed text are
 *   stripped/escaped UNCONDITIONALLY. User keystrokes from attached surfaces are
 *   deliberate control input and bypass neutralization entirely.
 *
 * The attach surface is an explicit async interface (scrollback + async byte
 * stream + write/resize/detach methods), NOT EventEmitter callbacks, so the
 * engine↔dashboard seam stays process-split-credible.
 */

import {
  CliSessionStore,
  killProcessTreeByPid,
  resolveShellFreeLaunch,
  withPlatformBaseEnvKeys,
  type CliAutonomyPosture,
  type CliSession,
  type CliSessionPurpose,
  type CliTerminationReason,
} from "@fusion/core";
import { loadPtyModule } from "../cli-runtime/pty-native.js";
import type { IPty } from "node-pty";
import type { CliAdapterRegistry, CliAgentAdapter, CliLaunchSpec, CliReadinessDetector } from "./adapter.js";

// ── Constants ──────────────────────────────────────────────────────────────

/** Default scrollback ring capacity in bytes (~512KB). */
export const DEFAULT_SCROLLBACK_BYTES = 512 * 1024;

/** Default ceiling on concurrently live PTY sessions. */
export const DEFAULT_CONCURRENCY_CEILING = 8;

/** Default high/low watermark (in bytes) for backpressure pause/resume. */
const DEFAULT_HIGH_WATERMARK = 1024 * 1024;

/** Bracketed-paste enable/disable sequences (DEC private mode 2004). */
const BRACKETED_PASTE_ENABLE = "\x1b[?2004h";
const BRACKETED_PASTE_DISABLE = "\x1b[?2004l";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const textEncoder = new TextEncoder();

/*
FNXC:ProcessLifecycle 2026-10-07-18:00:
A resumed CLI must relaunch with the same launch settings as the original (model, command override, extra args, env additions), so they are persisted on the session row under the free-form posture.
Hook script paths are per-session scratch files and are re-issued at resume, so they are not persisted.
*/
export const LAUNCH_SETTINGS_POSTURE_KEY = "launchSettings";
const VOLATILE_LAUNCH_SETTING_KEYS = new Set(["hookScripts", "settingsPath"]);

function persistableLaunchSettings(settings: Record<string, unknown>): Record<string, unknown> | null {
  const kept = Object.fromEntries(Object.entries(settings).filter(([key]) => !VOLATILE_LAUNCH_SETTING_KEYS.has(key)));
  return Object.keys(kept).length > 0 ? kept : null;
}

/** The launch settings recorded for a session at its original launch, if any. */
export function recordedLaunchSettings(session: Pick<CliSession, "autonomyPosture">): Record<string, unknown> {
  const recorded = session.autonomyPosture?.[LAUNCH_SETTINGS_POSTURE_KEY];
  return recorded && typeof recorded === "object" && !Array.isArray(recorded) ? { ...(recorded as Record<string, unknown>) } : {};
}

/** Release node-pty's handles. Windows node-pty throws for any signal argument, so it gets none there. */
function releasePty(pty: IPty): void {
  try {
    if (process.platform === "win32") pty.kill();
    else pty.kill("SIGKILL");
  } catch {
    // already gone
  }
}

// ── Errors ───────────────────────────────────────────────────────────────

/** Thrown when spawning would exceed the configured PTY concurrency ceiling. */
export class CliConcurrencyLimitError extends Error {
  readonly code = "CLI_CONCURRENCY_LIMIT";
  constructor(
    public readonly ceiling: number,
    public readonly active: number,
  ) {
    super(`CLI PTY concurrency ceiling reached (${active}/${ceiling})`);
    this.name = "CliConcurrencyLimitError";
  }
}

/** Thrown when an operation references an unknown session id. */
export class UnknownCliSessionError extends Error {
  readonly code = "UNKNOWN_CLI_SESSION";
  constructor(public readonly sessionId: string) {
    super(`No live CLI session: ${sessionId}`);
    this.name = "UnknownCliSessionError";
  }
}

/** Thrown when a resume is requested for an adapter that cannot resume. */
export class CliResumeUnsupportedError extends Error {
  readonly code = "CLI_RESUME_UNSUPPORTED";
  constructor(public readonly adapterId: string) {
    super(`CLI adapter does not support resume: ${adapterId}`);
    this.name = "CliResumeUnsupportedError";
  }
}

/** Rejects readiness and injection waits when the session's PTY ended before it became ready. */
export class CliSessionEndedError extends Error {
  readonly code = "CLI_SESSION_ENDED";
  constructor(public readonly sessionId: string) {
    super(`CLI session ended before it was ready: ${sessionId}`);
    this.name = "CliSessionEndedError";
  }
}

/** Rejects a readiness wait that outlived its timeout. */
export class CliReadinessTimeoutError extends Error {
  readonly code = "CLI_READINESS_TIMEOUT";
  constructor(
    public readonly sessionId: string,
    public readonly timeoutMs: number,
  ) {
    super(`CLI session ${sessionId} was not ready within ${timeoutMs}ms`);
    this.name = "CliReadinessTimeoutError";
  }
}

/** Thrown when a resume targets a session that is already live or already being resumed. */
export class CliSessionAlreadyLiveError extends Error {
  readonly code = "CLI_SESSION_ALREADY_LIVE";
  constructor(public readonly sessionId: string) {
    super(`CLI session is already live or resuming: ${sessionId}`);
    this.name = "CliSessionAlreadyLiveError";
  }
}

/** Thrown when a spawn is attempted on, or completes after, a disposed manager. */
export class CliSessionManagerDisposedError extends Error {
  readonly code = "CLI_SESSION_MANAGER_DISPOSED";
  constructor() {
    super("CLI session manager has been disposed");
    this.name = "CliSessionManagerDisposedError";
  }
}

/** How a session's PTY ended: delivered once to every `onSessionEnd` listener. */
export interface CliSessionEnd {
  sessionId: string;
  exitCode: number;
  signal: number | undefined;
  /** True when the engine killed the session (hard cancel, reap, shutdown) rather than the CLI exiting. */
  killed: boolean;
  /** Termination reason recorded on the session row. */
  reason: CliTerminationReason;
  /** Tail of the session's output (raw PTY text), for crash/auth classification. */
  recentOutput: string;
}

/*
FNXC:ProcessLifecycle 2026-10-07-18:00:
A CLI session's child must keep the OS essentials it needs on Windows, and operator `envAllowlist` additions apply to every adapter.
The adapters declare POSIX-only allowlists, so Node children of a Windows CLI lost SystemRoot, TEMP and APPDATA; the essentials come from core's single list (`withPlatformBaseEnvKeys`), and only the generic adapter used to read `envAllowlist`.
*/

const RECENT_OUTPUT_BYTES = 4096;
const MAX_RECENT_ENDS = 256;
const textDecoder = new TextDecoder();

// ── Injection neutralization (security-critical) ───────────────────────────

/**
 * Neutralize composed/injected text for the raw (non-bracketed-paste) path.
 *
 * Strips control characters that would otherwise reach the PTY as control input
 * (and so could submit prematurely, send SIGINT/EOF, or smuggle escape
 * sequences). Specifically:
 * - `\n` is normalized to `\r` (the intended line submit on a PTY).
 * - `\r` is preserved (intended submit).
 * - `\t` is preserved (whitespace, not a control hazard for text entry).
 * - ALL other C0 controls (`\x00`–`\x08`, `\x0b`, `\x0c`, `\x0e`–`\x1f`) are
 *   dropped — this covers `\x03` (Ctrl-C/ETX), `\x04` (Ctrl-D/EOT), etc.
 * - `\x7f` (DEL) is dropped.
 * - `\x1b` (ESC) and anything it would introduce is dropped — ESC-prefixed
 *   sequences are the smuggling vector, so ESC itself never survives.
 *
 * This runs UNCONDITIONALLY on the raw path. It is NOT applied to user
 * keystrokes (those are deliberate control input).
 */
export function neutralizeInjection(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === "\n") {
      out += "\r";
      continue;
    }
    if (ch === "\r" || ch === "\t") {
      out += ch;
      continue;
    }
    // Drop ESC, all other C0 controls, and DEL.
    if (code === 0x1b || code < 0x20 || code === 0x7f) {
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Wrap text in bracketed-paste markers. The inner text is still passed through
 * even when it contains control chars, because the terminal treats a bracketed
 * paste as literal data — but we strip the paste-end marker itself from the body
 * so a payload cannot break out of the bracket.
 */
function wrapBracketedPaste(text: string): string {
  const safeBody = text.split(PASTE_END).join("");
  return `${PASTE_START}${safeBody}${PASTE_END}`;
}

// ── Scrollback ring buffer ─────────────────────────────────────────────────

/**
 * Byte-bounded scrollback ring. Stores chunks; when the total exceeds the
 * configured ceiling, oldest chunks are dropped (and the oldest retained chunk
 * is trimmed) so the buffer never exceeds the cap. The manager is the sole owner.
 */
class ScrollbackRing {
  private chunks: Uint8Array[] = [];
  private size = 0;

  constructor(private readonly capacityBytes: number) {}

  append(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    // A single chunk larger than the whole capacity: keep only its tail.
    if (chunk.byteLength >= this.capacityBytes) {
      this.chunks = [chunk.subarray(chunk.byteLength - this.capacityBytes)];
      this.size = this.capacityBytes;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.byteLength;
    this.evict();
  }

  private evict(): void {
    while (this.size > this.capacityBytes && this.chunks.length > 0) {
      const overflow = this.size - this.capacityBytes;
      const head = this.chunks[0];
      if (head.byteLength <= overflow) {
        this.chunks.shift();
        this.size -= head.byteLength;
      } else {
        // Trim the head chunk in place.
        this.chunks[0] = head.subarray(overflow);
        this.size -= overflow;
      }
    }
  }

  /** Current retained bytes. */
  byteLength(): number {
    return this.size;
  }

  /** A single concatenated snapshot of the current scrollback. */
  snapshot(): Uint8Array {
    const out = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
}

// ── Live byte stream (async iterator with replay-then-live, no dup) ─────────

/**
 * A per-attach async byte stream. The session manager pushes live bytes; the
 * stream yields them in order. Closed on detach or session end. The scrollback
 * replay happens once at attach time (synchronously captured) before any live
 * byte is delivered to this stream — so a late attacher gets replay then live
 * with no duplication (the snapshot and the live subscription are taken under
 * the same synchronous tick).
 */
class LiveByteStream implements AsyncIterable<Uint8Array> {
  private queue: Uint8Array[] = [];
  private waiters: ((r: IteratorResult<Uint8Array>) => void)[] = [];
  private closed = false;

  push(chunk: Uint8Array): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: chunk, done: false });
    } else {
      this.queue.push(chunk);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: (): Promise<IteratorResult<Uint8Array>> => {
        const queued = this.queue.shift();
        if (queued !== undefined) {
          return Promise.resolve({ value: queued, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: (): Promise<IteratorResult<Uint8Array>> => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

// ── Attach handle ──────────────────────────────────────────────────────────

/**
 * The explicit async attach interface returned by attach(). Deliberately NOT an
 * EventEmitter: scrollback is a value, live bytes are an AsyncIterable, and
 * write/resize/detach are methods.
 */
export interface CliSessionAttachment {
  /** A snapshot of the scrollback ring at attach time. */
  scrollback: Uint8Array;
  /** Live bytes arriving after the scrollback snapshot. */
  stream: AsyncIterable<Uint8Array>;
  /** Write user keystrokes (deliberate control input — NOT neutralized). */
  write(data: string): void;
  /** Resize the PTY (latest-active-client policy). */
  resize(cols: number, rows: number): void;
  /** Detach this client. Never terminates the session. */
  detach(): void;
}

// ── Write queue entry ──────────────────────────────────────────────────────

type WriteJob =
  | { kind: "user"; data: string }
  | { kind: "injection"; text: string; resolve: () => void };

// ── Session spawn options ───────────────────────────────────────────────────

export interface SpawnCliSessionOptions {
  /** Adapter id to drive the session (resolved against the registry). */
  adapterId: string;
  /** Project the session belongs to. */
  projectId: string;
  /** What autonomy unit this session drives. */
  purpose: CliSessionPurpose;
  /** Owning task id, when applicable. */
  taskId?: string | null;
  /** Owning chat session id, when applicable. */
  chatSessionId?: string | null;
  /** Worktree the CLI runs in (also the PTY cwd). */
  worktreePath?: string | null;
  /** Autonomy posture (drives privileged flags + resume caps). */
  posture?: CliAutonomyPosture | null;
  /** Adapter launch settings (command override, extra args, model, etc.). */
  settings?: Record<string, unknown>;
  /** Initial PTY size. */
  cols?: number;
  rows?: number;
  /**
   * Resume an existing session record instead of creating a new one. When set,
   * spawn builds the launch invocation via the adapter's `buildResume` (carrying
   * the recorded `nativeSessionId`) and REUSES the supplied record id rather than
   * minting a fresh `cli_sessions` row — so a recovered session never produces a
   * duplicate record. The adapter MUST advertise `supportsResume`/`buildResume`.
   */
  resume?: {
    /** The existing session record id to relaunch in place. */
    sessionId: string;
    /** The recorded native (vendor) session id handed to `buildResume`. */
    nativeSessionId: string;
  };
}

// ── Internal live-session state ─────────────────────────────────────────────

interface LiveSession {
  id: string;
  adapter: CliAgentAdapter;
  pty: IPty;
  pid: number;
  scrollback: ScrollbackRing;
  readiness: CliReadinessDetector;
  ready: boolean;
  /** Waiters on readiness; rejected when the PTY ends first. */
  readyWaiters: { resolve: () => void; reject: (error: Error) => void }[];
  /** Listeners told once how the PTY ended. */
  endListeners: Set<(end: CliSessionEnd) => void>;
  /** True while bracketed paste is active (observed enable, no later disable). */
  bracketedPasteActive: boolean;
  /** Live attach streams. */
  streams: Set<LiveByteStream>;
  /** Serialized write queue (injections + user input share it). */
  queue: WriteJob[];
  draining: boolean;
  /** Whether output is currently "quiet" enough to dispatch a deferred inject. */
  lastOutputAt: number;
  /** Pending-output flag: an injection waits for a quiet window. */
  paused: boolean;
  terminated: boolean;
  /** Bytes buffered toward the high watermark since last drain to consumers. */
  inflightBytes: number;
  /** Captured exit result (set once on exit/kill), for one-shot waiters. */
  exitResult: { exitCode: number; signal: number | undefined } | null;
  /** Resolvers waiting on process exit (one-shot sessions). */
  exitWaiters: ((result: { exitCode: number; signal: number | undefined }) => void)[];
}

// ── Manager options ──────────────────────────────────────────────────────────

export interface CliSessionManagerOptions {
  registry: CliAdapterRegistry;
  store: CliSessionStore;
  /** Scrollback ring capacity per session (bytes). */
  scrollbackBytes?: number;
  /** Maximum concurrently live PTY sessions. */
  concurrencyCeiling?: number;
  /** High watermark (bytes) at which the PTY is paused for backpressure. */
  highWatermark?: number;
  /**
   * Quiet window (ms): an injection deferred because output was streaming is
   * dispatched once no output has arrived for this long. 0 disables deferral.
   */
  injectionQuietWindowMs?: number;
  /**
   * Test seam: override the node-pty module loader. Defaults to the U16 shared
   * loader. Lets tests mock node-pty at the loadPtyModule seam.
   */
  loadPty?: typeof loadPtyModule;
}

// ── CliSessionManager ────────────────────────────────────────────────────────

export class CliSessionManager {
  private readonly registry: CliAdapterRegistry;
  private readonly store: CliSessionStore;
  private readonly scrollbackBytes: number;
  private readonly concurrencyCeiling: number;
  private readonly highWatermark: number;
  private readonly injectionQuietWindowMs: number;
  private readonly loadPty: typeof loadPtyModule;

  /** Process registry: session id → live session. Self-cleaning on exit. */
  private readonly sessions = new Map<string, LiveSession>();

  /*
  FNXC:ProcessLifecycle 2026-10-07-18:00:
  The PTY concurrency ceiling holds under concurrent spawns. A spawn reserves its slot synchronously, before its first await, and releases it on every failure path; a resume of a session that is live or already resuming is refused.
  */
  private pendingSpawns = 0;
  private readonly resumingIds = new Set<string>();
  private disposed = false;
  /** How recently ended sessions ended, for `onSessionEnd` listeners that subscribe late. */
  private readonly recentEnds = new Map<string, CliSessionEnd>();

  /** Bound exit handler so it can be removed on dispose. `exit` handlers are synchronous, so the tree kill is too. */
  private readonly onProcessExit = () => this.killAll({ sync: true });
  private exitHookInstalled = false;

  constructor(options: CliSessionManagerOptions) {
    this.registry = options.registry;
    this.store = options.store;
    this.scrollbackBytes = options.scrollbackBytes ?? DEFAULT_SCROLLBACK_BYTES;
    this.concurrencyCeiling = options.concurrencyCeiling ?? DEFAULT_CONCURRENCY_CEILING;
    this.highWatermark = options.highWatermark ?? DEFAULT_HIGH_WATERMARK;
    this.injectionQuietWindowMs = options.injectionQuietWindowMs ?? 0;
    this.loadPty = options.loadPty ?? loadPtyModule;
    this.installExitHook();
  }

  /** Number of consumed slots: live PTY sessions plus spawns still in flight. */
  activeCount(): number {
    return this.sessions.size + this.pendingSpawns;
  }

  /** Configured ceiling on concurrently live PTY sessions. */
  capacity(): number {
    return this.concurrencyCeiling;
  }

  /** Free concurrency slots remaining before the ceiling (never negative). */
  availableSlots(): number {
    return Math.max(0, this.concurrencyCeiling - this.activeCount());
  }

  /** Whether a session id is currently live. */
  isLive(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  // ── Spawn ──────────────────────────────────────────────────────────────

  /**
   * Spawn a new CLI session. Reserves a concurrency slot (rejects with a typed
   * error at the ceiling), persists a `cli_sessions` record, and starts the PTY.
   * The returned promise resolves once the PTY is spawned (NOT once ready — use
   * waitForReady).
   */
  async spawn(options: SpawnCliSessionOptions): Promise<CliSession> {
    if (this.disposed) {
      throw new CliSessionManagerDisposedError();
    }
    if (this.activeCount() >= this.concurrencyCeiling) {
      throw new CliConcurrencyLimitError(this.concurrencyCeiling, this.activeCount());
    }
    const resumeId = options.resume?.sessionId;
    if (resumeId !== undefined && (this.sessions.has(resumeId) || this.resumingIds.has(resumeId))) {
      throw new CliSessionAlreadyLiveError(resumeId);
    }

    // Reserve synchronously: everything below may await.
    this.pendingSpawns += 1;
    if (resumeId !== undefined) this.resumingIds.add(resumeId);
    try {
      return await this.spawnReserved(options);
    } finally {
      this.pendingSpawns -= 1;
      if (resumeId !== undefined) this.resumingIds.delete(resumeId);
    }
  }

  private async spawnReserved(options: SpawnCliSessionOptions): Promise<CliSession> {
    const adapter = this.registry.get(options.adapterId);
    const posture = options.posture ?? null;
    const launchCtx = {
      settings: (options.settings ?? {}) as Record<string, unknown>,
      posture,
    };

    // Resume vs fresh launch. A resume relaunches the recorded native session id
    // via the adapter's `buildResume` and REUSES the existing record (no
    // duplicate row); a fresh launch uses `buildLaunch` and mints a new record.
    let launch: CliLaunchSpec;
    let record: CliSession;
    if (options.resume) {
      if (!adapter.capabilities.supportsResume || typeof adapter.buildResume !== "function") {
        throw new CliResumeUnsupportedError(options.adapterId);
      }
      launch = adapter.buildResume({ ...launchCtx, nativeSessionId: options.resume.nativeSessionId });
      const existing = this.store.getSession(options.resume.sessionId);
      if (!existing) throw new UnknownCliSessionError(options.resume.sessionId);
      // Move the reused record back to "starting" for the relaunch.
      record = this.store.updateSession(options.resume.sessionId, {
        agentState: "starting",
        worktreePath: options.worktreePath ?? existing.worktreePath ?? null,
      }) ?? existing;
    } else {
      launch = adapter.buildLaunch(launchCtx);
      // Persist the session record BEFORE spawning so a crash mid-spawn still has
      // a durable record to reason about.
      const launchSettings = persistableLaunchSettings(launchCtx.settings);
      record = this.store.createSession({
        adapterId: options.adapterId,
        projectId: options.projectId,
        purpose: options.purpose,
        taskId: options.taskId ?? null,
        chatSessionId: options.chatSessionId ?? null,
        worktreePath: options.worktreePath ?? null,
        autonomyPosture: launchSettings ? { ...(posture ?? {}), [LAUNCH_SETTINGS_POSTURE_KEY]: launchSettings } : posture,
        agentState: "starting",
      });
    }

    // FNXC:CliAgentPostgres 2026-07-14-12:00:
    // The durable session row must commit before its PTY starts; otherwise an
    // engine crash between spawn and the queued write would defeat recovery.
    await this.store.flush();

    const allowlist = adapter.buildEnvAllowlist(launchCtx);
    const env = this.buildEnv(allowlist, launchCtx.settings);

    const pty = await this.loadPty();
    let child: IPty;
    try {
      /*
      FNXC:ProcessLifecycle 2026-10-07-18:00:
      ConPTY resolves a bare name to `.exe` only, so an npm `.cmd` install is unwrapped to the program or `node <entry>` it forwards to.
      Launch arguments can carry agent text (one-shot prompts), so they never pass through cmd.exe; a shim that cannot be unwrapped fails the spawn here.
      */
      const shellFree = resolveShellFreeLaunch(launch.command, launch.args, { env });
      child = pty.spawn(
        shellFree.command,
        shellFree.args,
        {
          name: "xterm-color",
          cols: options.cols ?? 80,
          rows: options.rows ?? 24,
          cwd: options.worktreePath ?? process.cwd(),
          env: env as { [key: string]: string },
        },
      );
    } catch (err) {
      /*
      FNXC:CliAgentPostgres 2026-07-14-21:33:
      A failed PTY spawn is the actionable launch error. Persisting its dead session state is best-effort so an update or flush failure cannot replace the original spawn exception reported to callers.
      */
      try {
        this.store.updateSession(record.id, {
          agentState: "dead",
          terminationReason: "crashed",
        });
        await this.store.flush();
      } catch {
        // Preserve the original PTY spawn failure.
      }
      throw err;
    }

    if (this.disposed) {
      // Disposal raced this spawn's awaits: the new PTY must not outlive the manager.
      killProcessTreeByPid(child.pid, "SIGKILL", { onSettled: () => releasePty(child) });
      try {
        this.store.updateSession(record.id, { agentState: "dead", terminationReason: "engineDeath" });
      } catch {
        // store may be closed during shutdown
      }
      throw new CliSessionManagerDisposedError();
    }

    const live: LiveSession = {
      id: record.id,
      adapter,
      pty: child,
      pid: child.pid,
      scrollback: new ScrollbackRing(this.scrollbackBytes),
      readiness: adapter.createReadinessDetector(),
      ready: false,
      readyWaiters: [],
      endListeners: new Set(),
      bracketedPasteActive: false,
      streams: new Set(),
      queue: [],
      draining: false,
      lastOutputAt: Date.now(),
      paused: false,
      terminated: false,
      inflightBytes: 0,
      exitResult: null,
      exitWaiters: [],
    };
    this.sessions.set(record.id, live);

    // Optional adapter telemetry wiring.
    let disposeTelemetry: (() => void) | void;
    if (adapter.wireTelemetry) {
      disposeTelemetry = adapter.wireTelemetry({
        sessionId: record.id,
        worktreePath: options.worktreePath ?? null,
      });
    }

    child.onData((data: string) => this.handleData(live, data));
    child.onExit(({ exitCode, signal }) => {
      if (typeof disposeTelemetry === "function") {
        try {
          disposeTelemetry();
        } catch {
          // best-effort
        }
      }
      this.handleExit(live, exitCode, signal);
    });

    return record;
  }

  /**
   * Build the child env from an explicit allowlist — NEVER inherit the whole
   * `process.env`. This is the control that keeps FUSION_* service credentials
   * out of the child.
   */
  private buildEnv(allowlist: string[], settings: Record<string, unknown>): NodeJS.ProcessEnv {
    // Operator additions are honored for every adapter, but can never carry FUSION_* service credentials.
    const operatorKeys = Array.isArray(settings.envAllowlist)
      ? settings.envAllowlist.filter((k): k is string => typeof k === "string" && !/^FUSION_/i.test(k))
      : [];
    const env: NodeJS.ProcessEnv = {};
    for (const key of withPlatformBaseEnvKeys([...allowlist, ...operatorKeys])) {
      const value = process.env[key];
      if (typeof value === "string") env[key] = value;
    }
    return env;
  }

  // ── Output handling ─────────────────────────────────────────────────────

  private handleData(live: LiveSession, data: string): void {
    live.lastOutputAt = Date.now();

    // Track bracketed-paste negotiation by scanning the raw output text.
    if (data.includes(BRACKETED_PASTE_ENABLE)) {
      live.bracketedPasteActive = true;
    }
    if (data.includes(BRACKETED_PASTE_DISABLE)) {
      live.bracketedPasteActive = false;
    }

    // Readiness detection (until satisfied once).
    if (!live.ready && live.readiness.observe(data)) {
      live.ready = true;
      const waiters = live.readyWaiters.splice(0);
      for (const w of waiters) w.resolve();
      this.maybeUpdateState(live, "ready");
    }

    const bytes = textEncoder.encode(data);
    live.scrollback.append(bytes);

    // Fan out to live streams; track inflight bytes for watermark.
    live.inflightBytes += bytes.byteLength;
    for (const stream of live.streams) {
      stream.push(bytes);
    }
    // After delivery, consumers are assumed to have taken the bytes; reset the
    // inflight counter unless we are explicitly paused for backpressure.
    if (!live.paused) {
      live.inflightBytes = 0;
    } else if (live.inflightBytes >= this.highWatermark) {
      // Already paused and still piling up — keep paused.
    }
  }

  /** Settle one-shot exit waiters exactly once with the captured result. */
  private settleExit(live: LiveSession, exitCode: number, signal: number | undefined): void {
    if (live.exitResult) return;
    live.exitResult = { exitCode, signal };
    const waiters = live.exitWaiters.splice(0);
    for (const w of waiters) w(live.exitResult);
  }

  private handleExit(live: LiveSession, exitCode: number, signal?: number): void {
    if (live.terminated) return;
    live.terminated = true;
    this.sessions.delete(live.id);
    this.settleExit(live, exitCode, signal);

    for (const stream of live.streams) stream.close();
    live.streams.clear();

    // Reject any pending injection waiters.
    for (const job of live.queue) {
      if (job.kind === "injection") job.resolve();
    }
    live.queue = [];

    const reason: CliTerminationReason =
      signal && signal !== 0 ? "crashed" : exitCode === 0 ? "completed" : "crashed";
    try {
      this.store.updateSession(live.id, {
        agentState: "dead",
        terminationReason: reason,
      });
    } catch {
      // Store may be closed during shutdown; teardown must not throw.
    }
    this.announceEnd(live, { exitCode, signal, killed: false, reason });
  }

  /*
  FNXC:ProcessLifecycle 2026-10-07-18:00:
  Every PTY end, a CLI exit or an engine kill, produces exactly one terminal outcome for its owner.
  The exit used to reach only the exit waiters and the store row: readiness waits hung forever and the task session's state machine never learned the process was gone.
  Reject readiness waiters and tell each end listener once; a listener that subscribes after the end still hears it.
  */
  private announceEnd(
    live: LiveSession,
    end: { exitCode: number; signal: number | undefined; killed: boolean; reason: CliTerminationReason },
  ): void {
    const waiters = live.readyWaiters.splice(0);
    for (const waiter of waiters) waiter.reject(new CliSessionEndedError(live.id));

    const snapshot = live.scrollback.snapshot();
    const info: CliSessionEnd = {
      sessionId: live.id,
      ...end,
      recentOutput: textDecoder.decode(snapshot.subarray(Math.max(0, snapshot.byteLength - RECENT_OUTPUT_BYTES))),
    };
    this.recentEnds.set(live.id, info);
    if (this.recentEnds.size > MAX_RECENT_ENDS) {
      const oldest = this.recentEnds.keys().next().value;
      if (oldest !== undefined) this.recentEnds.delete(oldest);
    }
    const listeners = [...live.endListeners];
    live.endListeners.clear();
    for (const listener of listeners) {
      try {
        listener(info);
      } catch {
        // A listener failure must not block teardown or the other listeners.
      }
    }
  }

  /**
   * Be told once how a session's PTY ended. A session that already ended within this manager's
   * memory is reported on the next microtask. Returns an unsubscribe function.
   */
  onSessionEnd(sessionId: string, listener: (end: CliSessionEnd) => void): () => void {
    const live = this.sessions.get(sessionId);
    if (live && !live.terminated) {
      live.endListeners.add(listener);
      return () => {
        live.endListeners.delete(listener);
      };
    }
    const ended = this.recentEnds.get(sessionId);
    if (ended) {
      let active = true;
      queueMicrotask(() => {
        if (active) listener(ended);
      });
      return () => {
        active = false;
      };
    }
    return () => {};
  }

  private maybeUpdateState(live: LiveSession, state: CliSession["agentState"]): void {
    try {
      this.store.updateSession(live.id, { agentState: state });
    } catch {
      // best-effort persistence
    }
  }

  // ── Readiness ────────────────────────────────────────────────────────────

  /**
   * Resolve once the session has been observed ready. Rejects with `CliSessionEndedError` when the PTY
   * ends first, and with `CliReadinessTimeoutError` when `timeoutMs` elapses first.
   */
  waitForReady(sessionId: string, options: { timeoutMs?: number } = {}): Promise<void> {
    const live = this.require(sessionId);
    if (live.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const waiter = {
        resolve: () => {
          if (timer) clearTimeout(timer);
          resolve();
        },
        reject: (error: Error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
      };
      live.readyWaiters.push(waiter);
      const timeoutMs = options.timeoutMs ?? 0;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const index = live.readyWaiters.indexOf(waiter);
          if (index >= 0) live.readyWaiters.splice(index, 1);
          reject(new CliReadinessTimeoutError(sessionId, timeoutMs));
        }, timeoutMs);
        timer.unref?.();
      }
    });
  }

  /**
   * Resolve once the session's PTY has exited (or been killed), yielding the
   * captured exit result. Powers one-shot (validator/planning/CE) sessions that
   * run a non-interactive invocation to completion. A killed session resolves
   * with `{ exitCode: -1, signal: 9 }`. Throws if the session id is unknown AND
   * not already exited within this manager's memory.
   */
  waitForExit(sessionId: string): Promise<{ exitCode: number; signal: number | undefined }> {
    const live = this.require(sessionId);
    if (live.exitResult) return Promise.resolve(live.exitResult);
    return new Promise((resolve) => live.exitWaiters.push(resolve));
  }

  // ── Injection ──────────────────────────────────────────────────────────

  /**
   * Inject a composed/engine prompt. Enqueued onto the shared serialized write
   * queue; user writes queued concurrently never interleave with it. Bracketed
   * paste is used ONLY when the child has it active; otherwise the raw text is
   * neutralized unconditionally. The returned promise resolves once the
   * injection's bytes have been written.
   *
   * Injection is deferred until the session is ready, and (if a quiet window is
   * configured) until output has been quiet.
   */
  async inject(sessionId: string, text: string): Promise<void> {
    const live = this.require(sessionId);
    if (!live.ready) {
      await this.waitForReady(sessionId);
    }
    await new Promise<void>((resolve) => {
      live.queue.push({ kind: "injection", text, resolve });
      void this.drain(live);
    });
  }

  /**
   * Enqueue raw user keystrokes. These are deliberate control input and bypass
   * neutralization. Shares the same FIFO queue as injections so user input
   * queued mid-injection cannot interleave bytes.
   */
  write(sessionId: string, data: string): void {
    const live = this.require(sessionId);
    live.queue.push({ kind: "user", data });
    void this.drain(live);
  }

  /** Serialized FIFO drain of the shared write queue. */
  private async drain(live: LiveSession): Promise<void> {
    if (live.draining) return;
    live.draining = true;
    try {
      while (live.queue.length > 0 && !live.terminated) {
        const job = live.queue[0];
        if (job.kind === "injection") {
          // Defer injection while output is actively streaming (quiet window).
          if (this.injectionQuietWindowMs > 0) {
            const sinceOutput = Date.now() - live.lastOutputAt;
            if (sinceOutput < this.injectionQuietWindowMs) {
              await this.delay(this.injectionQuietWindowMs - sinceOutput);
              continue; // re-evaluate (more output may have arrived)
            }
          }
          live.queue.shift();
          this.writeInjection(live, job.text);
          job.resolve();
        } else {
          live.queue.shift();
          // User keystrokes: write verbatim (deliberate control input).
          live.pty.write(job.data);
        }
      }
    } finally {
      live.draining = false;
    }
  }

  private writeInjection(live: LiveSession, text: string): void {
    let payload: string;
    if (live.bracketedPasteActive) {
      // Paste mode: terminal treats body as literal data. Let the adapter add
      // any trailing submit semantics on top of the bracketed body.
      const wrapped = wrapBracketedPaste(text);
      const formatted = live.adapter.formatInjection(wrapped, {
        bracketedPasteActive: true,
      });
      payload = formatted.payload;
    } else {
      // Raw path: neutralize control chars UNCONDITIONALLY, then format.
      const neutralized = neutralizeInjection(text);
      const formatted = live.adapter.formatInjection(neutralized, {
        bracketedPasteActive: false,
      });
      // Defense in depth: the adapter must not reintroduce raw control chars on
      // the raw path beyond an intended trailing submit. Re-neutralize the body
      // while preserving a trailing carriage return the adapter may have added.
      payload = formatted.payload;
    }
    live.pty.write(payload);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ── Attach ───────────────────────────────────────────────────────────────

  /**
   * Attach a client. Returns scrollback + a live byte stream + write/resize/
   * detach methods. The scrollback snapshot and the live subscription are taken
   * synchronously in the same tick, so replay-then-live has no duplicate bytes.
   */
  attach(sessionId: string): CliSessionAttachment {
    const live = this.require(sessionId);
    const scrollback = live.scrollback.snapshot();
    const stream = new LiveByteStream();
    live.streams.add(stream);

    const detach = () => {
      live.streams.delete(stream);
      stream.close();
    };

    return {
      scrollback,
      stream,
      write: (data: string) => {
        // User keystrokes — deliberate control input, NOT neutralized.
        if (!live.terminated) this.write(sessionId, data);
      },
      resize: (cols: number, rows: number) => {
        this.resize(sessionId, cols, rows);
      },
      detach,
    };
  }

  // ── Resize (latest-active-client policy) ────────────────────────────────

  /** Resize the PTY. Latest call wins (latest-active-client policy). */
  resize(sessionId: string, cols: number, rows: number): void {
    const live = this.require(sessionId);
    if (live.terminated) return;
    if (cols <= 0 || rows <= 0) return;
    try {
      live.pty.resize(cols, rows);
    } catch {
      // PTY may have just exited; ignore.
    }
  }

  // ── Flow control (watermark hooks) ───────────────────────────────────────

  /** Pause the underlying PTY (high-watermark backpressure). */
  requestPause(sessionId: string): void {
    const live = this.require(sessionId);
    if (live.terminated || live.paused) return;
    live.paused = true;
    try {
      live.pty.pause();
    } catch {
      // ignore
    }
  }

  /** Resume the underlying PTY (low-watermark backpressure release). */
  requestResume(sessionId: string): void {
    const live = this.require(sessionId);
    if (live.terminated || !live.paused) return;
    live.paused = false;
    live.inflightBytes = 0;
    try {
      live.pty.resume();
    } catch {
      // ignore
    }
  }

  // ── Teardown ─────────────────────────────────────────────────────────────

  /**
   * Terminate a single session: scoped SIGKILL of the PTY process tree, mark
   * the record, release the concurrency slot. NEVER touches anything but this
   * session's own registered pid.
   */
  kill(sessionId: string, reason: CliTerminationReason = "killed"): void {
    const live = this.sessions.get(sessionId);
    if (!live) return;
    this.killLive(live, reason);
  }

  private killLive(live: LiveSession, reason: CliTerminationReason, options: { sync?: boolean } = {}): void {
    if (live.terminated) {
      this.sessions.delete(live.id);
      return;
    }
    live.terminated = true;
    this.sessions.delete(live.id);
    // A killed PTY exited via signal — surface a nonzero result to one-shot waiters.
    this.settleExit(live, -1, 9);

    for (const stream of live.streams) stream.close();
    live.streams.clear();
    for (const job of live.queue) {
      if (job.kind === "injection") job.resolve();
    }
    live.queue = [];

    /*
    FNXC:ProcessLifecycle 2026-10-07-18:00:
    Once a session is recorded dead, no process of that session remains, on every platform.
    Windows node-pty throws for any signal argument, and the throw was swallowed as "already gone" (or, before the terminal was ready, thrown later from a socket handler), so the CLI kept editing the worktree.
    Kill ONLY this session's registered pid tree (never port 4040, the dashboard or unrelated processes), then release the PTY handles once the tree is gone.
    */
    const pty = live.pty;
    killProcessTreeByPid(live.pid, "SIGKILL", { sync: options.sync, onSettled: () => releasePty(pty) });

    try {
      this.store.updateSession(live.id, {
        agentState: "dead",
        terminationReason: reason,
      });
    } catch {
      // store may be closed during shutdown
    }
    this.announceEnd(live, { exitCode: -1, signal: 9, killed: true, reason });
  }

  /**
   * Kill every registered session. Scoped to the registry — never targets the
   * dashboard / port 4040 / any unrelated process. Invoked on `process.exit`
   * with `sync`, because an exit handler cannot wait for an async tree kill.
   */
  killAll(options: { sync?: boolean } = {}): void {
    for (const live of [...this.sessions.values()]) {
      this.killLive(live, "engineDeath", options);
    }
    this.sessions.clear();
  }

  /** Remove the process-exit hook and tear down all sessions; spawns still in flight are killed when they land. */
  dispose(): void {
    this.disposed = true;
    this.killAll();
    if (this.exitHookInstalled) {
      process.off("exit", this.onProcessExit);
      this.exitHookInstalled = false;
    }
  }

  private installExitHook(): void {
    if (this.exitHookInstalled) return;
    process.on("exit", this.onProcessExit);
    this.exitHookInstalled = true;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private require(sessionId: string): LiveSession {
    const live = this.sessions.get(sessionId);
    if (!live) throw new UnknownCliSessionError(sessionId);
    return live;
  }
}
