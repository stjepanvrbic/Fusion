import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginLoader } from "../plugins/plugin-loader.js";
import { PLUGIN_HOOK_RECEIVES_CONTEXT } from "../plugins/plugin-types.js";
import type { FusionPlugin, PluginInstallation, PluginSecurityScanResult } from "../plugins/plugin-types.js";
import { scanPluginSecurity } from "../plugins/plugin-security-scan.js";

vi.mock("../plugins/plugin-security-scan.js", () => ({ scanPluginSecurity: vi.fn() }));

type HookName = keyof FusionPlugin["hooks"];

interface Harness {
  imports: string[];
  live: Map<string, Set<symbol>>;
  unloads: string[];
  calls: Array<{ id: string; hook: string; args: unknown[] }>;
  behavior: Record<string, (id: string) => Promise<void> | void>;
  onLoadEntered: (id: string) => void;
}

const harness = (): Harness => (globalThis as unknown as { __plh: Harness }).__plh;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const ALL_HOOKS = Object.keys(PLUGIN_HOOK_RECEIVES_CONTEXT) as HookName[];

/** Each module import gets a fresh instance token, so the harness can count live instances per plugin. */
function moduleSource(id: string): string {
  const hooks = ALL_HOOKS.filter((name) => name !== "onLoad" && name !== "onUnload")
    .map((name) => `${name}: async (...args) => { const h = globalThis.__plh; h.calls.push({ id: ${JSON.stringify(id)}, hook: ${JSON.stringify(name)}, args }); const b = h.behavior[${JSON.stringify(`${id}:${name}`)}]; if (b) await b(${JSON.stringify(id)}); }`)
    .join(",\n    ");
  return `
const token = Symbol(${JSON.stringify(id)});
globalThis.__plh.imports.push(${JSON.stringify(id)});
export default {
  manifest: { id: ${JSON.stringify(id)}, name: ${JSON.stringify(id)}, version: "1.0.0", description: "fixture" },
  state: "installed",
  promptContributions: { contributions: [{ id: "c", content: "x" }] },
  hooks: {
    onLoad: async (ctx) => {
      const h = globalThis.__plh;
      h.onLoadEntered(${JSON.stringify(id)});
      const b = h.behavior[${JSON.stringify(`${id}:onLoad`)}];
      if (b) await b(${JSON.stringify(id)});
      if (!h.live.has(${JSON.stringify(id)})) h.live.set(${JSON.stringify(id)}, new Set());
      h.live.get(${JSON.stringify(id)}).add(token);
    },
    onUnload: async () => {
      const h = globalThis.__plh;
      h.unloads.push(${JSON.stringify(id)});
      h.live.get(${JSON.stringify(id)})?.delete(token);
    },
    ${hooks}
  },
};
`;
}

async function createProject(ids: string[]) {
  const root = await mkdtemp(join(tmpdir(), "fusion-plugin-hardening-"));
  const records = new Map<string, PluginInstallation>();
  for (const id of ids) {
    const entry = join(root, `${id}.mjs`);
    await writeFile(entry, moduleSource(id));
    records.set(id, {
      id, name: id, version: "1.0.0", description: "fixture", path: entry,
      enabled: true, state: "installed", settings: {}, dependencies: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
  }
  return { root, records };
}

function createStores(project: { root: string; records: Map<string, PluginInstallation> }) {
  const { root, records } = project;
  const events = new EventEmitter();
  const pluginStore = {
    getPlugin: vi.fn(async (id: string) => {
      const record = records.get(id);
      if (!record) throw Object.assign(new Error(`Plugin "${id}" not found`), { code: "ENOENT" });
      return { ...record };
    }),
    listPlugins: vi.fn(async () => [...records.values()].map((record) => ({ ...record }))),
    updatePluginState: vi.fn(async (id: string, state: PluginInstallation["state"], error?: string) => {
      const record = records.get(id);
      if (!record) throw Object.assign(new Error(`Plugin "${id}" not found`), { code: "ENOENT" });
      const prior = record.state;
      record.state = state;
      if (error !== undefined) record.error = error;
      else if (prior !== state) delete record.error;
      return { ...record };
    }),
    updatePlugin: vi.fn(async (id: string, updates: Partial<PluginInstallation>) => {
      const record = records.get(id)!;
      Object.assign(record, updates);
      return { ...record };
    }),
    on: events.on.bind(events),
    off: events.off.bind(events),
  };
  const taskStore = {
    getRootDir: () => root,
    preflightPluginSchema: vi.fn(() => null),
    runPluginSchemaInits: vi.fn(async () => undefined),
    recordPluginActivation: vi.fn(),
  };
  return { pluginStore, taskStore };
}

function createLoader(project: { root: string; records: Map<string, PluginInstallation> }, options: Record<string, unknown> = {}) {
  const stores = createStores(project);
  const loader = new PluginLoader({ pluginStore: stores.pluginStore as never, taskStore: stores.taskStore as never, ...options });
  return { loader, ...stores };
}

function scanResult(verdict: PluginSecurityScanResult["verdict"]): PluginSecurityScanResult {
  return { verdict, summary: `scan ${verdict}`, findings: [], scannedFiles: [], scannedAt: new Date().toISOString() } as unknown as PluginSecurityScanResult;
}

const liveCount = (id: string) => harness().live.get(id)?.size ?? 0;

describe("PluginLoader lifecycle hardening", () => {
  const roots: string[] = [];

  beforeEach(() => {
    (globalThis as unknown as { __plh: Harness }).__plh = {
      imports: [], live: new Map(), unloads: [], calls: [], behavior: {}, onLoadEntered: () => undefined,
    };
    vi.mocked(scanPluginSecurity).mockReset();
    vi.mocked(scanPluginSecurity).mockResolvedValue(scanResult("clean"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>).__plh;
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function project(ids: string[]) {
    const p = await createProject(ids);
    roots.push(p.root);
    return p;
  }

  describe("security scan gates every code-import path", () => {
    for (const verdict of ["blocked", "error", "unavailable"] as const) {
      it(`reload never imports replacement code after a ${verdict} scan, and unloads the old instance`, async () => {
        const p = await project(["scanned"]);
        const host = createLoader(p);
        const engine = createLoader(p);
        await host.loader.loadPlugin("scanned");
        await engine.loader.loadPlugin("scanned");
        expect(harness().imports).toEqual(["scanned"]);

        p.records.get("scanned")!.aiScanOnLoad = true;
        vi.mocked(scanPluginSecurity).mockResolvedValue(scanResult(verdict));

        await expect(engine.loader.reloadPlugin("scanned")).rejects.toThrow(`Security scan ${verdict}`);

        expect(harness().imports).toEqual(["scanned"]);
        expect(liveCount("scanned")).toBe(0);
        expect(host.loader.isPluginLoaded("scanned")).toBe(false);
        expect(engine.loader.isPluginLoaded("scanned")).toBe(false);
        expect(p.records.get("scanned")).toMatchObject({ state: "error", lastSecurityScan: { verdict } });
      });

      it(`initial load never imports code after a ${verdict} scan`, async () => {
        const p = await project(["scanned"]);
        p.records.get("scanned")!.aiScanOnLoad = true;
        vi.mocked(scanPluginSecurity).mockResolvedValue(scanResult(verdict));
        const { loader } = createLoader(p);

        await expect(loader.loadPlugin("scanned")).rejects.toThrow(`Security scan ${verdict}`);

        expect(harness().imports).toEqual([]);
        expect(p.records.get("scanned")!.state).toBe("error");
      });
    }

    it("reload imports the replacement after a clean scan", async () => {
      const p = await project(["scanned"]);
      const { loader } = createLoader(p);
      await loader.loadPlugin("scanned");
      p.records.get("scanned")!.aiScanOnLoad = true;

      await loader.reloadPlugin("scanned");

      expect(scanPluginSecurity).toHaveBeenCalledTimes(1);
      expect(harness().imports).toEqual(["scanned", "scanned"]);
      expect(liveCount("scanned")).toBe(1);
    });
  });

  describe("per-plugin hook bounds", () => {
    it("bounds a never-settling initial onLoad, unloads the instance, and fences late completion", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const p = await project(["hang", "healthy"]);
      const release = deferred();
      const entered = deferred();
      harness().behavior["hang:onLoad"] = () => release.promise;
      harness().onLoadEntered = (id) => { if (id === "hang") entered.resolve(); };
      const { loader } = createLoader(p, { onLoadTimeoutMs: 1_000 });

      const loadAll = loader.loadAllPlugins();
      await entered.promise;
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(loadAll).resolves.toEqual({ loaded: 1, errors: 1 });
      expect(loader.isPluginLoaded("hang")).toBe(false);
      expect(loader.isPluginLoaded("healthy")).toBe(true);
      expect(p.records.get("hang")!.state).toBe("error");
      expect(harness().unloads).toContain("hang");

      release.resolve();
      await vi.waitFor(() => expect(harness().unloads.filter((id) => id === "hang")).toHaveLength(2));
      expect(liveCount("hang")).toBe(0);
    });

    it("unloads the new instance when its reload onLoad times out, leaving one live instance", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const p = await project(["reloading"]);
      const { loader } = createLoader(p);
      await loader.loadPlugin("reloading");

      const release = deferred();
      const entered = deferred();
      let loads = 0;
      harness().onLoadEntered = () => { loads += 1; if (loads === 1) entered.resolve(); };
      harness().behavior["reloading:onLoad"] = () => (loads === 1 ? release.promise : undefined);

      const reload = loader.reloadPlugin("reloading", { timeoutMs: 500 });
      const settled = reload.catch((error: unknown) => error);
      await entered.promise;
      await vi.advanceTimersByTimeAsync(500);

      expect(await settled).toBeInstanceOf(Error);
      expect(loader.isPluginLoaded("reloading")).toBe(true);
      expect(liveCount("reloading")).toBe(1);

      release.resolve();
      await vi.waitFor(() => expect(harness().unloads.length).toBeGreaterThanOrEqual(3));
      expect(liveCount("reloading")).toBe(1);
    });

    it("advances past a hanging task hook so later plugins still receive the event", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const p = await project(["first", "second"]);
      const { loader } = createLoader(p, { hookTimeoutMs: 1_000 });
      await loader.loadAllPlugins();
      harness().behavior["first:onTaskCreated"] = () => new Promise(() => undefined);
      harness().behavior["first:onError"] = () => new Promise(() => undefined);

      let done = false;
      const dispatch = loader.invokeHook("onTaskCreated", { id: "FN-1" }).then(() => { done = true; });
      for (let i = 0; i < 20 && !done; i += 1) await vi.advanceTimersByTimeAsync(1_000);
      await dispatch;

      expect(harness().calls.filter((c) => c.hook === "onTaskCreated").map((c) => c.id)).toEqual(["first", "second"]);
      expect(loader.getPlugin("first")!.state).toBe("started");
    });
  });

  describe("lifecycle queue ordering", () => {
    async function reloadStopReload(sameLoader: boolean, failFirst: boolean) {
      const p = await project(["queued"]);
      const host = createLoader(p);
      const engine = sameLoader ? host : createLoader(p);
      await host.loader.loadPlugin("queued");
      await engine.loader.loadPlugin("queued");

      const gate = deferred();
      let first = true;
      harness().behavior["queued:onLoad"] = async () => {
        if (!first) return;
        first = false;
        await gate.promise;
        if (failFirst) throw new Error("first reload fails");
      };
      const r1 = host.loader.reloadPlugin("queued");
      await vi.waitFor(() => expect(harness().unloads).toEqual(["queued"]));
      // Force queue order R1 -> stop -> R2: hold R2's record lookup until the stop has enqueued.
      const stop = engine.loader.stopPlugin("queued");
      const r2Lookup = deferred();
      const lookup = host.pluginStore.getPlugin.getMockImplementation()!;
      host.pluginStore.getPlugin.mockImplementationOnce(async (id: string) => {
        await r2Lookup.promise;
        return lookup(id);
      });
      const r2 = host.loader.reloadPlugin("queued");
      await new Promise((resolve) => setImmediate(resolve));
      r2Lookup.resolve();
      gate.resolve();

      const results = await Promise.allSettled([r1, stop, r2]);
      expect(results[0].status).toBe(failFirst ? "rejected" : "fulfilled");
      expect(results[1].status).toBe("fulfilled");
      return { host, engine, results };
    }

    it("completes a reload -> stop -> reload interleaving on one loader", async () => {
      const { host, results } = await reloadStopReload(true, false);
      expect(results[2].status).toBe("rejected");
      expect(host.loader.isPluginLoaded("queued")).toBe(false);
      expect(liveCount("queued")).toBe(0);
    });

    it("completes a reload -> stop -> reload interleaving across host and engine loaders", async () => {
      const { host, engine, results } = await reloadStopReload(false, false);
      expect(results[2].status).toBe("fulfilled");
      expect(host.loader.isPluginLoaded("queued")).toBe(true);
      expect(engine.loader.isPluginLoaded("queued")).toBe(false);
      expect(liveCount("queued")).toBe(1);
    });

    it("completes the interleaving when the first reload fails", async () => {
      const { results } = await reloadStopReload(false, true);
      expect(results[2].status).toBe("fulfilled");
      expect(liveCount("queued")).toBe(1);
    });
  });

  describe("hook failures do not change lifecycle state", () => {
    it("records a hook throw while the plugin stays started and keeps contributing", async () => {
      const p = await project(["flaky"]);
      const { loader, pluginStore } = createLoader(p);
      await loader.loadPlugin("flaky");
      harness().behavior["flaky:onTaskMoved"] = () => { throw new Error("transient db error"); };

      await loader.invokeHook("onTaskMoved", { id: "FN-1" }, "todo", "in-progress");

      expect(loader.getPlugin("flaky")!.state).toBe("started");
      expect(p.records.get("flaky")).toMatchObject({ state: "started", error: expect.stringContaining("transient db error") });
      expect(pluginStore.updatePluginState).not.toHaveBeenCalledWith("flaky", "error", expect.anything());
      expect(loader.getPluginPromptContributions().map((c) => c.pluginId)).toEqual(["flaky"]);
    });

    it("loadPlugin reconciles a stale error state when the plugin is already loaded", async () => {
      const p = await project(["stale"]);
      const { loader } = createLoader(p);
      await loader.loadPlugin("stale");
      p.records.get("stale")!.state = "error";

      await loader.loadPlugin("stale");

      expect(p.records.get("stale")!.state).toBe("started");
      expect(harness().imports).toEqual(["stale"]);
    });

    it("a successful reload of a loaded plugin with a stale error state persists started", async () => {
      const p = await project(["stale"]);
      const { loader } = createLoader(p);
      await loader.loadPlugin("stale");
      p.records.get("stale")!.state = "error";

      await loader.reloadPlugin("stale");

      expect(p.records.get("stale")!.state).toBe("started");
    });
  });

  describe("hook context", () => {
    it("appends a PluginContext to every hook whose signature declares one", async () => {
      const p = await project(["ctx"]);
      const { loader } = createLoader(p);
      await loader.loadPlugin("ctx");
      const dispatched = ALL_HOOKS.filter((name) => name !== "onLoad" && name !== "onUnload");

      for (const hookName of dispatched) {
        await loader.invokeHook(hookName, "raw-arg");
      }

      for (const hookName of dispatched) {
        const call = harness().calls.find((c) => c.hook === hookName);
        expect(call, hookName).toBeDefined();
        const last = call!.args.at(-1) as { pluginId?: string; logger?: unknown };
        if (PLUGIN_HOOK_RECEIVES_CONTEXT[hookName]) {
          expect(call!.args[0], hookName).toBe("raw-arg");
          expect(last.pluginId, hookName).toBe("ctx");
          expect(last.logger, hookName).toBeDefined();
        } else {
          expect(call!.args, hookName).toEqual(["raw-arg"]);
        }
      }
    });
  });

  describe("stop after uninstall or disable", () => {
    it("stops a loaded plugin whose store record was deleted", async () => {
      const p = await project(["gone"]);
      const { loader } = createLoader(p);
      await loader.loadPlugin("gone");
      p.records.delete("gone");

      await loader.stopPlugin("gone");

      expect(harness().unloads).toEqual(["gone"]);
      expect(liveCount("gone")).toBe(0);
      expect(loader.isPluginLoaded("gone")).toBe(false);
    });

    it("a participant stop after uninstall unloads the owner's instance in every loader", async () => {
      const p = await project(["gone"]);
      const host = createLoader(p);
      const engine = createLoader(p);
      await host.loader.loadPlugin("gone");
      await engine.loader.loadPlugin("gone");
      const engineUnloaded = vi.fn();
      engine.loader.on("plugin:unloaded", engineUnloaded);
      p.records.delete("gone");

      await engine.loader.stopPlugin("gone");

      expect(liveCount("gone")).toBe(0);
      expect(host.loader.isPluginLoaded("gone")).toBe(false);
      expect(engine.loader.isPluginLoaded("gone")).toBe(false);
      expect(engineUnloaded).toHaveBeenCalledWith({ pluginId: "gone" });
    });

    it("a participant stop of a disabled plugin unloads it in every loader", async () => {
      const p = await project(["off"]);
      const host = createLoader(p);
      const engine = createLoader(p);
      await host.loader.loadPlugin("off");
      await engine.loader.loadPlugin("off");
      p.records.get("off")!.enabled = false;

      await engine.loader.stopPlugin("off");

      expect(liveCount("off")).toBe(0);
      expect(host.loader.isPluginLoaded("off")).toBe(false);
      expect(p.records.get("off")!.state).toBe("stopped");
    });

    it("a participant stop of a still-enabled plugin only detaches that loader's view", async () => {
      const p = await project(["kept"]);
      const host = createLoader(p);
      const engine = createLoader(p);
      await host.loader.loadPlugin("kept");
      await engine.loader.loadPlugin("kept");
      const engineUnloaded = vi.fn();
      engine.loader.on("plugin:unloaded", engineUnloaded);

      await engine.loader.stopPlugin("kept");

      expect(liveCount("kept")).toBe(1);
      expect(host.loader.isPluginLoaded("kept")).toBe(true);
      expect(engine.loader.isPluginLoaded("kept")).toBe(false);
      expect(engineUnloaded).toHaveBeenCalledWith({ pluginId: "kept" });
    });
  });
});
