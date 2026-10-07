/**
 * FNXC:ProcessLifecycle 2026-10-07-18:00:
 * CLI-agent PTY sessions end cleanly on every platform and always report one outcome:
 * a kill removes the whole session tree (Windows node-pty throws for any signal argument),
 * every PTY end settles its task session (no hang before readiness, a classified outcome mid-turn),
 * the concurrency ceiling holds under concurrent spawns, Windows children keep their OS essentials,
 * and a resume after an engine restart is bounded, relaunches with the original settings and has an owner.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliSession, CliSessionStore } from "@fusion/core";

const killTreeCalls = vi.hoisted(() => [] as Array<{ pid: number; signal: string; sync: boolean }>);

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return {
    ...actual,
    killProcessTree: (pid: number, signal: string, options: { sync?: boolean; onSettled?: () => void } = {}) => {
      killTreeCalls.push({ pid, signal, sync: Boolean(options.sync) });
      options.onSettled?.();
    },
  };
});

const { CliAdapterRegistry } = await import("../adapter.js");
const { BUNDLED_CLI_ADAPTERS } = await import("../adapters/index.js");
const {
  CliConcurrencyLimitError,
  CliSessionAlreadyLiveError,
  CliSessionManager,
  CliSessionManagerDisposedError,
  LAUNCH_SETTINGS_POSTURE_KEY,
} = await import("../session-manager.js");
const { TelemetryHub } = await import("../telemetry-hub.js");
const { CliTaskSession, CLI_RESUME_CONTINUATION_PROMPT, killLiveTaskSessions } = await import("../task-session.js");
const { CliResumeCoordinator } = await import("../resume-coordinator.js");

type Adapter = import("../adapter.js").CliAgentAdapter;

// ── Fakes ────────────────────────────────────────────────────────────────────

class FakePty {
  readonly killCalls: Array<string | undefined> = [];
  readonly writes: string[] = [];
  private readonly dataListeners: Array<(data: string) => void> = [];
  private readonly exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  constructor(readonly pid: number) {}
  onData(listener: (data: string) => void) {
    this.dataListeners.push(listener);
    return { dispose: () => undefined };
  }
  onExit(listener: (e: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.push(listener);
    return { dispose: () => undefined };
  }
  write(data: string) {
    this.writes.push(data);
  }
  resize() {}
  pause() {}
  resume() {}
  kill(signal?: string) {
    this.killCalls.push(signal);
    // Mirrors @lydell/node-pty's windowsTerminal.kill.
    if (process.platform === "win32" && signal !== undefined) throw new Error("Signals not supported on windows.");
  }
  emitData(data: string) {
    for (const listener of this.dataListeners) listener(data);
  }
  emitExit(exitCode: number, signal?: number) {
    for (const listener of this.exitListeners) listener({ exitCode, signal });
  }
}

class FakeStore {
  private readonly rows = new Map<string, CliSession>();
  private next = 1;
  flushGate: Promise<void> | null = null;
  async flush() {
    await this.flushGate;
  }
  createSession(input: Partial<CliSession> & Pick<CliSession, "adapterId" | "projectId" | "purpose">): CliSession {
    const now = new Date().toISOString();
    const row: CliSession = {
      id: input.id ?? `session-${this.next++}`,
      taskId: input.taskId ?? null,
      chatSessionId: input.chatSessionId ?? null,
      purpose: input.purpose,
      projectId: input.projectId,
      adapterId: input.adapterId,
      agentState: input.agentState ?? "starting",
      terminationReason: input.terminationReason ?? null,
      nativeSessionId: input.nativeSessionId ?? null,
      resumeAttempts: input.resumeAttempts ?? 0,
      autonomyPosture: input.autonomyPosture ?? null,
      worktreePath: input.worktreePath ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return { ...row };
  }
  getSession(id: string) {
    const row = this.rows.get(id);
    return row ? { ...row } : undefined;
  }
  updateSession(id: string, patch: Partial<CliSession>) {
    const row = this.rows.get(id);
    if (!row) return undefined;
    const updated = { ...row, ...patch, updatedAt: new Date().toISOString() };
    this.rows.set(id, updated);
    return { ...updated };
  }
  listSessions() {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
  listByTask(taskId: string) {
    return this.listSessions().filter((r) => r.taskId === taskId);
  }
  deleteSession(id: string) {
    this.rows.delete(id);
  }
}

interface Harness {
  store: FakeStore;
  registry: InstanceType<typeof CliAdapterRegistry>;
  manager: InstanceType<typeof CliSessionManager>;
  hub: InstanceType<typeof TelemetryHub>;
  ptys: Array<{ file: string; args: string[] | string; env: Record<string, string>; pty: FakePty }>;
  spawnGate: { promise: Promise<void> | null };
}

let nextPid = 5000;
const disposers: Array<() => void> = [];
let scratch: string;

function harness(options: { store?: FakeStore; adapters?: readonly Adapter[]; ceiling?: number } = {}): Harness {
  const store = options.store ?? new FakeStore();
  const registry = new CliAdapterRegistry();
  for (const adapter of options.adapters ?? BUNDLED_CLI_ADAPTERS) registry.register(adapter);
  const ptys: Harness["ptys"] = [];
  const spawnGate: Harness["spawnGate"] = { promise: null };
  const manager = new CliSessionManager({
    registry,
    store: store as unknown as CliSessionStore,
    concurrencyCeiling: options.ceiling,
    loadPty: (async () => {
      await spawnGate.promise;
      return {
        spawn: (file: string, args: string[] | string, opts: { env: Record<string, string> }) => {
          const pty = new FakePty(nextPid++);
          ptys.push({ file, args, env: opts.env, pty });
          return pty;
        },
      };
    }) as never,
  });
  disposers.push(() => manager.dispose());
  const hub = new TelemetryHub({ store: store as unknown as CliSessionStore });
  return { store, registry, manager, hub, ptys, spawnGate };
}

function launch(h: Harness, adapterId: string, extra: Partial<Parameters<typeof CliTaskSession.launch>[0]> = {}) {
  return CliTaskSession.launch({
    taskId: "FN-1",
    projectId: "project-a",
    worktreePath: scratch,
    prompt: "implement the thing",
    config: { cliAdapterId: adapterId },
    manager: h.manager,
    hub: h.hub,
    registry: h.registry,
    hookEndpointUrl: "http://127.0.0.1:9/api/cli-agent/hooks",
    hookDirRoot: scratch,
    ...extra,
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  killTreeCalls.length = 0;
  scratch = mkdtempSync(join(tmpdir(), "fn-cli-lifecycle-"));
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(scratch, { recursive: true, force: true });
});

// ── C-038: kill removes the session tree on every platform ─────────────────────

describe("CLI session kill", () => {
  it.each(["win32", "linux"] as const)("kills the registered pid tree and releases the PTY without throwing on %s", async (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const h = harness();
    const record = await h.manager.spawn({ adapterId: "codex", projectId: "project-a", purpose: "execute", taskId: "FN-1", worktreePath: scratch });
    const { pty } = h.ptys[0];

    expect(() => h.manager.kill(record.id, "killed")).not.toThrow();

    expect(killTreeCalls).toEqual([{ pid: pty.pid, signal: "SIGKILL", sync: false }]);
    expect(pty.killCalls).toEqual(platform === "win32" ? [undefined] : ["SIGKILL"]);
    expect(h.store.getSession(record.id)).toMatchObject({ agentState: "dead", terminationReason: "killed" });
  });

  it("uses the same tree kill for re-entry, reap, dispose and the synchronous parent-exit hook", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const h = harness();
    const before = new Set(process.listeners("exit"));
    const reentry = await h.manager.spawn({ adapterId: "codex", projectId: "project-a", purpose: "execute", taskId: "FN-1", worktreePath: scratch });
    expect(killLiveTaskSessions("FN-1", h.manager, h.store)).toBe(1);
    expect(h.manager.isLive(reentry.id)).toBe(false);

    const session = await launch(h, "codex");
    await session.reap();

    await h.manager.spawn({ adapterId: "codex", projectId: "project-a", purpose: "execute", worktreePath: scratch });
    h.manager.dispose();

    const second = harness();
    await second.manager.spawn({ adapterId: "codex", projectId: "project-a", purpose: "execute", worktreePath: scratch });
    const exitHook = process.listeners("exit").find((listener) => !before.has(listener) && listener !== undefined);
    process.listeners("exit").filter((l) => !before.has(l)).forEach((l) => (l as () => void)());

    expect(killTreeCalls.map((c) => c.sync)).toEqual([false, false, false, true]);
    expect(exitHook).toBeDefined();
    for (const { pty } of [...h.ptys, ...second.ptys]) {
      expect(pty.killCalls.every((signal) => signal === undefined)).toBe(true);
    }
  });
});

// ── C-039: every PTY end settles the task session exactly once ─────────────────

describe.each(["claude-code", "codex", "pi"])("CliTaskSession outcome on PTY end (%s)", (adapterId) => {
  it("resolves needs-attention (crashed) when the CLI exits before it was ready", async () => {
    const h = harness();
    const session = await launch(h, adapterId);

    h.ptys[0].pty.emitExit(1);

    await expect(session.result()).resolves.toMatchObject({ kind: "needs-attention", terminationReason: "crashed" });
    expect(h.store.getSession(session.sessionId)?.agentState).toBe("needsAttention");
  });

  it("resolves a crash mid-turn as needs-attention without waiting for the stall watchdog", async () => {
    const h = harness();
    const session = await launch(h, adapterId);
    const { pty } = h.ptys[0];
    pty.emitData("\x1b[?2004h");
    await settle();
    expect(pty.writes.some((w) => w.includes("implement the thing"))).toBe(true);

    pty.emitExit(137);

    await expect(session.result()).resolves.toMatchObject({ kind: "needs-attention", terminationReason: "crashed" });
  });

  it("classifies a clean mid-task exit as user-exited and an auth rejection as auth-failed", async () => {
    const h = harness();
    const exited = await launch(h, adapterId);
    h.ptys[0].pty.emitData("\x1b[?2004h");
    await settle();
    h.ptys[0].pty.emitExit(0);
    await expect(exited.result()).resolves.toMatchObject({ kind: "user-exited", terminationReason: "userExited" });
    expect(h.store.getSession(exited.sessionId)?.agentState).toBe("needsAttention");

    const auth = await launch(h, adapterId, { taskId: "FN-2" });
    h.ptys[1].pty.emitData("Error: invalid api key\r\n");
    h.ptys[1].pty.emitExit(1);
    await expect(auth.result()).resolves.toMatchObject({ kind: "auth-failed", terminationReason: "authFailed" });
  });

  it("resolves killed when the engine kills the session for re-entry", async () => {
    const h = harness();
    const session = await launch(h, adapterId);

    killLiveTaskSessions("FN-1", h.manager, h.store);

    await expect(session.result()).resolves.toMatchObject({ kind: "killed", terminationReason: "killed" });
  });

  it("resolves needs-attention when the CLI never becomes ready within the readiness bound", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness();
    const session = await launch(h, adapterId, { readyTimeoutMs: 1_000 });
    let outcome: unknown;
    void session.result().then((o) => {
      outcome = o;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2);
    expect(outcome).toMatchObject({ kind: "needs-attention", terminationReason: null });
    expect(h.manager.isLive(session.sessionId)).toBe(true);
  });
});

describe("CliTaskSession late subscription", () => {
  it("rejects a pending readiness wait when the PTY ends", async () => {
    const h = harness();
    const record = await h.manager.spawn({ adapterId: "codex", projectId: "project-a", purpose: "execute", worktreePath: scratch });
    const ready = h.manager.waitForReady(record.id);
    h.ptys[0].pty.emitExit(1);
    await expect(ready).rejects.toMatchObject({ code: "CLI_SESSION_ENDED" });
  });

  it("still settles when the PTY ended before the session started watching it", async () => {
    const h = harness();
    const record = await h.manager.spawn({ adapterId: "codex", projectId: "project-a", purpose: "execute", taskId: "FN-1", worktreePath: scratch });
    h.ptys[0].pty.emitExit(1);
    let heard: unknown;
    h.manager.onSessionEnd(record.id, (end) => {
      heard = end;
    });
    await settle();
    expect(heard).toMatchObject({ sessionId: record.id, exitCode: 1, killed: false });
  });
});

// ── C-111: the concurrency ceiling holds under concurrent spawns ────────────────

describe("CLI session concurrency reservation", () => {
  it("counts in-flight spawns against the ceiling", async () => {
    const h = harness({ ceiling: 1 });
    const gate = deferred();
    h.store.flushGate = gate.promise;

    const first = h.manager.spawn({ adapterId: "codex", projectId: "project-a", purpose: "execute", worktreePath: scratch });
    await expect(h.manager.spawn({ adapterId: "codex", projectId: "project-a", purpose: "execute", worktreePath: scratch })).rejects.toBeInstanceOf(CliConcurrencyLimitError);
    expect(h.manager.availableSlots()).toBe(0);

    gate.resolve();
    await first;
    expect(h.ptys).toHaveLength(1);
    expect(h.manager.activeCount()).toBe(1);
  });

  it("releases the reservation when the spawn fails", async () => {
    const h = harness({ ceiling: 1 });
    await expect(h.manager.spawn({ adapterId: "missing-adapter", projectId: "project-a", purpose: "execute" })).rejects.toThrow();
    expect(h.manager.availableSlots()).toBe(1);
  });

  it("refuses a duplicate resume of a session that is already being resumed", async () => {
    const resumable: Adapter = {
      id: "resumable",
      name: "Resumable",
      capabilities: { nativeDone: true, nativeWaiting: false, transcriptSource: "none", supportsResume: true },
      buildLaunch: () => ({ command: "agent", args: [] }),
      buildResume: (ctx) => ({ command: "agent", args: ["--resume", ctx.nativeSessionId] }),
      buildEnvAllowlist: () => [],
      createReadinessDetector: () => ({ observe: () => true }),
      formatInjection: (text) => ({ payload: text }),
    };
    const h = harness({ adapters: [resumable] });
    const row = h.store.createSession({ adapterId: "resumable", projectId: "project-a", purpose: "execute", agentState: "dead", nativeSessionId: "n-1" });
    const gate = deferred();
    h.spawnGate.promise = gate.promise;

    const first = h.manager.spawn({ adapterId: "resumable", projectId: "project-a", purpose: "execute", resume: { sessionId: row.id, nativeSessionId: "n-1" } });
    await expect(
      h.manager.spawn({ adapterId: "resumable", projectId: "project-a", purpose: "execute", resume: { sessionId: row.id, nativeSessionId: "n-1" } }),
    ).rejects.toBeInstanceOf(CliSessionAlreadyLiveError);
    gate.resolve();
    await first;
    expect(h.ptys).toHaveLength(1);
  });

  it("kills a PTY whose spawn lands after the manager was disposed", async () => {
    const h = harness();
    const gate = deferred();
    h.spawnGate.promise = gate.promise;

    const pending = h.manager.spawn({ adapterId: "codex", projectId: "project-a", purpose: "execute", worktreePath: scratch });
    h.manager.dispose();
    gate.resolve();

    await expect(pending).rejects.toBeInstanceOf(CliSessionManagerDisposedError);
    expect(killTreeCalls.map((c) => c.pid)).toEqual([h.ptys[0].pty.pid]);
    expect(h.manager.activeCount()).toBe(0);
  });
});

// ── C-112: Windows essentials and operator env additions reach every adapter ────

describe("CLI session child environment and command", () => {
  it.each(["claude-code", "codex", "pi"])("passes Windows essentials and operator additions but never FUSION_* (%s)", async (adapterId) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("SystemRoot", "C:\\Windows");
    vi.stubEnv("APPDATA", "C:\\Users\\me\\AppData\\Roaming");
    vi.stubEnv("TEMP", "C:\\Temp");
    vi.stubEnv("MY_PROXY", "http://proxy");
    vi.stubEnv("FUSION_SERVICE_TOKEN", "secret");
    const h = harness();

    await h.manager.spawn({
      adapterId,
      projectId: "project-a",
      purpose: "execute",
      worktreePath: scratch,
      settings: { envAllowlist: ["MY_PROXY", "FUSION_SERVICE_TOKEN"], settingsPath: join(scratch, "settings.json") },
    });

    const { env } = h.ptys[0];
    expect(env).toMatchObject({ SystemRoot: "C:\\Windows", APPDATA: "C:\\Users\\me\\AppData\\Roaming", TEMP: "C:\\Temp", MY_PROXY: "http://proxy" });
    expect(env.FUSION_SERVICE_TOKEN).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it("launches an npm .cmd install of the CLI through cmd.exe on Windows", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    writeFileSync(join(scratch, "codex.cmd"), "@node codex.js %*\r\n");
    vi.stubEnv("PATH", scratch);
    vi.stubEnv("PATHEXT", ".EXE;.CMD");
    vi.stubEnv("ComSpec", "C:\\Windows\\system32\\cmd.exe");
    const h = harness();

    await h.manager.spawn({ adapterId: "codex", projectId: "project-a", purpose: "execute", worktreePath: scratch });

    const { file, args } = h.ptys[0];
    expect(file).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(typeof args).toBe("string");
    expect(String(args).startsWith("/d /s /c ")).toBe(true);
    expect(String(args)).toContain("codex.cmd");
    vi.unstubAllEnvs();
  });
});

// ── C-113: resume is bounded, replays launch settings and has an owner ──────────

describe("CLI resume after an engine restart", () => {
  const launches: Array<{ kind: "launch" | "resume"; settings: Record<string, unknown> }> = [];
  const resumable: Adapter = {
    id: "resumable",
    name: "Resumable",
    capabilities: { nativeDone: true, nativeWaiting: false, transcriptSource: "none", supportsResume: true },
    buildLaunch: (ctx) => {
      launches.push({ kind: "launch", settings: { ...ctx.settings } });
      return { command: "agent", args: [] };
    },
    buildResume: (ctx) => {
      launches.push({ kind: "resume", settings: { ...ctx.settings } });
      return { command: "agent", args: ["--resume", ctx.nativeSessionId] };
    },
    buildEnvAllowlist: () => [],
    createReadinessDetector: () => ({ observe: (chunk: string) => chunk.includes("READY") }),
    formatInjection: (text) => ({ payload: `${text}\r` }),
  };

  beforeEach(() => {
    launches.length = 0;
  });

  function orphanAfterRestart(store: FakeStore, id: string): void {
    store.updateSession(id, { agentState: "busy", nativeSessionId: "native-1" });
  }

  function coordinatorFor(h: Harness, order: string[]) {
    return new CliResumeCoordinator({
      store: h.store as unknown as CliSessionStore,
      manager: h.manager,
      registry: h.registry,
      worktreeExists: () => true,
      isWorktreeDirty: async () => false,
      reattachTelemetry: (session) => {
        order.push("reattach");
        h.hub.issueToken(session.id);
        return { hookDir: join(scratch, "hooks", session.id), settings: { hookScripts: { stopScript: "fresh-hook" }, settingsPath: "fresh-settings.json" } };
      },
    });
  }

  it("relaunches with the original launch settings plus fresh hook paths, wired before the spawn", async () => {
    const original = harness({ adapters: [resumable] });
    const record = await original.manager.spawn({
      adapterId: "resumable",
      projectId: "project-a",
      purpose: "execute",
      taskId: "FN-1",
      worktreePath: scratch,
      settings: { model: "opus", extraArgs: ["--verbose"], hookScripts: { stopScript: "old-hook" }, settingsPath: "old-settings.json" },
    });
    expect(original.store.getSession(record.id)?.autonomyPosture?.[LAUNCH_SETTINGS_POSTURE_KEY]).toEqual({ model: "opus", extraArgs: ["--verbose"] });
    orphanAfterRestart(original.store, record.id);

    const restarted = harness({ store: original.store, adapters: [resumable] });
    const order: string[] = [];
    const spawn = restarted.manager.spawn.bind(restarted.manager);
    vi.spyOn(restarted.manager, "spawn").mockImplementation((options) => {
      order.push("spawn");
      return spawn(options);
    });

    const [result] = await coordinatorFor(restarted, order).recoverOnStart();

    expect(result.disposition).toBe("resumed");
    expect(order).toEqual(["reattach", "spawn"]);
    expect(launches.at(-1)).toEqual({
      kind: "resume",
      settings: { model: "opus", extraArgs: ["--verbose"], hookScripts: { stopScript: "fresh-hook" }, settingsPath: "fresh-settings.json" },
    });
  });

  it("counts successful resumes, so a session that keeps dying is resumed at most the cap across restarts", async () => {
    const store = new FakeStore();
    const record = store.createSession({ adapterId: "resumable", projectId: "project-a", purpose: "execute", taskId: "FN-1", worktreePath: scratch });
    const dispositions: string[] = [];
    for (let restart = 0; restart < 3; restart++) {
      orphanAfterRestart(store, record.id);
      const h = harness({ store, adapters: [resumable] });
      const [result] = await coordinatorFor(h, []).recoverOnStart();
      dispositions.push(result.disposition);
      // The hub's machine was seeded before the coordinator counted; a transition must not write the stale count back.
      h.hub.getStateMachine(record.id)?.signalWaitingOnInput();
      h.manager.dispose();
    }

    expect(dispositions).toEqual(["resumed", "resumed", "needsAttention-exhausted"]);
    expect(store.getSession(record.id)?.resumeAttempts).toBe(2);
  });

  it("hands the resumed session to its task once, and the adopted session re-drives it and reports its outcome", async () => {
    const store = new FakeStore();
    const record = store.createSession({ adapterId: "resumable", projectId: "project-a", purpose: "execute", taskId: "FN-1", worktreePath: scratch });
    orphanAfterRestart(store, record.id);
    const h = harness({ store, adapters: [resumable] });
    const coordinator = coordinatorFor(h, []);
    await coordinator.recoverOnStart();

    const claim = coordinator.claimResumedSession("FN-1");
    expect(claim).toEqual({ sessionId: record.id, hookDir: join(scratch, "hooks", record.id) });
    expect(coordinator.claimResumedSession("FN-1")).toBeNull();

    const adopted = CliTaskSession.adopt({
      taskId: "FN-1",
      sessionId: record.id,
      config: { cliAdapterId: "resumable" },
      manager: h.manager,
      hub: h.hub,
      registry: h.registry,
      hookEndpointUrl: "http://127.0.0.1:9/api/cli-agent/hooks",
      hookDir: claim?.hookDir ?? null,
    });
    const { pty } = h.ptys[0];
    pty.emitData("READY");
    await settle();
    expect(pty.writes).toContain(`${CLI_RESUME_CONTINUATION_PROMPT}\r`);

    pty.emitExit(1);
    await expect(adopted.result()).resolves.toMatchObject({ kind: "needs-attention", terminationReason: "crashed" });
  });

  it("does not resume a session whose task already runs a fresh live session", async () => {
    const store = new FakeStore();
    const stale = store.createSession({ adapterId: "resumable", projectId: "project-a", purpose: "execute", taskId: "FN-1", worktreePath: scratch });
    orphanAfterRestart(store, stale.id);
    const h = harness({ store, adapters: [resumable] });
    await h.manager.spawn({ adapterId: "resumable", projectId: "project-a", purpose: "execute", taskId: "FN-1", worktreePath: scratch });

    const [result] = await coordinatorFor(h, []).recoverOnStart();

    expect(result.disposition).toBe("skipped-superseded");
    expect(h.ptys).toHaveLength(1);
    expect(store.getSession(stale.id)).toMatchObject({ agentState: "dead", terminationReason: "killed" });
  });
});
