import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync, rmdirSync, utimesSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { createFusionAuthStorage, getFusionAuthPath } from "../auth/auth-storage.js";

/*
FNXC:ProviderAuth 2026-10-12-01:04:
A lost auth file lock must fail the operation that holds it, never the engine process.
The lock library reports a lost lock from its renewal check, a file-system callback; anything thrown there is an uncaught exception.
These cases drive the real library through an instrumented file system so a test can lose a lock while it is held, order a renewal check against a release, and see anything thrown out of a library callback.
Lock and file I/O is real and unbounded on a loaded runner, so every wait is on the I/O event itself, never on a fake-timer advance.
*/
type LockIoCall = "mkdir" | "stat" | "utimes" | "rmdir" | "realpath";
type LockIoPhase = "started" | "completed";

const lockIo = vi.hoisted(() => {
  const state = {
    events: [] as Array<{ call: string; phase: string; path: string }>,
    /** Errors a library callback threw; outside this harness each one is an uncaught exception. */
    thrown: [] as unknown[],
    heldStats: new Map<string, Promise<void>>(),
    watchers: new Set<() => void>(),
    record(event: { call: string; phase: string; path: string }): void {
      state.events.push(event);
      for (const watcher of [...state.watchers]) watcher();
    },
  };
  return state;
});

vi.mock("proper-lockfile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("proper-lockfile")>();
  const nodeFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  const nodePath = await vi.importActual<typeof import("node:path")>("node:path");
  const instrument = (call: "mkdir" | "stat" | "utimes" | "rmdir" | "realpath") => (...args: unknown[]): void => {
    const callback = args.pop() as (...results: unknown[]) => void;
    const path = nodePath.resolve(String(args[0]));
    lockIo.record({ call, phase: "started", path });
    const run = (): void => {
      (nodeFs[call] as unknown as (...forwarded: unknown[]) => void)(...args, (...results: unknown[]) => {
        try {
          callback(...results);
        } catch (error) {
          lockIo.thrown.push(error);
        } finally {
          lockIo.record({ call, phase: "completed", path });
        }
      });
    };
    const held = call === "stat" ? lockIo.heldStats.get(path) : undefined;
    if (!held) return run();
    lockIo.heldStats.delete(path);
    void held.then(run);
  };
  // One object for the whole file: the library caches the probed mtime precision on it.
  const instrumentedFs = {
    mkdir: instrument("mkdir"),
    stat: instrument("stat"),
    utimes: instrument("utimes"),
    rmdir: instrument("rmdir"),
    realpath: instrument("realpath"),
    rmdirSync: nodeFs.rmdirSync,
  };
  const lock: typeof actual.lock = (file, options) => actual.lock(file, { ...options, fs: instrumentedFs });
  const instrumented = { ...actual, lock };
  return { ...instrumented, default: instrumented };
});

function lockIoCount(call: LockIoCall, phase: LockIoPhase, path: string): number {
  return lockIo.events.filter((event) => event.call === call && event.phase === phase && event.path === path).length;
}

/** Resolve once `condition` holds, re-evaluated after every lock I/O event. */
function lockIoWhen(condition: () => boolean): Promise<void> {
  return new Promise((resolveWhen) => {
    const check = (): void => {
      if (!condition()) return;
      lockIo.watchers.delete(check);
      resolveWhen();
    };
    lockIo.watchers.add(check);
    check();
  });
}

/** Resolve once `count` calls of this kind on `path` have reached `phase`. */
function lockIoReached(call: LockIoCall, phase: LockIoPhase, path: string, count: number): Promise<void> {
  return lockIoWhen(() => lockIoCount(call, phase, path) >= count);
}

/** Resolve once every lock I/O call started on `path` has been handled by the library. A renewal check starts its follow-up call before it counts as handled, so this covers the whole check. */
function lockIoIdle(path: string): Promise<void> {
  const inPhase = (phase: LockIoPhase): number => lockIo.events.filter((event) => event.phase === phase && event.path === path).length;
  return lockIoWhen(() => inPhase("started") === inPhase("completed"));
}

/** Keep the next `stat` on `path` from reaching the file system until `proceed` is called. */
function holdNextStat(path: string): { proceed: () => void } {
  let proceed!: () => void;
  lockIo.heldStats.set(path, new Promise<void>((resolveHeld) => {
    proceed = resolveHeld;
  }));
  return { proceed };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveDeferred!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolveDeferred = resolvePromise;
  });
  return { promise, resolve: resolveDeferred };
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

const settlement = (operation: Promise<unknown>): Promise<void> => operation.then(() => undefined, () => undefined);

/** Longer than one lock renewal interval, so exactly the first renewal check of a held lock becomes due. */
const PAST_ONE_RENEWAL_MS = 15_000;
/** The bound on one token request made under the refresh lock. The timeout case checks this figure against the request's abort signal. */
const REFRESH_REQUEST_TIMEOUT_MS = 15_000;

describe("auth file lock compromise", () => {
  const originalHome = process.env.HOME;
  const originalFetch = globalThis.fetch;
  let homeDir: string;
  let authPath: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(resolve(tmpdir(), "fusion-engine-auth-lock-compromise-"));
    process.env.HOME = homeDir;
    authPath = getFusionAuthPath(homeDir);
  });

  afterEach(async () => {
    lockIo.heldStats.clear();
    lockIo.watchers.clear();
    lockIo.events.length = 0;
    lockIo.thrown.length = 0;
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  /** The lock directory in the auth directory whose name matches; lock targets carry a sanitized provider segment, so they are found, not guessed. */
  function findLockDirectory(matches: (name: string) => boolean): string {
    const directory = dirname(authPath);
    const names = readdirSync(directory).filter(matches);
    expect(names).toHaveLength(1);
    return resolve(directory, names[0]!);
  }

  /** Hold the instance-login lock with an operation that stays inside it until `gate` resolves. */
  async function holdInstanceLoginLock<T>(finish: () => T) {
    const storage = createFusionAuthStorage();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const entered = deferred();
    const gate = deferred();
    const holder = storage.withProviderInstanceLoginLock!("anthropic", async () => {
      entered.resolve();
      await gate.promise;
      return finish();
    });
    const settled = settlement(holder);
    await expectFirst(entered.promise, { "the holder settling before its operation ran": settled });
    const lockDirectory = findLockDirectory((name) => name.endsWith(".instance-login.lock"));
    return { storage, holder, settled, gate, lockDirectory };
  }

  /** Let the first renewal check of a held lock become due and wait until the library has handled its result. */
  async function completeRenewalCheck(lockDirectory: string, settled: Promise<void>, advanceMs = PAST_ONE_RENEWAL_MS): Promise<void> {
    const completedBefore = lockIoCount("stat", "completed", lockDirectory);
    await vi.advanceTimersByTimeAsync(advanceMs);
    await expectFirst(lockIoReached("stat", "completed", lockDirectory, completedBefore + 1), {
      "the holder settling before the renewal check": settled,
    });
  }

  it("rejects the holder of an instance-login lock that was removed while held, and the lock can be taken again", async () => {
    const { storage, holder, settled, gate, lockDirectory } = await holdInstanceLoginLock(() => "login-product");

    rmdirSync(lockDirectory);
    await completeRenewalCheck(lockDirectory, settled);
    gate.resolve();

    await settled;
    expect(lockIo.thrown).toEqual([]);
    await expect(holder).rejects.toMatchObject({ code: "ECOMPROMISED" });
    await expect(storage.withProviderInstanceLoginLock!("anthropic", async () => "second-login")).resolves.toBe("second-login");
  });

  it("propagates the operation's own error when its lock was also lost", async () => {
    const operationError = new Error("login cancelled");
    const { holder, settled, gate, lockDirectory } = await holdInstanceLoginLock(() => {
      throw operationError;
    });

    rmdirSync(lockDirectory);
    await completeRenewalCheck(lockDirectory, settled);
    gate.resolve();

    await settled;
    expect(lockIo.thrown).toEqual([]);
    await expect(holder).rejects.toBe(operationError);
  });

  it("ignores a lost-lock report that arrives after the lock was released", async () => {
    const { holder, settled, gate, lockDirectory } = await holdInstanceLoginLock(() => "login-product");
    const statsStarted = lockIoCount("stat", "started", lockDirectory);
    const statsCompleted = lockIoCount("stat", "completed", lockDirectory);
    const removalsCompleted = lockIoCount("rmdir", "completed", lockDirectory);

    const renewalCheck = holdNextStat(lockDirectory);
    await vi.advanceTimersByTimeAsync(PAST_ONE_RENEWAL_MS);
    await expectFirst(lockIoReached("stat", "started", lockDirectory, statsStarted + 1), {
      "the holder settling before the renewal check started": settled,
    });
    gate.resolve();
    await expect(holder).resolves.toBe("login-product");
    await lockIoReached("rmdir", "completed", lockDirectory, removalsCompleted + 1);
    expect(existsSync(lockDirectory)).toBe(false);

    renewalCheck.proceed();
    await lockIoReached("stat", "completed", lockDirectory, statsCompleted + 1);
    expect(lockIo.thrown).toEqual([]);
  });

  it("refuses a credential write computed under a write lock another holder took over", async () => {
    const original = { type: "api_key" as const, key: "original" };
    const storage = createFusionAuthStorage();
    await storage.set("openrouter", original);
    const persistedBefore = readFileSync(authPath, "utf-8");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const entered = deferred();
    const gate = deferred();
    const write = storage.modify("openrouter", async () => {
      entered.resolve();
      await gate.promise;
      return { type: "api_key" as const, key: "computed-under-lost-lock" };
    });
    const settled = settlement(write);
    await expectFirst(entered.promise, { "the write settling before its callback ran": settled });
    const lockDirectory = findLockDirectory((name) => name === `${basename(authPath)}.lock`);

    const foreignHolderTime = new Date(Date.now() - 5_000);
    utimesSync(lockDirectory, foreignHolderTime, foreignHolderTime);
    await completeRenewalCheck(lockDirectory, settled);
    gate.resolve();

    await settled;
    expect(lockIo.thrown).toEqual([]);
    await expect(write).rejects.toMatchObject({ code: "ECOMPROMISED" });
    expect(readFileSync(authPath, "utf-8")).toBe(persistedBefore);
    expect(storage.get("openrouter")).toEqual(original);
    expect(createFusionAuthStorage().get("openrouter")).toEqual(original);
    expect(existsSync(lockDirectory)).toBe(true);

    rmdirSync(lockDirectory);
    await storage.set("groq", { type: "api_key", key: "after-lost-lock" });
    const fresh = createFusionAuthStorage();
    expect(fresh.get("groq")).toEqual({ type: "api_key", key: "after-lost-lock" });
    expect(fresh.get("openrouter")).toEqual(original);
  });

  const instance = { providerId: "anthropic-subscription", instanceId: "work" };

  /** Seed an instance OAuth credential that is due for a proactive refresh but that real time cannot expire while a case runs. */
  async function seedRefreshableInstance(): Promise<void> {
    await createFusionAuthStorage().setInstance(instance, {
      type: "oauth",
      access: "expiring-access",
      refresh: "single-use-refresh",
      expires: Date.now() + 60_000,
    });
  }

  it("fails a refresh whose lock was removed mid-request, serves the previous token and keeps the rotated one on disk", async () => {
    await seedRefreshableInstance();
    const requested = deferred();
    const respond = deferred();
    const fetchMock = vi.fn(async () => {
      requested.resolve();
      await respond.promise;
      return { ok: true, text: async () => JSON.stringify({ access_token: "rotated-access", refresh_token: "next-refresh", expires_in: 3600 }) };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = createFusionAuthStorage().getApiKey("anthropic-subscription", instance);
    const settled = settlement(pending);
    await expectFirst(requested.promise, { "getApiKey settling before the refresh request": settled });
    const lockDirectory = findLockDirectory((name) => name.endsWith(".refresh.lock"));

    rmdirSync(lockDirectory);
    await completeRenewalCheck(lockDirectory, settled, REFRESH_REQUEST_TIMEOUT_MS - 1);
    respond.resolve();

    await expect(pending).resolves.toBe("expiring-access");
    expect(lockIo.thrown).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(createFusionAuthStorage().getInstance(instance)).toMatchObject({ access: "rotated-access", refresh: "next-refresh" });
  });

  it("has no lock renewal check due when a hung refresh request reaches its timeout", async () => {
    await seedRefreshableInstance();
    const requested = deferred();
    const fetchMock = vi.fn((_url: string, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      requested.resolve();
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = createFusionAuthStorage().getApiKey("anthropic-subscription", instance);
    let hasSettled = false;
    const settled = settlement(pending).then(() => {
      hasSettled = true;
    });
    await expectFirst(requested.promise, { "getApiKey settling before the refresh request": settled });
    const signal = fetchMock.mock.calls[0]![1]!.signal!;
    const lockDirectory = findLockDirectory((name) => name.endsWith(".refresh.lock"));
    const checksAtRequest = lockIoCount("stat", "started", lockDirectory);

    await vi.advanceTimersByTimeAsync(REFRESH_REQUEST_TIMEOUT_MS - 1);
    expect(signal.aborted).toBe(false);
    expect(hasSettled).toBe(false);
    await expectFirst(lockIoIdle(lockDirectory), { "getApiKey settling before the request timeout": settled });
    const checksBeforeTimeout = lockIoCount("stat", "started", lockDirectory);

    await vi.advanceTimersByTimeAsync(2);
    expect(signal.aborted).toBe(true);
    await expect(pending).resolves.toBe("expiring-access");
    expect(lockIoCount("stat", "started", lockDirectory) - checksBeforeTimeout).toBe(0);
    // The lock was renewed during the request, so the empty timeout window is not an idle renewal timer.
    expect(checksBeforeTimeout).toBeGreaterThan(checksAtRequest);
    expect(lockIo.thrown).toEqual([]);
  });
});
