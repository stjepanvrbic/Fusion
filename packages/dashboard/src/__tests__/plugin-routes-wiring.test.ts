// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import express from "express";

import { createPluginRouter } from "../plugin-routes.js";
import { get as performGet, request as performRequest } from "../test-request.js";

const { pluginRoutesLogger } = vi.hoisted(() => ({
  pluginRoutesLogger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return {
    ...actual,
    createLogger: (name: string) => (name === "dashboard-plugin-routes" ? pluginRoutesLogger : actual.createLogger(name)),
  };
});

describe("createPluginRouter wiring under /api/plugins", () => {
  function buildApp() {
    const enablePlugin = vi.fn(async (id: string) => ({ id, enabled: true }));
    const pluginStore = {
      listPlugins: vi.fn(async () => [{ id: "test-plugin", name: "Test Plugin", enabled: false }]),
      getPlugin: vi.fn(async (id: string) => ({ id, settings: {}, enabled: false, manifest: { id, name: id, version: "1.0.0", description: "" } })),
      enablePlugin,
      disablePlugin: vi.fn(),
      registerPlugin: vi.fn(),
      unregisterPlugin: vi.fn(),
      updatePluginSettings: vi.fn(),
      updatePluginState: vi.fn(),
    } as any;

    const taskStore = {
      listTasks: vi.fn(async () => []),
    } as any;

    const helloHandler = vi.fn(async () => ({ ok: true }));
    const collidingEnableHandler = vi.fn(async () => ({ pluginEnable: true }));
    const taskStoreHandler = vi.fn(async (_req: unknown, ctx: { taskStore: { listTasks: () => Promise<unknown[]> } }) => {
      await ctx.taskStore.listTasks();
      return { usedTaskStore: true };
    });

    const pluginLoader = {
      getPlugin: vi.fn((id: string) => {
        if (id === "test-plugin" || id === "collision-plugin") {
          return { manifest: { id } };
        }
        return undefined;
      }),
      createRouteContext: vi.fn(async (_id: string, overrides: { taskStore: unknown; settings: Record<string, unknown> }) => ({
        pluginId: "test-plugin",
        taskStore: overrides.taskStore,
        settings: overrides.settings,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        emitEvent: vi.fn(),
      })),
      loadPlugin: vi.fn(),
      stopPlugin: vi.fn(),
    } as any;

    const pluginRunner = {
      getPluginRoutes: vi.fn(() => [
        { pluginId: "test-plugin", route: { method: "GET", path: "/hello", handler: helloHandler } },
        { pluginId: "test-plugin", route: { method: "GET", path: "/use-task-store", handler: taskStoreHandler } },
        { pluginId: "collision-plugin", route: { method: "POST", path: "/enable", handler: collidingEnableHandler } },
      ]),
    } as any;

    const app = express();
    app.use(express.json());
    app.use("/api/plugins", createPluginRouter(pluginStore, pluginLoader, pluginRunner, taskStore));
    app.use((_req, res) => res.status(404).json({ error: "Not found" }));

    return {
      app,
      pluginStore,
      taskStore,
      handlers: { helloHandler, collidingEnableHandler, taskStoreHandler },
    };
  }

  it("resolves plugin-defined dynamic GET route", async () => {
    const { app } = buildApp();
    const res = await performGet(app, "/api/plugins/test-plugin/hello");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("keeps management routes working alongside dynamic routes", async () => {
    const { app, pluginStore } = buildApp();

    const list = await performGet(app, "/api/plugins/");
    expect(list.status).toBe(200);
    expect(pluginStore.listPlugins).toHaveBeenCalled();

    const enable = await performRequest(app, "POST", "/api/plugins/test-plugin/enable");
    expect(enable.status).toBe(200);
    expect(pluginStore.enablePlugin).toHaveBeenCalledWith("test-plugin");
  });

  it("prioritizes management /:id/enable over plugin-defined /enable route collisions", async () => {
    const { app, pluginStore, handlers } = buildApp();

    const res = await performRequest(app, "POST", "/api/plugins/collision-plugin/enable");
    expect(res.status).toBe(200);
    expect(pluginStore.enablePlugin).toHaveBeenCalledWith("collision-plugin");
    expect(handlers.collidingEnableHandler).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", "/api/plugins/does-not-exist/anything", 404],
    ["GET", "/api/plugins/missing/hello", 404],
  ])("returns %i for unknown plugin IDs (%s %s)", async (method, path, expectedStatus) => {
    const { app } = buildApp();
    const res = await performRequest(app, method as "GET", path);
    expect(res.status).toBe(expectedStatus);
  });

  it("plumbs default taskStore to plugin route context", async () => {
    const { app, taskStore, handlers } = buildApp();

    const res = await performGet(app, "/api/plugins/test-plugin/use-task-store");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ usedTaskStore: true });
    expect(taskStore.listTasks).toHaveBeenCalled();
    expect(handlers.taskStoreHandler).toHaveBeenCalled();
  });

  /*
  FNXC:PluginRoutes 2026-07-22-09:55:
  UI-only / --no-engine dashboards pass pluginRunner=undefined (Grok dual-remediation)
  while still loading plugins on pluginLoader. Compound Engineering's bundled view then
  painted while /sessions and /artifacts hit the catch-all 404 "Not found". Mount routes
  from the loader when the runner is absent so CE and other plugin APIs stay reachable.
  */
  it("mounts plugin-defined routes from pluginLoader when pluginRunner is undefined", async () => {
    const sessionsHandler = vi.fn(async () => ({ sessions: [] }));
    const artifactsHandler = vi.fn(async () => ({ groups: [], totalArtifacts: 0, totalErrors: 0 }));
    const startHandler = vi.fn(async () => ({ session: { id: "ce-1", status: "launching" } }));

    const pluginStore = {
      listPlugins: vi.fn(async () => [{ id: "fusion-plugin-compound-engineering", name: "Compound Engineering", enabled: true }]),
      getPlugin: vi.fn(async (id: string) => ({ id, settings: {}, enabled: true, manifest: { id, name: id, version: "0.1.0", description: "" } })),
      enablePlugin: vi.fn(),
      disablePlugin: vi.fn(),
      registerPlugin: vi.fn(),
      unregisterPlugin: vi.fn(),
      updatePluginSettings: vi.fn(),
      updatePluginState: vi.fn(),
    } as any;

    const pluginLoader = {
      getPlugin: vi.fn((id: string) => (id === "fusion-plugin-compound-engineering" ? { manifest: { id } } : undefined)),
      getPluginRoutes: vi.fn(() => [
        { pluginId: "fusion-plugin-compound-engineering", route: { method: "GET", path: "/sessions", handler: sessionsHandler } },
        { pluginId: "fusion-plugin-compound-engineering", route: { method: "GET", path: "/artifacts", handler: artifactsHandler } },
        { pluginId: "fusion-plugin-compound-engineering", route: { method: "POST", path: "/sessions", handler: startHandler } },
      ]),
      createRouteContext: vi.fn(async () => ({
        pluginId: "fusion-plugin-compound-engineering",
        taskStore: {},
        settings: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        emitEvent: vi.fn(),
      })),
      loadPlugin: vi.fn(),
      stopPlugin: vi.fn(),
    } as any;

    const app = express();
    app.use(express.json());
    // No pluginRunner — mirrors UI-only dashboard wiring.
    app.use("/api/plugins", createPluginRouter(pluginStore, pluginLoader, undefined, {} as any));
    app.use((_req, res) => res.status(404).json({ error: "Not found" }));

    const sessions = await performGet(app, "/api/plugins/fusion-plugin-compound-engineering/sessions");
    expect(sessions.status).toBe(200);
    expect(sessions.body).toEqual({ sessions: [] });
    expect(sessionsHandler).toHaveBeenCalled();

    const artifacts = await performGet(app, "/api/plugins/fusion-plugin-compound-engineering/artifacts");
    expect(artifacts.status).toBe(200);
    expect(artifacts.body).toEqual({ groups: [], totalArtifacts: 0, totalErrors: 0 });
    expect(artifactsHandler).toHaveBeenCalled();

    const started = await performRequest(
      app,
      "POST",
      "/api/plugins/fusion-plugin-compound-engineering/sessions",
      JSON.stringify({ stage: "strategy" }),
      { "content-type": "application/json" },
    );
    expect(started.status).toBe(200);
    expect(started.body).toEqual({ session: { id: "ce-1", status: "launching" } });
    expect(startHandler).toHaveBeenCalled();
  });

  /*
  FNXC:PluginRoutes 2026-07-22-20:30:
  Plugin routes were a boot-time snapshot of the launch loader. Two failure modes survived
  the loader-mount fix above: a plugin enabled AFTER boot rendered its dashboard view
  (served live) while its API routes 404'd until restart, and a plugin enabled only in a
  NON-LAUNCH project never got routes at all. Dispatch is per-request now — these tests
  pin both invariants.
  */
  it("serves routes for a plugin enabled after the router was created (no restart)", async () => {
    const helloHandler = vi.fn(async () => ({ ok: true }));
    const routeTable: Array<{ pluginId: string; route: { method: string; path: string; handler: unknown } }> = [];

    const pluginStore = {
      listPlugins: vi.fn(async () => []),
      getPlugin: vi.fn(async (id: string) => ({ id, settings: {}, enabled: true, manifest: { id, name: id, version: "1.0.0", description: "" } })),
      enablePlugin: vi.fn(),
      disablePlugin: vi.fn(),
      registerPlugin: vi.fn(),
      unregisterPlugin: vi.fn(),
      updatePluginSettings: vi.fn(),
      updatePluginState: vi.fn(),
    } as any;

    const pluginLoader = {
      getPlugin: vi.fn((id: string) => (id === "late-plugin" && routeTable.length > 0 ? { manifest: { id } } : undefined)),
      getPluginRoutes: vi.fn(() => [...routeTable]),
      createRouteContext: vi.fn(async () => ({
        pluginId: "late-plugin",
        taskStore: {},
        settings: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        emitEvent: vi.fn(),
      })),
      loadPlugin: vi.fn(),
      stopPlugin: vi.fn(),
    } as any;

    const app = express();
    app.use(express.json());
    app.use("/api/plugins", createPluginRouter(pluginStore, pluginLoader, undefined, {} as any));
    app.use((_req, res) => res.status(404).json({ error: "Not found" }));

    // Before enable: no routes exist for the plugin.
    const before = await performGet(app, "/api/plugins/late-plugin/hello");
    expect(before.status).toBe(404);

    // Enable-after-boot: the loader's route table grows; no router rebuild or restart.
    routeTable.push({ pluginId: "late-plugin", route: { method: "GET", path: "/hello", handler: helloHandler } });

    const after = await performGet(app, "/api/plugins/late-plugin/hello");
    expect(after.status).toBe(200);
    expect(after.body).toEqual({ ok: true });
    expect(helloHandler).toHaveBeenCalled();
  });

  it("serves routes from the request's project-scoped loader and executes against it", async () => {
    const projectHandler = vi.fn(async () => ({ project: true }));

    const pluginStore = {
      listPlugins: vi.fn(async () => []),
      getPlugin: vi.fn(async (id: string) => ({ id, settings: {}, enabled: true, manifest: { id, name: id, version: "1.0.0", description: "" } })),
      enablePlugin: vi.fn(),
      disablePlugin: vi.fn(),
      registerPlugin: vi.fn(),
      unregisterPlugin: vi.fn(),
      updatePluginSettings: vi.fn(),
      updatePluginState: vi.fn(),
    } as any;

    // Launch/host loader has NO plugins — mirrors a daemon launched from a project
    // where the plugin is not enabled.
    const hostLoader = {
      getPlugin: vi.fn(() => undefined),
      getPluginRoutes: vi.fn(() => []),
      createRouteContext: vi.fn(),
      loadPlugin: vi.fn(),
      stopPlugin: vi.fn(),
    } as any;

    const projectRouteContext = {
      pluginId: "project-only-plugin",
      taskStore: {},
      settings: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      emitEvent: vi.fn(),
    };
    const projectLoader = {
      getPlugin: vi.fn((id: string) => (id === "project-only-plugin" ? { manifest: { id } } : undefined)),
      getPluginRoutes: vi.fn(() => [
        { pluginId: "project-only-plugin", route: { method: "GET", path: "/data", handler: projectHandler } },
      ]),
      createRouteContext: vi.fn(async () => projectRouteContext),
      loadPlugin: vi.fn(),
      stopPlugin: vi.fn(),
    } as any;

    const resolveProjectPluginScope = vi.fn(async () => ({ loader: projectLoader }));

    const app = express();
    app.use(express.json());
    app.use("/api/plugins", createPluginRouter(pluginStore, hostLoader, undefined, {} as any, resolveProjectPluginScope));
    app.use((_req, res) => res.status(404).json({ error: "Not found" }));

    const res = await performGet(app, "/api/plugins/project-only-plugin/data");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ project: true });
    expect(projectHandler).toHaveBeenCalled();
    expect(resolveProjectPluginScope).toHaveBeenCalled();
    // Execution resolved through the project loader, never the host loader.
    expect(projectLoader.createRouteContext).toHaveBeenCalledWith("project-only-plugin", expect.anything());
    expect(hostLoader.createRouteContext).not.toHaveBeenCalled();
  });
});

/*
FNXC:PluginRoutes 2026-10-07-19:36:
The request's project decides which plugin routes exist: when a project scope resolves, only its loader's routes dispatch, so a plugin disabled in that project is never served from the host loader or the runner table. A reload that keeps a route's method and path still runs the new handler, and a plugin route that a management route shadows is excluded with a warning instead of silently never running.
*/
describe("createPluginRouter project authority, reload freshness and reserved paths", () => {
  const routeContextFor = (pluginId: string) => vi.fn(async (_id: string, overrides: { taskStore: unknown; settings: Record<string, unknown> }) => ({
    pluginId,
    taskStore: overrides.taskStore,
    settings: overrides.settings,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    emitEvent: vi.fn(),
  }));

  function pluginStoreStub() {
    return {
      listPlugins: vi.fn(async () => []),
      getPlugin: vi.fn(async (id: string) => ({ id, settings: {}, enabled: true, manifest: { id, name: id, version: "1.0.0", description: "" } })),
      enablePlugin: vi.fn(),
      disablePlugin: vi.fn(async (id: string) => ({ id, enabled: false })),
      registerPlugin: vi.fn(),
      unregisterPlugin: vi.fn(async () => undefined),
      updatePluginSettings: vi.fn(),
      updatePluginState: vi.fn(),
    } as any;
  }

  type RouteEntry = { pluginId: string; route: { method: string; path: string; handler: (...args: any[]) => unknown } };

  function loaderWith(entries: () => RouteEntry[]) {
    return {
      getPlugin: vi.fn((id: string) => (entries().some((e) => e.pluginId === id) ? { manifest: { id } } : undefined)),
      getPluginRoutes: vi.fn(() => entries()),
      createRouteContext: routeContextFor("todos"),
      loadPlugin: vi.fn(),
      stopPlugin: vi.fn(async () => undefined),
    } as any;
  }

  function buildTwoProjectApp() {
    const readHandler = vi.fn(async (_req: unknown, ctx: { taskStore: { name: string } }) => ({ store: ctx.taskStore.name }));
    const writeHandler = vi.fn(async (_req: unknown, ctx: { taskStore: { name: string } }) => ({ wrote: ctx.taskStore.name }));
    const todosRoutes = (): RouteEntry[] => [
      { pluginId: "todos", route: { method: "GET", path: "/items", handler: readHandler } },
      { pluginId: "todos", route: { method: "POST", path: "/items", handler: writeHandler } },
    ];
    // Project A (also the host/launch project) enables todos; project B does not.
    const loaderA = loaderWith(todosRoutes);
    const loaderB = loaderWith(() => []);
    const storeA = { name: "A", getPluginStore: () => undefined } as any;
    const storeB = { name: "B", getPluginStore: () => undefined } as any;
    const runner = { getPluginRoutes: vi.fn(() => todosRoutes()) } as any;
    const projectOf = (req: any) => req.query?.projectId ?? req.body?.projectId;
    const resolveScope = vi.fn(async (req: any) => (projectOf(req) === "B"
      ? { loader: loaderB, taskStore: storeB }
      : { loader: loaderA, taskStore: storeA }));

    const app = express();
    app.use(express.json());
    app.use("/api/plugins", createPluginRouter(pluginStoreStub(), loaderA, runner, storeA, resolveScope));
    app.use((_req, res) => res.status(404).json({ error: "Not found" }));
    return { app, readHandler, writeHandler, loaderA, loaderB, resolveScope };
  }

  it.each([
    ["GET with query projectId", "GET", "/api/plugins/todos/items?projectId=B", undefined],
    ["POST with query projectId", "POST", "/api/plugins/todos/items?projectId=B", JSON.stringify({})],
    ["POST with body projectId", "POST", "/api/plugins/todos/items", JSON.stringify({ projectId: "B" })],
  ])("does not serve a plugin disabled in the selected project from the host loader or runner (%s)", async (_label, method, path, body) => {
    const { app, readHandler, writeHandler } = buildTwoProjectApp();
    const res = await performRequest(app, method as "GET" | "POST", path, body, body ? { "content-type": "application/json" } : undefined);
    expect(res.status).toBe(404);
    expect(readHandler).not.toHaveBeenCalled();
    expect(writeHandler).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", "/api/plugins/todos/items", undefined, { store: "A" }],
    ["GET", "/api/plugins/todos/items?projectId=A", undefined, { store: "A" }],
    ["POST", "/api/plugins/todos/items", JSON.stringify({ projectId: "A" }), { wrote: "A" }],
  ])("serves the plugin in the project that enables it, against that project's store (%s %s)", async (method, path, body, expected) => {
    const { app, loaderA } = buildTwoProjectApp();
    const res = await performRequest(app, method as "GET" | "POST", path, body, body ? { "content-type": "application/json" } : undefined);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expected);
    expect(loaderA.createRouteContext).toHaveBeenCalledWith("todos", expect.objectContaining({ taskStore: expect.objectContaining({ name: "A" }) }));
  });

  it("serves a plugin enabled only in the selected project while the host loader lacks it", async () => {
    const handler = vi.fn(async () => ({ ok: "B" }));
    const loaderB = loaderWith(() => [{ pluginId: "todos", route: { method: "GET", path: "/items", handler } }]);
    const hostLoader = loaderWith(() => []);
    const app = express();
    app.use(express.json());
    app.use("/api/plugins", createPluginRouter(pluginStoreStub(), hostLoader, undefined, {} as any, async () => ({ loader: loaderB, taskStore: { name: "B" } as any })));
    app.use((_req, res) => res.status(404).json({ error: "Not found" }));
    const res = await performGet(app, "/api/plugins/todos/items?projectId=B");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: "B" });
  });

  it("runs the reloaded handler when the route method and path are unchanged", async () => {
    const v1 = vi.fn(async () => ({ version: 1 }));
    const v2 = vi.fn(async () => ({ version: 2 }));
    let handler: (...args: any[]) => unknown = v1;
    const loader = loaderWith(() => [{ pluginId: "todos", route: { method: "GET", path: "/items", handler } }]);
    const app = express();
    app.use(express.json());
    app.use("/api/plugins", createPluginRouter(pluginStoreStub(), loader, undefined, {} as any, async () => ({ loader, taskStore: {} as any })));

    expect((await performGet(app, "/api/plugins/todos/items")).body).toEqual({ version: 1 });
    handler = v2;
    expect((await performGet(app, "/api/plugins/todos/items")).body).toEqual({ version: 2 });
    expect(v1).toHaveBeenCalledTimes(1);
  });

  it("runs the re-enabled handler after a disable and enable with the same route keys", async () => {
    const v1 = vi.fn(async () => ({ version: 1 }));
    const v2 = vi.fn(async () => ({ version: 2 }));
    let table: RouteEntry[] = [{ pluginId: "todos", route: { method: "GET", path: "/items", handler: v1 } }];
    const loader = loaderWith(() => table);
    const app = express();
    app.use(express.json());
    app.use("/api/plugins", createPluginRouter(pluginStoreStub(), loader, undefined, {} as any));
    app.use((_req, res) => res.status(404).json({ error: "Not found" }));

    expect((await performGet(app, "/api/plugins/todos/items")).status).toBe(200);
    table = [];
    expect((await performGet(app, "/api/plugins/todos/items")).status).toBe(404);
    table = [{ pluginId: "todos", route: { method: "GET", path: "/items", handler: v2 } }];
    expect((await performGet(app, "/api/plugins/todos/items")).body).toEqual({ version: 2 });
  });

  it("runs the runner table's reloaded handler when no project scope resolver is wired", async () => {
    const v1 = vi.fn(async () => ({ version: 1 }));
    const v2 = vi.fn(async () => ({ version: 2 }));
    let handler: (...args: any[]) => unknown = v1;
    const hostLoader = { ...loaderWith(() => []), getPlugin: vi.fn(() => ({ manifest: { id: "todos" } })) };
    const runner = { getPluginRoutes: vi.fn(() => [{ pluginId: "todos", route: { method: "GET", path: "/items", handler } }]) } as any;
    const app = express();
    app.use(express.json());
    app.use("/api/plugins", createPluginRouter(pluginStoreStub(), hostLoader as any, runner, {} as any));

    expect((await performGet(app, "/api/plugins/todos/items")).body).toEqual({ version: 1 });
    handler = v2;
    expect((await performGet(app, "/api/plugins/todos/items")).body).toEqual({ version: 2 });
  });

  it.each([
    ["POST", "/rescan"],
    ["POST", "/setup/uninstall"],
    ["PATCH", "/"],
    ["GET", "/settings"],
    ["PUT", "/settings/"],
    ["POST", "/Enable"],
  ])("excludes a plugin route that a management route shadows and warns once (%s %s)", async (method, path) => {
    const shadowed = vi.fn(async () => ({ plugin: true }));
    const open = vi.fn(async () => ({ open: true }));
    const loader = loaderWith(() => [
      { pluginId: "todos", route: { method, path, handler: shadowed } },
      { pluginId: "todos", route: { method: "GET", path: "/items", handler: open } },
    ]);
    const app = express();
    app.use(express.json());
    app.use("/api/plugins", createPluginRouter(pluginStoreStub(), loader, undefined, {} as any));
    app.use((_req, res) => res.status(404).json({ error: "Not found" }));

    pluginRoutesLogger.warn.mockClear();
    await performRequest(app, method as "GET", `/api/plugins/todos${path}`, method === "GET" ? undefined : JSON.stringify({}), { "content-type": "application/json" });
    await performRequest(app, method as "GET", `/api/plugins/todos${path}`, method === "GET" ? undefined : JSON.stringify({}), { "content-type": "application/json" });
    expect(shadowed).not.toHaveBeenCalled();
    expect((await performGet(app, "/api/plugins/todos/items")).body).toEqual({ open: true });
    const warnings = pluginRoutesLogger.warn.mock.calls.filter((call) => String(call[0]).includes("todos") && String(call[0]).includes("reserved"));
    expect(warnings).toHaveLength(1);
  });

  it("keeps a parameterized plugin route that a management route only partly overlaps", async () => {
    const handler = vi.fn(async (req: any) => ({ section: req.params?.section ?? "x" }));
    const loader = loaderWith(() => [{ pluginId: "todos", route: { method: "GET", path: "/:section", handler } }]);
    const app = express();
    app.use(express.json());
    app.use("/api/plugins", createPluginRouter(pluginStoreStub(), loader, undefined, {} as any));
    const res = await performGet(app, "/api/plugins/todos/board");
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalled();
  });

  it.each([
    ["DELETE", "/api/plugins/todos", "unregisterPlugin"],
    ["POST", "/api/plugins/todos/disable", "disablePlugin"],
  ])("%s persists before stopping, through the request project's loader", async (method, path, storeMethod) => {
    const order: string[] = [];
    const pluginStore = pluginStoreStub();
    pluginStore[storeMethod] = vi.fn(async (id: string) => { order.push(`store:${id}`); return { id, enabled: false }; });
    const hostLoader = loaderWith(() => []);
    const projectLoader = loaderWith(() => []);
    projectLoader.stopPlugin = vi.fn(async (id: string) => { order.push(`stop:${id}`); });
    const app = express();
    app.use(express.json());
    app.use("/api/plugins", createPluginRouter(pluginStore, hostLoader, undefined, {} as any, async () => ({ loader: projectLoader, taskStore: { getPluginStore: () => pluginStore } as any })));

    const res = await performRequest(app, method as "POST", path, method === "POST" ? JSON.stringify({ projectId: "B" }) : undefined, { "content-type": "application/json" });
    expect(res.status).toBeLessThan(300);
    expect(order).toEqual(["store:todos", "stop:todos"]);
    expect(hostLoader.stopPlugin).not.toHaveBeenCalled();
  });
});
