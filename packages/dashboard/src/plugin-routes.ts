import { createLogger } from "@fusion/core";

const severityAuditLog = createLogger("dashboard-plugin-routes");
/**
 * Plugin REST API Routes
 *
 * Provides CRUD endpoints for plugin management and plugin-defined routes.
 *
 * Endpoints:
 * - GET /plugins - List all installed plugins
 * - GET /plugins/:id - Get single plugin
 * - POST /plugins/install - Install a plugin
 * - POST /plugins/:id/enable - Enable a plugin
 * - POST /plugins/:id/disable - Disable a plugin
 * - DELETE /plugins/:id - Uninstall a plugin
 * - GET /plugins/:id/settings - Get plugin settings
 * - PUT /plugins/:id/settings - Update plugin settings
 * - Plugin-defined routes mounted under /plugins/:pluginId/*
 */

import { Router, type Request, type Response } from "express";
import { access, stat, readFile } from "node:fs/promises";
import { join, isAbsolute, dirname, basename } from "node:path";
import { emitPluginCustomSseEvent } from "./sse.js";
import type {
  PluginInstallation,
  PluginLoader,
  PluginStore,
  PluginContext,
  PluginState,
  PluginRouteMethod,
} from "@fusion/core";
import { resolvePluginEntryPath, validatePluginManifest } from "@fusion/core";
import {
  ApiError,
  badRequest,
  catchHandler,
  internalError,
  notFound,
} from "./api-error.js";
import { getOrCreateProjectStore } from "./project-store-resolver.js";


// PluginRunner interface for optional plugin runner
function isPluginRouteResponse(result: unknown): result is import("@fusion/core").PluginRouteResponse {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  const candidate = result as { status?: unknown };
  return typeof candidate.status === "number";
}

interface PluginRunner {
  reloadPlugin?(pluginId: string): Promise<void>;
  checkPluginSetup?(pluginId: string): Promise<import("@fusion/core").PluginSetupCheckResult>;
  installPluginSetup?(pluginId: string): Promise<{ success: boolean; error?: string }>;
  uninstallPluginSetup?(pluginId: string): Promise<{ success: boolean; error?: string }>;
  getPluginSetupInfo?(): Array<{ pluginId: string; manifest: import("@fusion/core").PluginSetupManifest; hooks: import("@fusion/core").PluginSetupHooks }>;
  getPluginRoutes(): Array<{ pluginId: string; route: import("@fusion/core").PluginRouteDefinition }>;
}

/** The plugin authority for one request: the selected project's loader and TaskStore. */
export interface ProjectPluginScope {
  loader?: PluginLoader;
  taskStore?: import("@fusion/core").TaskStore;
}

export interface RegistryManifestEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  category: "runtime" | "integration";
  npmPackage?: string;
  path?: string;
  homepage?: string;
  tags?: string[];
}

export interface RegistryPluginEntry extends RegistryManifestEntry {
  installed: boolean;
  state?: PluginState;
  installedVersion?: string;
  canInstall: boolean;
}

interface RegistryManifestShape {
  plugins?: unknown;
}

const registryManifestUrl = new URL("./registry-manifest.json", import.meta.url);
let cachedRegistryManifest: RegistryManifestShape | null = null;

export async function loadRegistryManifest(): Promise<RegistryManifestShape> {
  if (cachedRegistryManifest) {
    return cachedRegistryManifest;
  }

  try {
    const raw = await readFile(registryManifestUrl, "utf-8");
    cachedRegistryManifest = JSON.parse(raw) as RegistryManifestShape;
    return cachedRegistryManifest;
  } catch (error) {
    // FNXC:PluginRegistry 2026-07-01-07:45:
    // Desktop local mode imports the dashboard server under Node 22+, where static
    // JSON imports require attributes that TypeScript did not emit. Read the
    // registry manifest as data at request time and degrade to an empty registry
    // when the packaged manifest is missing or malformed so startup never fails at
    // module load with ERR_IMPORT_ATTRIBUTE_MISSING.
    severityAuditLog.warn("[dashboard/plugins] Registry manifest unavailable; serving an empty plugin registry", error);
    cachedRegistryManifest = {};
    return cachedRegistryManifest;
  }
}

function normalizeRegistryManifestEntries(manifest: RegistryManifestShape): RegistryManifestEntry[] {
  if (!manifest || !Array.isArray(manifest.plugins)) {
    return [];
  }

  return manifest.plugins.filter((entry): entry is RegistryManifestEntry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    const candidate = entry as Partial<RegistryManifestEntry>;
    return typeof candidate.id === "string"
      && typeof candidate.name === "string"
      && typeof candidate.description === "string"
      && typeof candidate.version === "string"
      && typeof candidate.author === "string"
      && (candidate.category === "runtime" || candidate.category === "integration");
  });
}

function registryEntryMatchesSearch(entry: RegistryManifestEntry, query: string): boolean {
  if (!query) {
    return true;
  }

  const haystack = [
    entry.name,
    entry.description,
    entry.author,
    ...(entry.tags ?? []),
  ].join(" ").toLowerCase();
  return haystack.includes(query);
}

async function annotateRegistryEntry(
  entry: RegistryManifestEntry,
  store: Pick<PluginStore, "getPlugin">,
): Promise<RegistryPluginEntry> {
  let installedPlugin: PluginInstallation | null = null;
  try {
    installedPlugin = await store.getPlugin(entry.id);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      const message = err instanceof Error ? err.message : "";
      if (!message.toLowerCase().includes("not found")) {
        throw err;
      }
    }
  }

  return {
    ...entry,
    installed: Boolean(installedPlugin),
    state: installedPlugin?.state,
    installedVersion: installedPlugin?.version,
    canInstall: typeof entry.path === "string" && entry.path.trim().length > 0,
  };
}

export async function buildRegistryPluginEntries(
  manifest: RegistryManifestShape,
  store: Pick<PluginStore, "getPlugin">,
  filters: { q?: string; category?: string } = {},
): Promise<RegistryPluginEntry[]> {
  const query = filters.q?.trim().toLowerCase() ?? "";
  const category = filters.category?.trim().toLowerCase() ?? "";
  const entries = normalizeRegistryManifestEntries(manifest)
    .filter((entry) => !category || entry.category === category)
    .filter((entry) => registryEntryMatchesSearch(entry, query));

  return Promise.all(entries.map((entry) => annotateRegistryEntry(entry, store)));
}

// ── Install-Source Resolution Helpers ──────────────────────────────────
// Exported for reuse in routes.ts and for direct testing.

/**
 * Validate plugin installation source.
 * Must have either `path` (local directory) or `package` (npm package name).
 * Enforces absolute path requirement and rejects path traversal.
 */
export function validateInstallSource(body: unknown): { path?: string; package?: string } {
  if (!body || typeof body !== "object") {
    throw badRequest("Request body is required");
  }

  const b = body as Record<string, unknown>;

  if (b.path !== undefined && typeof b.path === "string") {
    const p = b.path;
    if (!p.trim()) {
      throw badRequest("Path must not be empty");
    }
    if (!isAbsolute(p)) {
      throw badRequest("Plugin path must be absolute");
    }
    // Reject path traversal sequences
    if (p.includes("..")) {
      throw badRequest("Plugin path must not contain path traversal (..)");
    }
    return { path: p };
  }

  if (b.package !== undefined && typeof b.package === "string") {
    return { package: b.package };
  }

  throw badRequest("Request body must have either 'path' or 'package' field");
}

/**
 * Well-known directory names that indicate a build output folder.
 * When the user selects one of these, we look for manifest.json
 * in the parent directory before giving up.
 */
export const DIST_DIR_NAMES = new Set(["dist", "build", "out", "output", "lib"]);

/**
 * Resolve an install path to the directory that contains `manifest.json`.
 *
 * Resolution order:
 * 1. `<path>/manifest.json`                  — user selected package root
 * 2. `<parent>/manifest.json`                — user selected a dist/build folder
 *    (only when `basename(path)` is a well-known build output name)
 *
 * Returns `{ manifestDir, manifest }` where `manifestDir` is the canonical
 * path the plugin-loader should use (the directory containing manifest.json).
 */
export async function resolvePluginManifest(
  sourcePath: string,
): Promise<{ manifestDir: string; manifest: import("@fusion/core").PluginManifest }> {
  // Validate the path exists and is a directory
  try {
    await access(sourcePath);
  } catch {
    throw notFound(`Path does not exist: ${sourcePath}`);
  }
  let sourceStat;
  try {
    sourceStat = await stat(sourcePath);
  } catch {
    throw badRequest(`Cannot access path: ${sourcePath}`);
  }
  if (!sourceStat.isDirectory()) {
    throw badRequest(`Path is not a directory: ${sourcePath}`);
  }

  // 1. Try manifest.json directly in the provided path
  const directManifestPath = join(sourcePath, "manifest.json");
  try {
    await access(directManifestPath);
    const manifest = await readAndValidateManifest(directManifestPath);
    return { manifestDir: sourcePath, manifest };
  } catch (err) {
    // Re-throw ApiErrors (badRequest) from validation; only catch true ENOENT
    if (err instanceof ApiError) throw err;
    // Not found at direct path
  }

  // 2. If the selected dir is a well-known dist folder, check the parent
  const dirName = basename(sourcePath).toLowerCase();
  if (DIST_DIR_NAMES.has(dirName)) {
    const parentDir = dirname(sourcePath);
    const parentManifestPath = join(parentDir, "manifest.json");
    try {
      await access(parentManifestPath);
      const manifest = await readAndValidateManifest(parentManifestPath);
      // Return the parent (package root) as the canonical install dir
      return { manifestDir: parentDir, manifest };
    } catch (err) {
      // Re-throw ApiErrors (badRequest) from validation; only catch true ENOENT
      if (err instanceof ApiError) throw err;
      // Not found at parent path
    }
  }

  // Neither location has a manifest
  throw notFound(
    `Plugin manifest not found. Looked for manifest.json in: ${sourcePath}` +
    (DIST_DIR_NAMES.has(dirName) ? ` and ${dirname(sourcePath)}` : ""),
  );
}

/**
 * Read and validate a manifest.json file.
 */
async function readAndValidateManifest(
  manifestPath: string,
): Promise<import("@fusion/core").PluginManifest> {
  let content: string;
  try {
    content = await readFile(manifestPath, "utf-8");
  } catch (err) {
    throw badRequest(`Cannot read manifest at ${manifestPath}: ${(err as Error).message}`);
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(content);
  } catch {
    throw badRequest(`Invalid JSON in manifest at: ${manifestPath}`);
  }

  const validation = validatePluginManifest(manifest);
  if (!validation.valid) {
    throw badRequest(`Invalid plugin manifest: ${validation.errors.join(", ")}`);
  }

  return manifest as import("@fusion/core").PluginManifest;
}

// ── Reserved Management Paths ─────────────────────────────────────────

/**
 * Management routes served under `/api/plugins` ahead of plugin-defined routes, by createPluginRouter and registerPluginsAutomationRoutes.
 * Paths are relative to `/plugins`; `:id` matches one path segment.
 *
 * FNXC:PluginRoutes 2026-10-07-19:36:
 * A plugin route with the same method and a path these patterns fully cover can never run, because the management route answers first. Dispatch excludes it and warns instead of shadowing it silently.
 * Keep this list equal to the mounted management routes; plugin-routes.routes.test.ts compares it with the live router stacks.
 */
export const RESERVED_PLUGIN_MANAGEMENT_ROUTES: ReadonlyArray<{ method: PluginRouteMethod; path: string }> = [
  { method: "GET", path: "/" },
  { method: "GET", path: "/registry" },
  { method: "GET", path: "/ui-slots" },
  { method: "GET", path: "/ui-contributions" },
  { method: "GET", path: "/dashboard-views" },
  { method: "GET", path: "/runtimes" },
  { method: "GET", path: "/:id" },
  { method: "GET", path: "/:id/settings" },
  { method: "GET", path: "/:id/setup-status" },
  { method: "POST", path: "/" },
  { method: "POST", path: "/install" },
  { method: "POST", path: "/:id/enable" },
  { method: "POST", path: "/:id/disable" },
  { method: "POST", path: "/:id/reload" },
  { method: "POST", path: "/:id/rescan" },
  { method: "POST", path: "/:id/setup/install" },
  { method: "POST", path: "/:id/setup/uninstall" },
  { method: "PUT", path: "/:id/settings" },
  { method: "PATCH", path: "/:id" },
  { method: "DELETE", path: "/:id" },
];

function pathSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

/**
 * Return the management route that shadows a plugin route, if any.
 * Express matches paths case-insensitively and ignores a trailing slash. A plugin segment that is a parameter is only partly covered by a literal management segment, so such a route stays served.
 */
export function findReservedPluginRoute(
  pluginId: string,
  route: { method: string; path: string },
): { method: PluginRouteMethod; path: string } | undefined {
  const segments = [pluginId, ...pathSegments(route.path)].map((segment) => segment.toLowerCase());
  const method = route.method.toUpperCase();
  return RESERVED_PLUGIN_MANAGEMENT_ROUTES.find((reserved) => {
    if (reserved.method !== method) return false;
    const pattern = pathSegments(reserved.path);
    if (pattern.length !== segments.length) return false;
    return pattern.every((part, index) => {
      if (part.startsWith(":")) return true;
      const segment = segments[index];
      return !segment.startsWith(":") && segment === part.toLowerCase();
    });
  });
}

// ── Router Factory ────────────────────────────────────────────────────

/**
 * Create the plugin management router.
 *
 * @param pluginStore - Plugin store for persistence
 * @param pluginLoader - Plugin loader for lifecycle management
 * @param pluginRunner - Optional plugin runner for plugin-defined routes
 * @param defaultTaskStore - Task store used when a request carries no projectId
 * @param resolveProjectPluginScope - Per-request project scope (routes/context.ts
 *   getProjectContext + getProjectPluginLoader). When wired, the scope's loader is the
 *   only plugin-route authority and lifecycle routes stop through it; when absent,
 *   dispatch uses the host pluginLoader + pluginRunner route tables.
 */
export function createPluginRouter(
  pluginStore: PluginStore,
  pluginLoader: PluginLoader,
  pluginRunner?: PluginRunner,
  defaultTaskStore?: import("@fusion/core").TaskStore,
  resolveProjectPluginScope?: (req: Request) => Promise<ProjectPluginScope | undefined>,
): Router {
  const router = Router();
  const resolveScope = async (req: Request): Promise<ProjectPluginScope | undefined> =>
    resolveProjectPluginScope ? await resolveProjectPluginScope(req) : undefined;
  const scopePluginStore = (scope: ProjectPluginScope | undefined): PluginStore =>
    (scope?.taskStore?.getPluginStore?.() as PluginStore | undefined) ?? pluginStore;

  // ── Management Routes ───────────────────────────────────────────

  /**
   * GET /plugins
   * List all installed plugins.
   */
  router.get("/", catchHandler(async (_req: Request, res: Response) => {
    const plugins = await pluginStore.listPlugins();
    res.json(plugins);
  }));

  /**
   * GET /plugins/registry
   * List curated registry plugin metadata with installed-state annotations.
   */
  router.get("/registry", catchHandler(async (req: Request, res: Response) => {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const category = typeof req.query.category === "string" ? req.query.category : undefined;
    // FNXC:BranchGroupProjectScoping 2026-07-14-06:15: return the trimmed id, not the raw padded string.
    const projectId = typeof req.query.projectId === "string"
      ? (req.query.projectId.trim() || undefined)
      : undefined;
    const scopedStore = projectId ? await getOrCreateProjectStore(projectId) : null;
    const store = scopedStore?.getPluginStore?.() ?? pluginStore;
    const registryManifest = await loadRegistryManifest();
    const plugins = await buildRegistryPluginEntries(registryManifest, store, { q, category });
    res.json({ plugins });
  }));

  /**
   * GET /plugins/:id
   * Get a single plugin by ID.
   */
  router.get("/:id", catchHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    try {
      const plugin = await pluginStore.getPlugin(id);
      res.json(plugin);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Plugin "${id}" not found`);
      }
      throw internalError(err instanceof Error ? err.message : "Unknown error");
    }
  }));

  /**
   * POST /plugins/install
   * Install a plugin from a local path or npm package.
   * Supports package root and dist-folder selections via resolvePluginManifest.
   */
  router.post("/install", catchHandler(async (req: Request, res: Response) => {
    const source = validateInstallSource(req.body);

    // Resolve manifest — supports package root and dist-folder selections
    let manifest: import("@fusion/core").PluginManifest;
    let installPath: string;

    if (source.path) {
      const resolved = await resolvePluginManifest(source.path);
      manifest = resolved.manifest;
      // Register the loadable entry FILE, not the package directory — Node
      // ESM cannot import directories, so the loader rejects directory paths.
      const entryPath = resolvePluginEntryPath(resolved.manifestDir);
      if (!entryPath) {
        throw badRequest(
          `Plugin at ${resolved.manifestDir} has no loadable entry file `
          + "(expected bundled.js, dist/index.js, or src/index.ts)",
        );
      }
      installPath = entryPath;
    } else if (source.package) {
      // npm packages not yet supported
      throw badRequest("Installing plugins from npm packages is not yet implemented");
    } else {
      throw badRequest("Invalid source");
    }

    // Register the plugin
    try {
      const plugin = await pluginStore.registerPlugin({
        manifest,
        path: installPath,
      });

      // If the plugin is enabled, try to load it
      if (plugin.enabled) {
        try {
          await pluginLoader.loadPlugin(plugin.id);
        } catch (loadErr) {
          // Log but don't fail - the plugin is registered, just not loaded
          severityAuditLog.error(`[plugin-routes] Failed to load plugin ${plugin.id}:`, loadErr);
        }
      }

      res.status(201).json(plugin);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.message.includes("already registered")) {
        throw badRequest(err.message);
      }
      throw internalError(err instanceof Error ? err.message : "Failed to register plugin");
    }
  }));

  /**
   * POST /plugins/:id/enable
   * Enable a plugin and start it.
   */
  router.post("/:id/enable", catchHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;

    // Enable in store
    let plugin = await pluginStore.enablePlugin(id);

    // Heal legacy registrations that stored the package directory instead of
    // a loadable entry file (Node ESM cannot import directories). Mirrors the
    // heal in routes.ts's enable handler and the CLI's startup heal.
    try {
      if ((await stat(plugin.path)).isDirectory()) {
        const entryPath = resolvePluginEntryPath(plugin.path);
        if (entryPath) {
          plugin = await pluginStore.updatePlugin(id, { path: entryPath });
        }
      }
    } catch {
      // Path missing or unreadable — let loadPlugin surface the real error.
    }

    // Start the plugin
    try {
      await pluginLoader.loadPlugin(id);
    } catch (loadErr) {
      // Update state to error
      await pluginStore.updatePluginState(
        id,
        "error",
        loadErr instanceof Error ? loadErr.message : String(loadErr),
      );
      // Re-fetch to get updated state
      plugin = await pluginStore.getPlugin(id);
    }

    res.json(plugin);
  }));

  /**
   * POST /plugins/:id/disable
   * Disable a plugin and stop it.
   */
  router.post("/:id/disable", catchHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const scope = await resolveScope(req);

    /*
    FNXC:PluginLoader 2026-10-07-19:36:
    Mirror registerPluginsAutomationRoutes: persist the disable first, then stop through the request project's loader (the engine's when one runs), so the instance the project uses is the one removed.
    */
    const plugin = await scopePluginStore(scope).disablePlugin(id);
    try {
      await (scope?.loader ?? pluginLoader).stopPlugin(id);
    } catch {
      // Ignore errors from stopping - plugin might not be loaded
    }
    res.json(plugin);
  }));

  /**
   * POST /plugins/:id/reload
   * Reload a running plugin with updated code.
   */
  router.post("/:id/reload", catchHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;

    // Validate plugin exists
    let plugin;
    try {
      plugin = await pluginStore.getPlugin(id);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Plugin "${id}" not found`);
      }
      throw internalError(err instanceof Error ? err.message : "Unknown error");
    }

    // Validate plugin is started (must be loaded to reload)
    if (plugin.state !== "started") {
      throw badRequest("Plugin is not currently loaded. Use enable instead.");
    }

    // Check if pluginRunner is available and has reloadPlugin method
    if (!pluginRunner || !pluginRunner.reloadPlugin) {
      throw internalError("Plugin runner not available");
    }

    // Reload the plugin
    try {
      await pluginRunner.reloadPlugin(id);
    } catch (reloadErr) {
      throw internalError(`Reload failed: ${reloadErr instanceof Error ? reloadErr.message : String(reloadErr)}`);
    }

    // Return updated plugin
    const updatedPlugin = await pluginStore.getPlugin(id);
    res.json(updatedPlugin);
  }));

  /**
   * GET /plugins/:id/setup-status
   * Check plugin setup status.
   */
  router.get("/:id/setup-status", catchHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;

    let plugin: import("@fusion/core").PluginInstallation;
    try {
      plugin = await pluginStore.getPlugin(id);
    } catch (err: unknown) {
      if (
        (err as NodeJS.ErrnoException).code === "ENOENT"
        || (err instanceof Error && err.message.includes("not found"))
      ) {
        throw notFound(`Plugin "${id}" not found`);
      }
      throw internalError(err instanceof Error ? err.message : "Unknown error");
    }

    if (!pluginRunner?.checkPluginSetup || !pluginRunner.getPluginSetupInfo) {
      throw internalError("Plugin runner not available");
    }

    const setupInfo = pluginRunner.getPluginSetupInfo();
    const hasSetup = setupInfo.some((entry) => entry.pluginId === id);

    if (!hasSetup) {
      res.json({ hasSetup: false });
      return;
    }

    if (plugin.state !== "started") {
      res.json({
        hasSetup: true,
        setupCheckDeferred: true,
        deferredReason: "plugin-not-started",
        pluginState: plugin.state,
      });
      return;
    }

    const status = await pluginRunner.checkPluginSetup(id);
    res.json({ hasSetup: true, ...status });
  }));

  /**
   * POST /plugins/:id/setup/install
   * Trigger plugin setup install hook.
   */
  router.post("/:id/setup/install", catchHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;

    let plugin: import("@fusion/core").PluginInstallation;
    try {
      plugin = await pluginStore.getPlugin(id);
    } catch (err: unknown) {
      if (
        (err as NodeJS.ErrnoException).code === "ENOENT"
        || (err instanceof Error && err.message.includes("not found"))
      ) {
        throw notFound(`Plugin "${id}" not found`);
      }
      throw internalError(err instanceof Error ? err.message : "Unknown error");
    }

    if (!plugin.enabled) {
      throw badRequest("Plugin must be enabled before setup install");
    }

    if (!pluginRunner?.installPluginSetup || !pluginRunner.getPluginSetupInfo) {
      throw internalError("Plugin runner not available");
    }

    const setupInfo = pluginRunner.getPluginSetupInfo();
    const setup = setupInfo.find((entry) => entry.pluginId === id);
    if (!setup?.hooks.install) {
      throw badRequest("Plugin has no install hook");
    }

    const result = await pluginRunner.installPluginSetup(id);
    res.json(result ?? { success: true });
  }));

  /**
   * DELETE /plugins/:id
   * Uninstall a plugin.
   */
  router.delete("/:id", catchHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const scope = await resolveScope(req);

    /*
    FNXC:PluginLoader 2026-10-07-19:36:
    Mirror registerPluginsAutomationRoutes: unregister first, then stop through the request project's loader. The loader then resolves the instance from memory and unloads it in every loader sharing the lifecycle.
    */
    await scopePluginStore(scope).unregisterPlugin(id);
    try {
      await (scope?.loader ?? pluginLoader).stopPlugin(id);
    } catch {
      // Ignore - plugin might not be loaded
    }

    res.status(204).send();
  }));

  /**
   * GET /plugins/:id/settings
   * Get plugin settings.
   */
  router.get("/:id/settings", catchHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    try {
      const plugin = await pluginStore.getPlugin(id);
      res.json(plugin.settings);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Plugin "${id}" not found`);
      }
      throw internalError(err instanceof Error ? err.message : "Unknown error");
    }
  }));

  /**
   * PUT /plugins/:id/settings
   * Update plugin settings.
   */
  router.put("/:id/settings", catchHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;

    if (!req.body || typeof req.body !== "object") {
      throw badRequest("Request body must be an object with 'settings' field");
    }

    const body = req.body as Record<string, unknown>;
    const settings = body.settings as Record<string, unknown> | undefined;

    if (!settings || typeof settings !== "object") {
      throw badRequest("Request body must have a 'settings' object");
    }

    try {
      const plugin = await pluginStore.updatePluginSettings(id, settings);
      res.json(plugin.settings);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Plugin "${id}" not found`);
      }
      if (err instanceof Error && err.message.includes("validation failed")) {
        throw badRequest(err.message);
      }
      throw internalError(err instanceof Error ? err.message : "Failed to update settings");
    }
  }));

  // ── Plugin-Defined Routes ──────────────────────────────────────

  /*
  FNXC:PluginRoutes 2026-07-22-09:55:
  Mount plugin-defined HTTP routes from the dashboard PluginLoader always, and
  union in PluginRunner routes when present. Do not gate mounting on pluginRunner:
  UI-only / --no-engine (and engine-warmup failure) pass pluginRunner=undefined for
  Grok dual-remediation, which previously skipped ALL plugin routes. Compound
  Engineering still rendered its bundled dashboard view, so operators saw
  "Failed to load sessions/artifacts: Not found" (catch-all 404) on every CE API
  call while the stage cards painted normally. Prefer loader entries on key
  collisions so handlers resolve against the same pluginLoader instance.

  FNXC:PluginRoutes 2026-07-22-20:30:
  Plugin routes are now dispatched DYNAMICALLY per request, not registered once at
  boot. The boot-time snapshot had two live failure modes on v0.73.0-beta.3 even
  after the fix above: (1) a plugin enabled after boot rendered its dashboard view
  (served live via the project-scoped loader) while its routes stayed unmounted
  until restart; (2) a plugin enabled only in a non-launch project NEVER got routes
  mounted because the snapshot came from the launch project's loader. Dispatch
  resolves the request's project-scoped loader (same routes/context.ts
  getProjectPluginLoader cache the dashboard-views/enable endpoints use), falls back
  to the host loader + PluginRunner tables only when no project scope resolver is
  wired (loader beats runner), and executes each entry against the loader that owns
  its plugin instance. The
  matching sub-router is cached per resolved loader and rebuilt only when the route
  signature changes, so views and routes agree by construction.
  */
  type PluginRouteEntry = { pluginId: string; route: import("@fusion/core").PluginRouteDefinition };
  type DispatchEntry = PluginRouteEntry & { execLoader: PluginLoader };

  /*
  FNXC:PluginRoutes 2026-10-07-19:36:
  When a project scope resolves, its loader is the only route authority: a plugin it has not loaded is disabled (or not yet loaded) in that project, and serving the host loader's or runner's copy ran another project's handler against this project's store.
  The host loader plus runner union applies only when no scope resolver is wired (standalone routers).
  A plugin route that a management route shadows is excluded with one warning per route instead of silently never running.
  */
  const warnedReservedRoutes = new Set<string>();
  const collectDispatchEntries = (scope: ProjectPluginScope | undefined): Map<string, DispatchEntry> => {
    const byKey = new Map<string, DispatchEntry>();
    // First writer wins: host loader, then runner.
    const addPluginRoutes = (entries: PluginRouteEntry[] | undefined, execLoader: PluginLoader) => {
      if (!entries) return;
      for (const entry of entries) {
        const key = `${entry.pluginId}\0${entry.route.method}\0${entry.route.path}`;
        if (byKey.has(key)) continue;
        const reserved = findReservedPluginRoute(entry.pluginId, entry.route);
        if (reserved) {
          if (!warnedReservedRoutes.has(key)) {
            warnedReservedRoutes.add(key);
            severityAuditLog.warn(
              `[plugin-routes] Plugin "${entry.pluginId}" route ${entry.route.method} ${entry.route.path} is not served: ` +
                `it is shadowed by the reserved management route ${reserved.method} /plugins${reserved.path}`,
            );
          }
          continue;
        }
        byKey.set(key, { ...entry, execLoader });
      }
    };
    if (scope) {
      if (scope.loader) {
        addPluginRoutes((scope.loader as { getPluginRoutes?: () => PluginRouteEntry[] }).getPluginRoutes?.(), scope.loader);
      }
      return byKey;
    }
    addPluginRoutes((pluginLoader as { getPluginRoutes?: () => PluginRouteEntry[] }).getPluginRoutes?.(), pluginLoader);
    if (pluginRunner && typeof pluginRunner.getPluginRoutes === "function") {
      // Runner entries execute against the host loader, matching the pre-dynamic
      // behavior where handlers always resolved through pluginLoader.
      addPluginRoutes(pluginRunner.getPluginRoutes(), pluginLoader);
    }
    return byKey;
  };

  const buildDispatchRouter = (entries: Map<string, DispatchEntry>): Router => {
    const dispatchRouter = Router();
    for (const { pluginId, route, execLoader } of entries.values()) {
      registerPluginRoute(dispatchRouter, pluginId, route, execLoader);
    }
    return dispatchRouter;
  };

  // The project scope the dispatch middleware resolved for a request, read by the route handler.
  const requestScopes = new WeakMap<Request, ProjectPluginScope>();

  const registerPluginRoute = (
    targetRouter: Router,
    pluginId: string,
    route: import("@fusion/core").PluginRouteDefinition,
    execLoader: PluginLoader,
  ): void => {
    const fullPath = `/${pluginId}${route.path.startsWith("/") ? route.path : `/${route.path}`}`;

    const handler = catchHandler(async (req: Request, res: Response) => {
      // Get the plugin context
      const plugin = execLoader.getPlugin(pluginId);
      if (!plugin) {
        throw notFound(`Plugin "${pluginId}" not loaded`);
      }

      // FNXC:BranchGroupProjectScoping 2026-07-14-06:15: return the trimmed id, not the raw padded string.
      const queryProjectId = typeof req.query.projectId === "string" ? req.query.projectId.trim() : "";
      const bodyProjectId =
        req.body && typeof req.body === "object" && typeof (req.body as { projectId?: unknown }).projectId === "string"
          ? (req.body as { projectId: string }).projectId.trim()
          : "";
      const projectId = queryProjectId || bodyProjectId || undefined;
      // The handler runs against the same project the route table came from.
      const scope = requestScopes.get(req);
      const scopedStore = scope?.taskStore ?? (projectId ? await getOrCreateProjectStore(projectId) : null);
      const taskStore = scopedStore ?? defaultTaskStore ?? ({} as import("@fusion/core").TaskStore);

      let settings: Record<string, unknown> = {};
      const scopedPluginStore = scopedStore?.getPluginStore?.();
      if (scopedPluginStore) {
        try {
          const scopedPlugin = await scopedPluginStore.getPlugin(pluginId);
          settings = scopedPlugin.settings;
        } catch {
          // Fall back to default store plugin settings when project-scoped plugin record is unavailable.
        }
      }
      if (!scopedPluginStore || Object.keys(settings).length === 0) {
        try {
          const pluginRecord = await pluginStore.getPlugin(pluginId);
          settings = pluginRecord.settings;
        } catch {
          // Keep empty settings when plugin store record isn't available.
        }
      }

      const ctx: PluginContext = await execLoader.createRouteContext(pluginId, {
        taskStore,
        settings,
        resolveProjectTaskStore: getOrCreateProjectStore,
        // Real publish-to-/api/events seam: forward custom plugin events to
        // connected SSE clients, scoped to the request's project so a
        // project stream only sees its own events.
        emitEvent: (event: string, data: unknown) => {
          emitPluginCustomSseEvent(pluginId, event, data, projectId);
        },
      });

      // Call the route handler with Express Request cast to unknown
      const result = await route.handler(req as unknown, ctx);

      if (isPluginRouteResponse(result)) {
        if (result.headers) {
          for (const [name, value] of Object.entries(result.headers)) {
            res.setHeader(name, value);
          }
        }
        if (result.contentType) {
          res.setHeader("Content-Type", result.contentType);
        }
        if (result.status === 204) {
          res.status(204).send();
          return;
        }
        if (result.body === undefined) {
          res.status(result.status).send();
          return;
        }
        if (
          result.contentType
          || typeof result.body === "string"
          || Buffer.isBuffer(result.body)
        ) {
          res.status(result.status).send(result.body);
          return;
        }
        res.status(result.status).json(result.body);
        return;
      }

      res.status(200).json(result);
    });

    switch (route.method) {
      case "GET":
        targetRouter.get(fullPath, handler);
        break;
      case "POST":
        targetRouter.post(fullPath, handler);
        break;
      case "PUT":
        targetRouter.put(fullPath, handler);
        break;
      case "PATCH":
        targetRouter.patch(fullPath, handler);
        break;
      case "DELETE":
        targetRouter.delete(fullPath, handler);
        break;
    }
  };

  /*
  FNXC:PluginRoutes 2026-10-07-19:36:
  A compiled dispatch router is cached per authority loader and rebuilt when the signature changes. The signature carries each route's handler identity: a reload that keeps a route's method and path installs a new handler, and a signature of keys alone kept serving the unloaded module's handler.
  */
  const dispatchRouterCache = new WeakMap<PluginLoader, { signature: string; router: Router }>();
  const handlerIds = new WeakMap<object, number>();
  let nextHandlerId = 0;
  const handlerId = (handler: unknown): number => {
    if (typeof handler !== "function") return -1;
    let id = handlerIds.get(handler);
    if (id === undefined) {
      id = ++nextHandlerId;
      handlerIds.set(handler, id);
    }
    return id;
  };
  const dispatchSignature = (entries: Map<string, DispatchEntry>): string =>
    [...entries.entries()]
      .map(([key, entry]) => `${key}\0${handlerId(entry.route.handler)}`)
      .sort()
      .join("\n");

  router.use((req: Request, res: Response, next: import("express").NextFunction) => {
    void (async () => {
      const scope = await resolveScope(req);
      const entries = collectDispatchEntries(scope);
      if (entries.size === 0) {
        next();
        return;
      }
      if (scope) requestScopes.set(req, scope);
      const signature = dispatchSignature(entries);
      const cacheKey = scope?.loader ?? pluginLoader;
      let cached = dispatchRouterCache.get(cacheKey);
      if (!cached || cached.signature !== signature) {
        cached = { signature, router: buildDispatchRouter(entries) };
        dispatchRouterCache.set(cacheKey, cached);
      }
      cached.router(req, res, next);
    })().catch(next);
  });

  return router;
}
