import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  let settings: Record<string, unknown> = {};
  let latestTui: FakeDashboardTui | undefined;
  let resolveTuiReady: ((tui: FakeDashboardTui) => void) | undefined;
  let tuiReady = new Promise<FakeDashboardTui>((resolve) => { resolveTuiReady = resolve; });
  let resolveTaskStoreBarrier: (() => void) | undefined;
  let taskStoreBarrier: Promise<void> = Promise.resolve();

  class FakeDashboardTui {
    settingsPayloads: Array<Record<string, unknown>> = [];
    callbackPayloads: Array<Record<string, unknown>> = [];
    callbacks: Record<string, unknown> = {};
    interactiveData: Record<string, unknown> = {};
    boardScopedProjectPath: string | null = null;

    constructor() {
      latestTui = this;
      resolveTuiReady?.(this);
    }

    start = vi.fn(async () => undefined);
    stop = vi.fn(async () => undefined);
    setLoadingStatus = vi.fn();
    setSystemInfo = vi.fn();
    setReady = vi.fn();
    setTaskStats = vi.fn();
    setInteractiveData = vi.fn((data: Record<string, unknown>) => { this.interactiveData = data; });
    onBoardScopeChange = vi.fn();
    hydrateVitestKillSettings = vi.fn();
    log = vi.fn();
    setCallbacks = vi.fn((callbacks: Record<string, unknown>) => {
      this.callbackPayloads.push(callbacks);
      this.callbacks = callbacks;
    });
    setSettings = vi.fn((payload: Record<string, unknown>) => { this.settingsPayloads.push(payload); });
  }

  class FakeLogSink {
    setTUI = vi.fn();
    captureConsole = vi.fn();
    log = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    getRecentEntries = vi.fn(() => []);
    silence = vi.fn();
  }

  const events: string[] = [];
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  const emitStoreEvent = (event: string, ...args: unknown[]) => {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  };
  const store: Record<string, any> = {
    on: (event: string, listener: (...args: any[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return store;
    },
    listenerCount: (event: string) => listeners.get(event)?.length ?? 0,
    off: (event: string, listener: (...args: any[]) => void) => {
      listeners.set(event, (listeners.get(event) ?? []).filter((candidate) => candidate !== listener));
      return store;
    },
  };
  Object.assign(store, {
    init: vi.fn(async () => undefined),
    watch: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    getAsyncLayer: vi.fn(() => ({})),
    getFusionDir: vi.fn(() => "/repo/.fusion"),
    getRootDir: vi.fn(() => "/repo"),
    getSettings: vi.fn(async () => settings),
    updateSettings: vi.fn(async (patch: Record<string, unknown>) => {
      settings = { ...settings, ...patch };
    }),
    getGlobalSettingsStore: vi.fn(() => ({ getSettings: vi.fn(async () => ({})), updateSettings: vi.fn(async () => undefined) })),
    getPluginStore: vi.fn(() => ({ init: vi.fn(async () => undefined) })),
    healthCheck: vi.fn(async () => ({ ok: true })),
    isBackendMode: vi.fn(() => false),
    listTasks: vi.fn(async () => []),
  });

  const appListeners = new Map<string, Array<(...args: any[]) => void>>();
  const app: Record<string, any> = {
    on: (event: string, listener: (...args: any[]) => void) => {
      appListeners.set(event, [...(appListeners.get(event) ?? []), listener]);
      return app;
    },
    off: (event: string, listener: (...args: any[]) => void) => {
      appListeners.set(event, (appListeners.get(event) ?? []).filter((candidate) => candidate !== listener));
      return app;
    },
  };
  Object.assign(app, {
    listen: vi.fn(() => {
      queueMicrotask(() => appListeners.get("listening")?.forEach((listener) => listener()));
      return app;
    }),
    address: vi.fn(() => ({ port: 0 })),
    close: vi.fn(),
  });

  return {
    FakeDashboardTui,
    FakeLogSink,
    app,
    store,
    getSettings: () => settings,
    latestTui: () => latestTui,
    waitForTui: () => tuiReady,
    emitStoreEvent,
    holdTaskStore: () => {
      taskStoreBarrier = new Promise<void>((resolve) => { resolveTaskStoreBarrier = resolve; });
    },
    releaseTaskStore: () => resolveTaskStoreBarrier?.(),
    createTaskStore: async () => {
      await taskStoreBarrier;
      return { taskStore: store, shutdown: vi.fn(async () => { events.push("backend.shutdown"); }) };
    },
    events,
    setSettings: (next: Record<string, unknown>) => { settings = next; },
    reset: () => {
      resolveTaskStoreBarrier?.();
      settings = {};
      latestTui = undefined;
      resolveTuiReady = undefined;
      tuiReady = new Promise<FakeDashboardTui>((resolve) => { resolveTuiReady = resolve; });
      taskStoreBarrier = Promise.resolve();
      resolveTaskStoreBarrier = undefined;
      events.length = 0;
      vi.clearAllMocks();
    },
  };
});

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  class NoopStore {
    init = vi.fn(async () => undefined);
    on = vi.fn();
    off = vi.fn();
    close = vi.fn(async () => undefined);
  }
  return {
    ...actual,
    createTaskStoreForBackend: vi.fn(() => harness.createTaskStore()),
    AutomationStore: NoopStore,
    AgentStore: class extends NoopStore { listAgents = vi.fn(async () => []); },
    PluginLoader: class { loadAllPlugins = vi.fn(async () => ({ loaded: 0, errors: 0 })); getPluginSkills = vi.fn(() => []); },
    MissionStore: NoopStore,
    CentralCore: class {
      init = vi.fn(async () => undefined);
      listProjects = vi.fn(async () => []);
      listNodes = vi.fn(async () => []);
      getProjectByPath = vi.fn(async () => undefined);
      close = vi.fn(async () => { harness.events.push("centralCore.close"); });
    },
    setHostTaskStore: vi.fn(),
    setDiagnosticDbHealthCheck: vi.fn(),
    setDiagnosticStoreListenerCheck: vi.fn(),
  };
});

vi.mock("@fusion/dashboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/dashboard")>()),
  createServer: vi.fn(() => harness.app),
  refreshAllCustomProviderModels: vi.fn(async () => ({ refreshed: 0, failed: 0, skipped: 0 })),
  stopAllDevServers: vi.fn(async () => undefined),
}));

vi.mock("../dashboard-tui/index.js", () => ({
  DashboardTUI: harness.FakeDashboardTui,
  DashboardLogSink: harness.FakeLogSink,
  isTTYAvailable: vi.fn(() => true),
}));

vi.mock("../dashboard-startup-chain.js", () => ({
  DASHBOARD_STARTUP_STATUS: {
    initializingTaskStore: "Initializing task store…",
    initializingAgentStore: "Initializing agent store…",
    startingAgents: "Starting agents…",
    loadingExtensions: "Loading extensions…",
    startingEngine: "Starting engine…",
  },
  runTuiStartupPrelude: vi.fn(async (tui: { start: () => Promise<void>; setLoadingStatus: (status: string) => void }) => {
    await tui.start();
    tui.setLoadingStatus("Initializing task store…");
  }),
}));


vi.mock("@fusion/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/engine")>();
  return {
    ...actual,
    ProjectEngineManager: class {
      startAll = vi.fn(async () => undefined);
      startReconciliation = vi.fn();
      ensureEngine = vi.fn(async () => undefined);
      getEngine = vi.fn(() => undefined);
      getAllEngines = vi.fn(() => new Map());
      onProjectAccessed = vi.fn();
      beginDrain = vi.fn();
      stopAll = vi.fn(async () => { harness.events.push("engineManager.stopAll"); });
    },
    PeerExchangeService: class {
      start = vi.fn();
      stop = vi.fn(async () => undefined);
      updateGlobalSettings = vi.fn();
    },
    shouldUseHybridExecutor: vi.fn(async () => ({ enabled: false, reason: "test" })),
    startCloudLinkPresence: vi.fn(async () => undefined),
    stopCloudLinkPresence: vi.fn(async () => undefined),
  };
});

const { isEmbeddedPostgresSignalShutdownClaimed } = await import("@fusion/core");
const { runDashboard } = await import("../dashboard.js");

type SignalListener = (...args: unknown[]) => void;
const HARD_EXIT_WATCHDOG_MS = 3000;

/**
 * FNXC:PostgresShutdownOrder 2026-10-07-19:50:
 * Ctrl+C must stop every engine before the shared PostgreSQL backend, and the embedded lifecycle's own signal hook must not stop the database first or re-raise the signal into a premature second-signal exit.
 */
describe("dashboard shutdown order", () => {
  let baseline: Record<"SIGINT" | "SIGTERM" | "SIGHUP", SignalListener[]>;

  beforeEach(() => {
    harness.reset();
    baseline = {
      SIGINT: process.listeners("SIGINT") as SignalListener[],
      SIGTERM: process.listeners("SIGTERM") as SignalListener[],
      SIGHUP: process.listeners("SIGHUP") as SignalListener[],
    };
  });

  afterEach(() => {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      for (const listener of process.listeners(signal) as SignalListener[]) {
        if (!baseline[signal].includes(listener)) process.removeListener(signal, listener);
      }
    }
    vi.restoreAllMocks();
  });

  async function interruptAndAwaitExit(): Promise<void> {
    const added = (process.listeners("SIGINT") as SignalListener[]).filter((listener) => !baseline.SIGINT.includes(listener));
    expect(added).toHaveLength(1);
    let exited!: () => void;
    const exitReached = new Promise<void>((resolve) => { exited = resolve; });
    vi.spyOn(process, "exit").mockImplementation((() => {
      harness.events.push("process.exit");
      exited();
    }) as never);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    // Drop only the dashboard's 3s hard-exit watchdog; left armed it would call process.exit after the test.
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms?: number, ...args: unknown[]) =>
      ms === HARD_EXIT_WATCHDOG_MS
        ? ({ unref() { return this; }, ref() { return this; } } as unknown as NodeJS.Timeout)
        : realSetTimeout(callback, ms, ...args)) as never);
    added[0]!("SIGINT");
    await exitReached;
    expect(kill).not.toHaveBeenCalled();
  }

  it("UI-only mode claims signal shutdown and releases the backend before exiting", async () => {
    await runDashboard(0, { noEngine: true, noAuth: true });
    expect(isEmbeddedPostgresSignalShutdownClaimed()).toBe(true);

    await interruptAndAwaitExit();

    expect(harness.events.indexOf("backend.shutdown")).toBeGreaterThanOrEqual(0);
    expect(harness.events.indexOf("backend.shutdown")).toBeLessThan(harness.events.indexOf("process.exit"));
    expect(isEmbeddedPostgresSignalShutdownClaimed()).toBe(false);
  });

  it("engine mode stops every engine before the PostgreSQL backend, then exits", async () => {
    await runDashboard(0, { noAuth: true });
    expect(isEmbeddedPostgresSignalShutdownClaimed()).toBe(true);

    await interruptAndAwaitExit();

    const engineStop = harness.events.indexOf("engineManager.stopAll");
    const backendStop = harness.events.indexOf("backend.shutdown");
    expect(engineStop).toBeGreaterThanOrEqual(0);
    expect(engineStop).toBeLessThan(backendStop);
    expect(backendStop).toBeLessThan(harness.events.lastIndexOf("process.exit"));
    expect(isEmbeddedPostgresSignalShutdownClaimed()).toBe(false);
  });
});
