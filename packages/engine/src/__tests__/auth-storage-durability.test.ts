import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as realFs from "node:fs";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFusionAuthStorage, getFusionAuthPath } from "../auth/auth-storage.js";

/*
FNXC:ProviderAuth 2026-10-07-17:57:
A credential write never removes keys it did not intend to change.
auth.json is replaced atomically (temp file, fsync, rename), an unparseable file refuses every write and is preserved with a .corrupt backup, and an unlocked reader that sees a torn file keeps its last good credentials.
Instance-scoped OAuth refresh shares the locked, single-flight, compare-and-set path, and the refresh request is time-bounded.
*/
const fsControl = vi.hoisted(() => ({ failFsync: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      if (fsControl.failFsync) throw Object.assign(new Error("injected interrupted write"), { code: "EIO" });
      return actual.fsyncSync(fd);
    },
  };
});

const lockControl = vi.hoisted(() => ({
  gate: undefined as Promise<void> | undefined,
  reached: undefined as (() => void) | undefined,
  abandon: undefined as (() => void) | undefined,
}));

vi.mock("proper-lockfile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("proper-lockfile")>();
  const lock: typeof actual.lock = (file, options) => {
    const gate = lockControl.gate;
    if (!gate) return actual.lock(file, options);
    lockControl.reached?.();
    return gate.then(() => actual.lock(file, options));
  };
  const gated = { ...actual, lock };
  return { ...gated, default: gated };
});

/** Hold every lock acquisition that starts from now on. `reached` resolves when the first one arrives; `release` lets them proceed. */
function holdLockAcquisition(): { reached: Promise<void>; release: () => void } {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    lockControl.reached = resolve;
  });
  const gate = new Promise<void>((resolve, reject) => {
    release = () => {
      lockControl.gate = undefined;
      resolve();
    };
    lockControl.abandon = () => reject(new Error("lock acquisition abandoned by test teardown"));
  });
  gate.catch(() => undefined);
  lockControl.gate = gate;
  return { reached, release };
}

/** A lock acquisition still held at teardown is failed, so its caller settles instead of proceeding after the test. */
function abandonHeldLockAcquisition(): void {
  lockControl.abandon?.();
  lockControl.abandon = undefined;
  lockControl.reached = undefined;
  lockControl.gate = undefined;
}

const CORRUPT = '{"openrouter": {"type": "api_key", "key": "keep-me"}, "groq": {"type": "api_';

describe("auth.json durability", () => {
  const originalHome = process.env.HOME;
  const originalFetch = globalThis.fetch;
  let homeDir: string;
  let authPath: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "fusion-engine-auth-durability-"));
    process.env.HOME = homeDir;
    authPath = getFusionAuthPath(homeDir);
    fsControl.failFsync = false;
  });

  afterEach(async () => {
    fsControl.failFsync = false;
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it("refuses every write on an unparseable auth.json, leaves it intact and keeps a .corrupt backup", async () => {
    const storage = createFusionAuthStorage();
    writeFileSync(authPath, CORRUPT, "utf-8");

    await expect(storage.set("anthropic", { type: "api_key", key: "new" })).rejects.toThrow(/auth\.json/);
    await expect(storage.setInstance({ providerId: "openrouter", instanceId: "work" }, { type: "api_key", key: "w" })).rejects.toThrow(/auth\.json/);
    await expect(storage.remove("openrouter")).rejects.toThrow(/auth\.json/);

    expect(readFileSync(authPath, "utf-8")).toBe(CORRUPT);
    const backups = readdirSync(dirname(authPath)).filter((name) => name.startsWith("auth.json.corrupt"));
    expect(backups.length).toBeGreaterThan(0);
    expect(readFileSync(join(dirname(authPath), backups[0]!), "utf-8")).toBe(CORRUPT);
  });

  it("keeps the previous auth.json when a write is interrupted before it lands", async () => {
    const storage = createFusionAuthStorage();
    await storage.set("openrouter", { type: "api_key", key: "keep-me" });
    await storage.set("groq", { type: "api_key", key: "keep-me-too" });
    const before = readFileSync(authPath, "utf-8");

    fsControl.failFsync = true;
    await expect(storage.set("anthropic", { type: "api_key", key: "new" })).rejects.toThrow(/interrupted/);
    fsControl.failFsync = false;

    expect(readFileSync(authPath, "utf-8")).toBe(before);
    expect(readdirSync(dirname(authPath)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    const fresh = createFusionAuthStorage();
    expect(fresh.has("openrouter")).toBe(true);
    expect(fresh.has("groq")).toBe(true);
  });

  it("keeps the last good credentials in memory when an unlocked read sees a torn file", async () => {
    const storage = createFusionAuthStorage();
    await storage.set("openrouter", { type: "api_key", key: "keep-me" });
    await storage.set("groq", { type: "api_key", key: "keep-me-too" });

    writeFileSync(authPath, CORRUPT, "utf-8");
    expect(storage.has("openrouter")).toBe(true);
    expect(storage.has("groq")).toBe(true);
    expect(storage.list()).toEqual(["groq", "openrouter"]);
  });

  it("still treats a missing auth.json as empty and writable", async () => {
    const storage = createFusionAuthStorage();
    realFs.rmSync(authPath, { force: true });
    await storage.set("openrouter", { type: "api_key", key: "fresh" });
    expect(JSON.parse(readFileSync(authPath, "utf-8"))).toMatchObject({ openrouter: { type: "api_key" } });
  });
});

describe("instance-scoped OAuth refresh", () => {
  const originalHome = process.env.HOME;
  const originalFetch = globalThis.fetch;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "fusion-engine-auth-instance-refresh-"));
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    abandonHeldLockAcquisition();
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  const instance = { providerId: "anthropic-subscription", instanceId: "work" };

  /*
  FNXC:ProviderAuth 2026-10-11-20:27:
  Between getApiKey and the token request the refresh path takes a file lock and rereads auth.json: real I/O that fake timers do not drive and that has no upper bound on a loaded runner.
  The hanging-request cases therefore wait on the request itself, and fail at once if getApiKey settles first, which is how a swallowed lock failure shows.
  The slow-lock case first waits until the refresh path is held at its lock, so it cannot pass with a lock that was never held.
  The fallback token is checked against the real clock, so the seeded expiry sits inside the proactive refresh window but beyond the test timeout: real time cannot expire it while a case runs.
  */
  const refreshableExpiry = () => Date.now() + 60_000;

  function hangingRefreshRequest() {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fetchMock = vi.fn((_url: string, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      markStarted();
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return { fetchMock, started };
  }

  /** Resolve when `event` happens; fail at once if one of the named `unexpected` outcomes happens first. */
  function expectFirst(event: Promise<void>, unexpected: Record<string, Promise<unknown>>): Promise<void> {
    return Promise.race([
      event,
      ...Object.entries(unexpected).map(([outcome, happened]) => happened.then(() => {
        throw new Error(`${outcome} happened first`);
      })),
    ]);
  }

  it("refreshes a rotating instance token exactly once across concurrent sessions", async () => {
    const seed = createFusionAuthStorage();
    await seed.setInstance(instance, { type: "oauth", access: "expiring-access", refresh: "single-use-refresh", expires: Date.now() + 1_000 });

    let refreshConsumed = false;
    const fetchMock = vi.fn(async () => {
      if (refreshConsumed) return { ok: false, text: async () => JSON.stringify({ error: "invalid_grant" }) };
      refreshConsumed = true;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true, text: async () => JSON.stringify({ access_token: "rotated-access", refresh_token: "next-refresh", expires_in: 3600 }) };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const sessionA = createFusionAuthStorage();
    const sessionB = createFusionAuthStorage();
    const keys = await Promise.all([
      sessionA.getApiKey("anthropic-subscription", instance),
      sessionB.getApiKey("anthropic-subscription", instance),
      sessionA.getApiKey("anthropic-subscription", instance),
    ]);

    expect(keys).toEqual(["rotated-access", "rotated-access", "rotated-access"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(createFusionAuthStorage().getInstance(instance)).toMatchObject({ access: "rotated-access", refresh: "next-refresh" });
  });

  it("bounds a hanging refresh request instead of waiting on it indefinitely", async () => {
    const seed = createFusionAuthStorage();
    await seed.setInstance(instance, { type: "oauth", access: "expiring-access", refresh: "r", expires: refreshableExpiry() });
    const { fetchMock, started } = hangingRefreshRequest();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = createFusionAuthStorage().getApiKey("anthropic-subscription", instance);
    await expectFirst(started, { "getApiKey settling before the refresh request": pending });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(pending).resolves.toBe("expiring-access");
  });

  it("bounds a hanging refresh request even when refresh-lock acquisition is slow", async () => {
    const seed = createFusionAuthStorage();
    await seed.setInstance(instance, { type: "oauth", access: "expiring-access", refresh: "r", expires: refreshableExpiry() });
    const { fetchMock, started } = hangingRefreshRequest();

    const heldLock = holdLockAcquisition();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = createFusionAuthStorage().getApiKey("anthropic-subscription", instance);
    await expectFirst(heldLock.reached, {
      "getApiKey settling before the refresh lock": pending,
      "the refresh request starting without the held lock": started,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).not.toHaveBeenCalled();

    heldLock.release();
    await expectFirst(started, { "getApiKey settling before the refresh request": pending });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(pending).resolves.toBe("expiring-access");
  });
});
