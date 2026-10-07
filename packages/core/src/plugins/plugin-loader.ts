/**
 * PluginLoader - Dynamic plugin loading and lifecycle management.
 *
 * Handles:
 * - Dynamic import of plugins from file paths or npm packages
 * - Plugin lifecycle (load, start, stop)
 * - Dependency resolution via topological sort
 * - Hook invocation across all loaded plugins
 * - Error isolation (plugin crashes don't crash the loader)
 */

import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { copyFile, readFile, rm, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import type { TaskStore } from "../store.js";
import type { WorkflowStepTemplate } from "../types.js";
import { PluginStore } from "../stores/plugin-store.js";
import type {
  FusionPlugin,
  PluginContext,
  PluginLogger,
  PluginToolDefinition,
  PluginRouteDefinition,
  PluginUiSlotDefinition,
  PluginUiContributionDefinition,
  PluginDashboardViewDefinition,
  PluginRuntimeRegistration,
  CliProviderContribution,
  PluginInstallation,
  PluginManifest,
  PluginSkillContribution,
  PluginMcpServerContribution,
  PluginWorkflowStepContribution,
  PluginTraitContribution,
  PluginPromptContribution,
  PluginPromptContributions,
  PluginSetupManifest,
  PluginSetupHooks,
  PluginSetupCheckResult,
} from "./plugin-types.js";
import type { LoadedPluginSchemaContract } from "../postgres/plugin-schema-hook.js";
import type { WorkflowExtensionContribution } from "../workflows/workflow-extension-types.js";
import { normalizePluginUiContributionDefinition, PLUGIN_HOOK_RECEIVES_CONTEXT, validatePluginManifest } from "./plugin-types.js";
import { createLogger } from "../process/logger.js";
import { getCreateAiSessionFactory, getCreateInteractiveAiSessionFactory } from "../ai/ai-engine-loader.js";
import { scanPluginSecurity } from "./plugin-security-scan.js";
import { resolvePluginRootFromEntryPath } from "./plugin-skill-paths.js";
import { createPluginGatedTaskStore } from "../plugin-task-store-gate.js";

// Minimum Fusion version for plugin compatibility checks (can be expanded later)
const MINIMUM_FUSION_VERSION = "0.1.0";
let moduleImportVersion = 0;
const PLUGIN_MANIFEST_PARENT_DIR_NAMES = new Set(["dist", "build", "lib", "src"]);
type CurrentManifestDashboardViewsResult =
  | { found: true; dashboardViews: PluginDashboardViewDefinition[] }
  | { found: false };

/**
 * Resolve the actual loadable entry FILE path for a plugin directory. Node ESM
 * does not allow directory imports, so the registered plugin path must be the
 * explicit file the loader will dynamic-import. Resolution keeps ./bundled.js
 * unconditional because production npm tarballs ship that esbuild-bundled entry.
 * In dev/worktree contexts where no bundle exists, ./dist/index.js remains the
 * prebuilt fallback unless any file under ./src/ is newer than dist/index.js;
 * then ./src/index.ts wins so stale gitignored dist output cannot mask a source
 * fix (FN-6615/FN-6596).
 *
 * FNXC:PluginLoader 2026-06-17-19:20:
 * Prefer fresher src over stale dist only when bundled.js is absent. This keeps
 * production tarballs on their bundled entry while preventing dev/worktree runs
 * from silently loading old gitignored build output after a source fix.
 *
 * Returns null when the directory exists but none of the loadable entry files
 * are present. Callers must treat that as a missing/unloadable plugin rather
 * than persisting a directory path that Node cannot import.
 *
 * Keep in sync with resolvePluginEntryPath in the CLI's
 * bundled-plugin-install.ts, which keeps a local copy so its fs mocks work.
 */
function newestSourceMtimeMs(srcDir: string): number | null {
  let newest = Number.NEGATIVE_INFINITY;

  function visit(dir: string): boolean {
    const entries = (() => {
      try {
        return readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
      } catch {
        return null;
      }
    })();
    if (!entries) return false;

    for (const entry of entries) {
      const entryPath = join(dir, entry.name);
      let entryStat: ReturnType<typeof statSync>;
      try {
        entryStat = statSync(entryPath);
      } catch {
        return false;
      }

      if (entryStat.isDirectory()) {
        if (!visit(entryPath)) return false;
        continue;
      }

      if (entryStat.mtimeMs > newest) {
        newest = entryStat.mtimeMs;
      }
    }

    return true;
  }

  return visit(srcDir) && newest !== Number.NEGATIVE_INFINITY ? newest : null;
}

function isSourceNewerThanDist(srcDir: string, distIndexPath: string): boolean {
  try {
    const distMtimeMs = statSync(distIndexPath).mtimeMs;
    const srcMtimeMs = newestSourceMtimeMs(srcDir);
    return srcMtimeMs !== null && srcMtimeMs > distMtimeMs;
  } catch {
    return false;
  }
}

export function resolvePluginEntryPath(pluginDir: string): string | null {
  const bundledPath = join(pluginDir, "bundled.js");
  if (existsSync(bundledPath)) {
    return bundledPath;
  }

  const distIndexPath = join(pluginDir, "dist", "index.js");
  const srcDir = join(pluginDir, "src");
  const srcIndexPath = join(srcDir, "index.ts");
  const hasDist = existsSync(distIndexPath);
  const hasSrc = existsSync(srcIndexPath);

  if (hasDist && hasSrc) {
    return isSourceNewerThanDist(srcDir, distIndexPath) ? srcIndexPath : distIndexPath;
  }
  if (hasDist) {
    return distIndexPath;
  }
  if (hasSrc) {
    return srcIndexPath;
  }
  return null;
}

export interface PluginLoaderOptions {
  /** Plugin store for persistence */
  pluginStore: PluginStore;
  /** Task store for plugin context */
  taskStore: TaskStore;
  /** Additional directories to scan for plugins */
  pluginDirs?: string[];
  /** npm prefix for resolving packages */
  npmPrefix?: string;
  /** Persist started/stopped/error runtime state transitions (default true). */
  persistRuntimeState?: boolean;
  /**
   * FNXC:PluginLoader 2026-07-23-12:00:
   * FN-8596 discovery loaders may read another project's contributions, but
   * must never join, mutate, or tear down the daemon-wide lifecycle registry
   * or persist runtime state. Isolated loaders own only private instances.
   */
  lifecycleScope?: "shared" | "isolated";
  /**
   * FNXC:PluginHooks 2026-10-07-18:01:
   * Per-plugin bound for each dispatched hook (task, agent-run, and error hooks). A hanging plugin delays later plugins by at most this bound and never blocks their delivery.
   */
  hookTimeoutMs?: number;
  /**
   * FNXC:PluginLoader 2026-10-07-18:01:
   * Bound for an initial onLoad. Dashboard, serve, daemon, desktop, and engine init await loadAllPlugins, so an unbounded onLoad would block startup.
   */
  onLoadTimeoutMs?: number;
}

const DEFAULT_HOOK_TIMEOUT_MS = 5_000;
const DEFAULT_ON_LOAD_TIMEOUT_MS = 30_000;
const DEFAULT_ON_UNLOAD_TIMEOUT_MS = 5_000;
const REJECTING_SCAN_VERDICTS = new Set(["blocked", "error", "unavailable"]);

/**
 * Event emitted when a plugin is loaded and started.
 */
export interface PluginLoadedEvent {
  pluginId: string;
  plugin: FusionPlugin;
}

/**
 * Event emitted when a plugin is unloaded (stopped).
 */
export interface PluginUnloadedEvent {
  pluginId: string;
}

/**
 * Event emitted when a plugin is reloaded with a new version.
 */
export interface PluginReloadedEvent {
  pluginId: string;
  plugin: FusionPlugin;
}

/**
 * Event emitted when a plugin encounters an error.
 */
export interface PluginErrorEvent {
  pluginId: string;
  error: Error;
}

interface ProcessPluginLifecycle {
  promise: Promise<FusionPlugin>;
  owner: PluginLoader;
  participants: Set<PluginLoader>;
}

export class PluginLoader extends EventEmitter<{
  "plugin:loaded": [PluginLoadedEvent];
  "plugin:unloaded": [PluginUnloadedEvent];
  "plugin:reloaded": [PluginReloadedEvent];
  "plugin:error": [PluginErrorEvent];
  "plugin:stopped": [string]; // Kept for backward compatibility
}> {
  /*
  FNXC:PluginTaskStoreGate 2026-07-26-12:20:
  Re-exposed here (in addition to plugin-task-store-gate.ts) because the engine's
  PluginRunner builds its own PluginContexts and must apply the same gate; the
  core barrel (index.ts) is edit-frozen, so the already-exported PluginLoader
  class is the cross-package access point.
  */
  static readonly createGatedTaskStore = createPluginGatedTaskStore;

  /** Loaded plugin instances keyed by plugin id */
  private plugins: Map<string, FusionPlugin> = new Map();

  /** Cache of dynamically imported modules */
  private loadedModules: Map<string, unknown> = new Map();

  /**
   * Resolved plugin entry paths keyed by plugin id, kept in step with `plugins`.
   * FNXC:PluginLoader 2026-10-07-18:01: stopPlugin resolves the lifecycle key from here when the store record is already gone (uninstall), so an uninstalled plugin is still unloaded.
   */
  private pluginEntryPaths: Map<string, string> = new Map();
  private pluginSchemaContracts: Map<string, LoadedPluginSchemaContract> = new Map();

  /*
  FNXC:PluginLoader 2026-07-22-10:15:
  Dashboard/serve/daemon boot a host PluginLoader while InProcessRuntime boots a
  second loader for the same project. `plugins.has()` only protects one loader
  after publication, so this process-wide lifecycle registry coalesces the
  import and onLoad work before either loader can publish. Successful entries
  intentionally persist until stop/reload begins a fresh lifecycle; rejected
  entries are removed so an intentional retry is never poisoned.
  */
  private static readonly processPluginLifecycles = new Map<string, ProcessPluginLifecycle>();
  private static readonly processPluginLifecycleTails = new Map<string, Promise<void>>();

  private readonly log = createLogger("plugin-loader");

  constructor(private options: PluginLoaderOptions) {
    super();
  }

  private async updatePluginState(
    pluginId: string,
    state: PluginInstallation["state"],
    error?: string,
  ): Promise<void> {
    if (this.options.persistRuntimeState === false || this.options.lifecycleScope === "isolated") return;
    await this.options.pluginStore.updatePluginState(pluginId, state, error);
  }

  private getProjectRoot(): string {
    // Lightweight loader harnesses historically omit this TaskStore accessor.
    // Production stores always provide it; cwd preserves their single-project semantics.
    return this.options.taskStore.getRootDir?.() ?? process.cwd();
  }

  // ── Context Creation ───────────────────────────────────────────────

  private async createContext(plugin: FusionPlugin): Promise<PluginContext> {
    return this.createRouteContext(plugin.manifest.id);
  }

  async createRouteContext(
    pluginId: string,
    overrides?: Partial<Pick<PluginContext, "taskStore" | "settings" | "resolveProjectTaskStore" | "emitEvent">>,
  ): Promise<PluginContext> {
    const createAiSession = await getCreateAiSessionFactory();
    const createInteractiveAiSession = await getCreateInteractiveAiSessionFactory();
    if (process.env.DEBUG?.includes("plugins")) {
      this.log.log(
        createAiSession
          ? `[plugin:${pluginId}] createAiSession available`
          : `[plugin:${pluginId}] createAiSession unavailable`,
      );
    }

    /*
    FNXC:PluginTaskStoreGate 2026-07-26-12:20:
    Every context handed to a plugin carries a gated TaskStore: destructive methods
    throw unless the manifest declares permissions.destructiveTaskOps. The gate also
    wraps override stores and project stores resolved via resolveProjectTaskStore so
    a plugin cannot escape the gate through a project-scoped handle.
    */
    const permissions = this.getPlugin(pluginId)?.manifest.permissions;
    const rawTaskStore = overrides?.taskStore ?? this.options.taskStore;
    const rawResolveProjectTaskStore = overrides?.resolveProjectTaskStore;
    return {
      pluginId,
      taskStore: createPluginGatedTaskStore(rawTaskStore, { pluginId, permissions }),
      settings: overrides?.settings ?? await this.getPluginSettings(pluginId),
      logger: this.createLogger(pluginId),
      createAiSession,
      createInteractiveAiSession,
      resolveProjectTaskStore: rawResolveProjectTaskStore
        ? async (projectId: string) =>
            createPluginGatedTaskStore(await rawResolveProjectTaskStore(projectId), { pluginId, permissions })
        : undefined,
      // The host (dashboard) may supply a real publisher that forwards custom
      // plugin events to connected SSE clients. Absent an override, fall back to
      // logging (the historical no-op behavior) so non-dashboard hosts and tests
      // keep working.
      emitEvent: overrides?.emitEvent ?? ((event: string, data: unknown) => {
        this.log.log(`[plugin:${pluginId}] Custom event: ${event}`, data);
      }),
    };
  }

  private createLogger(pluginId: string): PluginLogger {
    const pluginLog = createLogger(`plugin:${pluginId}`);
    return {
      info: (message: string, ...args: unknown[]) => pluginLog.log(message, ...args),
      warn: (message: string, ...args: unknown[]) => pluginLog.warn(message, ...args),
      error: (message: string, ...args: unknown[]) => pluginLog.error(message, ...args),
      debug: (message: string, ...args: unknown[]) => {
        if (process.env.DEBUG?.includes("plugins")) {
          pluginLog.log(message, ...args);
        }
      },
    };
  }

  private async getPluginSettings(pluginId: string): Promise<Record<string, unknown>> {
    try {
      const plugin = await this.options.pluginStore.getPlugin(pluginId);
      return plugin.settings;
    } catch {
      return {};
    }
  }

  /**
   * Record a successful plugin or workflow-extension activation without letting analytics persistence change loader behavior.
   *
   * FNXC:CommandCenterEcosystem 2026-06-19-08:00:
   * Command Center Ecosystem plugin-activation counts must be backed by real project-scoped load/reload events. Analytics writes are fail-soft so a DB problem never prevents a plugin or extension from activating.
   */
  private recordActivationEvent(pluginId: string, plugin: FusionPlugin): void {
    try {
      this.options.taskStore.recordPluginActivation({
        pluginId,
        source: this.resolveActivationSource(plugin),
        pluginVersion: plugin.manifest.version,
      });
    } catch (error) {
      this.log.warn(`Failed to record plugin activation for ${pluginId}:`, error);
    }
  }

  private resolveActivationSource(plugin: FusionPlugin): "plugin" | "extension" {
    const hasWorkflowExtensions =
      (plugin.workflowExtensions?.length ?? 0) > 0 ||
      (plugin.manifest.workflowExtensions?.length ?? 0) > 0;
    return hasWorkflowExtensions ? "extension" : "plugin";
  }

  // ── Plugin Loading ─────────────────────────────────────────────────

  /**
   * Load and start a single plugin.
   */
  async loadPlugin(pluginId: string): Promise<FusionPlugin> {
    // Get plugin installation record
    let installation: PluginInstallation;
    try {
      installation = await this.options.pluginStore.getPlugin(pluginId);
    } catch (err) {
      throw new Error(`Plugin "${pluginId}" not found in store: ${(err as Error).message}`);
    }

    // Skip disabled plugins
    if (!installation.enabled) {
      this.log.log(`Skipping disabled plugin: ${pluginId}`);
      throw Object.assign(new Error(`Plugin "${pluginId}" is disabled`), {
        code: "PLUGIN_DISABLED",
      });
    }

    // Skip already loaded plugins
    if (this.plugins.has(pluginId)) {
      this.log.log(`Plugin already loaded: ${pluginId}`);
      /*
      FNXC:PluginLoader 2026-10-07-18:01:
      Enable and rescan call loadPlugin on a plugin that may already be loaded. Persisted state must say so, or a stale "error" row survives every recovery action the dashboard offers.
      */
      if (installation.state !== "started") {
        try {
          await this.updatePluginState(pluginId, "started");
        } catch (err) {
          this.log.warn(`Failed to reconcile persisted state for loaded plugin ${pluginId}:`, err);
        }
      }
      return this.plugins.get(pluginId)!;
    }

    // Resolve plugin path. Discovery instances deliberately bypass the shared
    // registry so their teardown can affect only their private plugin maps.
    const pluginPath = this.resolvePluginPath(installation.path);
    if (this.options.lifecycleScope === "isolated") {
      return await this.loadPluginFresh(pluginId, installation, pluginPath);
    }
    const lifecycleKey = this.getProcessLifecycleKey(pluginId, pluginPath);
    const existingLifecycle = PluginLoader.processPluginLifecycles.get(lifecycleKey);
    if (existingLifecycle) {
      existingLifecycle.participants.add(this);
      const plugin = await existingLifecycle.promise;
      return this.adoptProcessLoadedPlugin(pluginId, pluginPath, plugin);
    }

    const lifecycle = this.loadPluginFresh(pluginId, installation, pluginPath);
    const processLifecycle: ProcessPluginLifecycle = {
      promise: lifecycle,
      owner: this,
      participants: new Set([this]),
    };
    PluginLoader.processPluginLifecycles.set(lifecycleKey, processLifecycle);
    try {
      return await lifecycle;
    } catch (error) {
      // Only remove our own rejected promise; a later retry may already own this key.
      if (PluginLoader.processPluginLifecycles.get(lifecycleKey) === processLifecycle) {
        PluginLoader.processPluginLifecycles.delete(lifecycleKey);
      }
      throw error;
    }
  }

  private getProcessLifecycleKey(pluginId: string, pluginPath: string): string {
    return `${resolve(this.getProjectRoot())}\u0000${pluginId}\u0000${resolve(pluginPath)}`;
  }

  private adoptProcessLoadedPlugin(pluginId: string, pluginPath: string, plugin: FusionPlugin): FusionPlugin {
    plugin.state = "started";
    this.plugins.set(pluginId, plugin);
    this.pluginEntryPaths.set(pluginId, pluginPath);
    this.emit("plugin:loaded", { pluginId, plugin });
    return plugin;
  }

  private async loadPluginFresh(
    pluginId: string,
    installation: PluginInstallation,
    pluginPath: string,
  ): Promise<FusionPlugin> {
    try {
      await this.runPreImportSecurityGate(pluginId, installation, pluginPath);

      // Dynamic import the plugin - always bypass cache to get fresh code
      // Our loadedModules cache is cleared on stop, but Node.js ESM cache persists
      const mod = await this.importPluginModule(pluginPath, true);
      const plugin = this.extractPluginFromModule(mod);

      // Validate manifest
      const manifestValidation = validatePluginManifest(plugin.manifest);
      if (!manifestValidation.valid) {
        throw new Error(
          `Invalid plugin manifest: ${manifestValidation.errors.join(", ")}`,
        );
      }

      await this.refreshPersistedManifestMetadata(installation, plugin.manifest);

      // Check version compatibility
      if (plugin.manifest.fusionVersion) {
        const compatible = this.checkVersionCompatibility(
          plugin.manifest.fusionVersion,
        );
        if (!compatible) {
          this.log.warn(
            `Plugin ${pluginId} requires Fusion ${plugin.manifest.fusionVersion}, minimum is ${MINIMUM_FUSION_VERSION}`,
          );
        }
      }

      // Resolve dependencies
      await this.resolveDependencies(plugin);

      /*
      FNXC:PluginPostgresContract 2026-07-14-18:32:
      Schema compatibility and DDL must finish before started state, map
      publication, or onLoad. A SQLite-only third-party plugin therefore fails
      without leaving subscriptions, timers, or other onLoad side effects.
      */
      const schemaContract = this.options.taskStore.preflightPluginSchema(pluginId, plugin.hooks);
      if (schemaContract) await this.options.taskStore.runPluginSchemaInits([schemaContract]);

      // Update state to started
      await this.updatePluginState(pluginId, "started");

      // Update plugin state locally and store
      plugin.state = "started";
      this.plugins.set(pluginId, plugin);
      this.pluginEntryPaths.set(pluginId, pluginPath);
      if (schemaContract) this.pluginSchemaContracts.set(pluginId, schemaContract);

      // A failed or timed-out onLoad has already been unloaded; the outer catch clears maps and persists the error once.
      await this.startInstance(plugin, this.options.onLoadTimeoutMs ?? DEFAULT_ON_LOAD_TIMEOUT_MS, "onLoad");

      this.recordActivationEvent(pluginId, plugin);
      this.emit("plugin:loaded", { pluginId, plugin });
      return plugin;
    } catch (err) {
      // Ensure plugin is removed from loaded map on any failure
      // (it may have been added above before the onLoad hook)
      this.plugins.delete(pluginId);
      this.pluginEntryPaths.delete(pluginId);
      this.pluginSchemaContracts.delete(pluginId);

      // Error isolation: set error state but don't crash
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.updatePluginState(
        pluginId,
        "error",
        errorMsg,
      );

      this.emit("plugin:error", {
        pluginId,
        error: err instanceof Error ? err : new Error(errorMsg),
      });

      throw err;
    }
  }

  /**
   * FNXC:PluginSecurityScan 2026-10-07-18:01:
   * One pre-import gate for every path that executes plugin code from disk: initial load, reload, and dashboard rescan, which delegates to those two.
   * A blocked, error, or unavailable verdict rejects before any import. The scanner reads package files, so it receives the package root, not the entry file.
   */
  private async runPreImportSecurityGate(
    pluginId: string,
    installation: PluginInstallation,
    pluginPath: string,
  ): Promise<void> {
    if (!installation.aiScanOnLoad) return;
    const scanResult = await scanPluginSecurity({ pluginId, pluginPath: await this.resolveScanRoot(pluginPath) });
    await this.options.pluginStore.updatePlugin(pluginId, { lastSecurityScan: scanResult });
    if (REJECTING_SCAN_VERDICTS.has(scanResult.verdict)) {
      throw Object.assign(new Error(`Security scan ${scanResult.verdict}: ${scanResult.summary}`), {
        code: "PLUGIN_SECURITY_SCAN_REJECTED",
      });
    }
  }

  private async resolveScanRoot(pluginPath: string): Promise<string> {
    try {
      if ((await stat(pluginPath)).isDirectory()) return pluginPath;
    } catch {
      // A missing entry still scans its would-be package root; the import step reports the missing file.
    }
    return resolvePluginRootFromEntryPath(pluginPath);
  }

  /**
   * FNXC:PluginLoader 2026-10-07-18:01:
   * Run onLoad under a bound. On failure or timeout, call onUnload on that same instance so partial side effects (timers, subscriptions, child processes) do not leak.
   * A timed-out onLoad that settles later is unloaded again, so at most one live instance exists per lifecycle key.
   */
  private async startInstance(plugin: FusionPlugin, timeoutMs: number, label: string): Promise<void> {
    const pluginId = plugin.manifest.id;
    const ctx = await this.createContext(plugin);
    const onLoad = this.safeCallHook(plugin, "onLoad", [ctx]);
    let settled = false;
    const observed = onLoad.then(() => { settled = true; }, () => { settled = true; });
    try {
      await this.withTimeout(onLoad, timeoutMs, `${label} timeout for ${pluginId}`);
    } catch (err) {
      await this.unloadInstanceBestEffort(plugin);
      if (!settled) {
        void observed.then(async () => {
          this.log.warn(`${label} for ${pluginId} settled after its timeout; unloading the late instance`);
          await this.unloadInstanceBestEffort(plugin);
        });
      }
      throw err;
    }
  }

  private async unloadInstanceBestEffort(plugin: FusionPlugin, timeoutMs = DEFAULT_ON_UNLOAD_TIMEOUT_MS): Promise<void> {
    const pluginId = plugin.manifest.id;
    try {
      const ctx = await this.createContext(plugin);
      await this.withTimeout(
        this.safeCallHook(plugin, "onUnload", [ctx]),
        timeoutMs,
        `onUnload timeout for ${pluginId}`,
      );
    } catch (err) {
      this.log.warn(`onUnload for ${pluginId} timed out or failed:`, err);
    }
  }

  private async refreshPersistedManifestMetadata(
    installation: PluginInstallation,
    manifest: PluginManifest,
  ): Promise<void> {
    const versionChanged = installation.version !== manifest.version;
    const settingsSchemaChanged =
      this.stableManifestMetadataJson(installation.settingsSchema ?? null) !==
      this.stableManifestMetadataJson(manifest.settingsSchema ?? null);

    if (!versionChanged && !settingsSchemaChanged) {
      return;
    }

    try {
      /*
      FNXC:Plugins 2026-07-12-10:59:
      FN-7855 requires each fresh module re-import to reconcile persisted manifest metadata for path-registered plugins, because rebuilt code can change version/settingsSchema without re-registration.
      Keep this update metadata-only so per-project enablement and saved setting values survive reload/restart; bundled plugins may already be current from ensureBundledPluginInstalled, making this idempotent.
      */
      await this.options.pluginStore.updatePlugin(installation.id, {
        ...(versionChanged ? { version: manifest.version } : {}),
        ...(settingsSchemaChanged ? { settingsSchema: manifest.settingsSchema ?? null } : {}),
      });
    } catch (err) {
      this.log.warn(
        `Failed to refresh persisted manifest metadata for plugin ${installation.id}:`,
        err,
      );
    }
  }

  private stableManifestMetadataJson(value: unknown): string {
    if (value === null || value === undefined) {
      return "null";
    }
    if (Array.isArray(value)) {
      return `[${value.map((entry) => this.stableManifestMetadataJson(entry)).join(",")}]`;
    }
    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${this.stableManifestMetadataJson(record[key])}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  }

  private resolvePluginPath(path: string): string {
    // If already absolute, use as-is
    if (isAbsolute(path)) {
      return path;
    }

    // Check if it's an npm package (contains / or starts with @)
    if (path.startsWith("@") || path.includes("/")) {
      // For npm packages, we'd use require.resolve in a real implementation
      // For now, assume it's a local path relative to project root
      return resolve(this.getProjectRoot(), path);
    }

    // Default: resolve relative to project root
    return resolve(this.getProjectRoot(), path);
  }

  private async importPluginModule(path: string, bypassCache = false): Promise<unknown> {
    // Check cache first (unless bypassing cache for reload)
    if (!bypassCache && this.loadedModules.has(path)) {
      return this.loadedModules.get(path)!;
    }

    let pathStats;
    try {
      pathStats = await stat(path);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      throw new Error(`Plugin entry does not exist: ${path} (${errorMessage})`);
    }

    if (pathStats.isDirectory()) {
      throw new Error(`Plugin entry must be a file, got directory: ${path}`);
    }

    // Dynamic import - normalize to file URL so query params are honored
    // consistently across Node + Vitest environments.
    const moduleUrl = pathToFileURL(path).href;
    let mod: unknown;

    if (bypassCache) {
      moduleImportVersion += 1;
      const ext = extname(path);
      const baseName = basename(path, ext);
      const reloadedPath = resolve(dirname(path), `.${baseName}.reload-${moduleImportVersion}${ext}`);
      await copyFile(path, reloadedPath);
      /*
      FNXC:PluginLoader 2026-08-11-09:58:
      FN-8990 requires the cache-busting copy to exist only for the dynamic ESM import.
      The module remains resident after import settles, so remove the copy to prevent
      plugin working trees accumulating and accidentally committing reload scratch files.
      */
      try {
        mod = await import(pathToFileURL(reloadedPath).href);
      } finally {
        try {
          await rm(reloadedPath, { force: true });
        } catch {
          // Best-effort cleanup: a failed scratch removal should not fail a successful plugin import.
        }
      }
    } else {
      mod = await import(moduleUrl);
    }
    this.loadedModules.set(path, mod);
    return mod;
  }

  /**
   * Invalidate the module cache for a plugin path.
   * This ensures a fresh import when the plugin is loaded again.
   */
  private invalidateModuleCache(path: string): void {
    this.loadedModules.delete(path);
    this.log.log(`Module cache invalidated for: ${path}`);
  }

  /**
   * Reload a plugin: stop the old instance, re-import, and start the new one.
   * On failure, roll back to the old instance.
   *
   * @param pluginId - The plugin to reload
   * @param options - Options including timeout for onUnload/onLoad hooks
   */
  async reloadPlugin(
    pluginId: string,
    options?: { timeoutMs?: number },
  ): Promise<FusionPlugin> {
    const installation = await this.options.pluginStore.getPlugin(pluginId);
    const pluginPath = this.resolvePluginPath(installation.path);
    /*
    FNXC:PluginLoader 2026-07-23-12:00:
    FN-8596 requires explicit private reload semantics for isolated discovery
    loaders. Never synchronize an inspection instance into shared participants.
    */
    if (this.options.lifecycleScope === "isolated") {
      return await this.reloadPluginFresh(pluginId, installation, pluginPath, options);
    }
    const lifecycleKey = this.getProcessLifecycleKey(pluginId, pluginPath);
    const processLifecycle = PluginLoader.processPluginLifecycles.get(lifecycleKey);
    const precedingLifecycle = processLifecycle?.promise;

    const reload = this.enqueueProcessLifecycleOperation(lifecycleKey, async () => {
      /*
      FNXC:PluginLoader 2026-10-07-18:01:
      A failed predecessor must not fail this reload: a rolled-back reload leaves the old instance running, and a failed initial load leaves nothing loaded, which reloadPluginFresh reports itself.
      */
      try {
        await precedingLifecycle;
      } catch {
        // Outcome is re-derived from the owner's map below.
      }
      const owner = processLifecycle?.owner ?? this;
      const plugin = await owner.reloadPluginFresh(pluginId, installation, pluginPath, options);
      if (processLifecycle) {
        this.synchronizeProcessPlugin(processLifecycle, pluginId, pluginPath, plugin);
      }
      return plugin;
    });
    if (processLifecycle) processLifecycle.promise = reload;
    try {
      return await reload;
    } catch (error) {
      if (processLifecycle && PluginLoader.processPluginLifecycles.get(lifecycleKey) === processLifecycle) {
        // reloadPluginFresh restores the canonical owner when rollback succeeds.
        const restored = processLifecycle.owner.plugins.get(pluginId);
        if (restored) {
          processLifecycle.promise = Promise.resolve(restored);
          this.synchronizeProcessPlugin(processLifecycle, pluginId, pluginPath, restored);
        } else {
          // The owner dropped the plugin (scan rejection or failed rollback); no adopter may keep serving it.
          this.discardParticipantViews(processLifecycle, pluginId, pluginPath);
          PluginLoader.processPluginLifecycles.delete(lifecycleKey);
        }
      }
      throw error;
    }
  }

  /*
  FNXC:PluginLoader 2026-07-22-16:20:
  A process lifecycle is shared by host and engine loaders, not merely its
  initial onLoad promise. Stop and reload must update every adopter so no
  loader retains an old active instance after another surface changes it.

  FNXC:PluginLoader 2026-10-07-18:01:
  Adopters also emit the matching loader event, because each engine PluginRunner invalidates its tool, route, and runtime caches only from its own loader's events.
  */
  private synchronizeProcessPlugin(
    lifecycle: ProcessPluginLifecycle,
    pluginId: string,
    pluginPath: string,
    plugin: FusionPlugin,
  ): void {
    for (const loader of lifecycle.participants) {
      if (loader === lifecycle.owner) continue;
      loader.plugins.set(pluginId, plugin);
      loader.pluginEntryPaths.set(pluginId, pluginPath);
      loader.pluginSchemaContracts.delete(pluginId);
      loader.emit("plugin:reloaded", { pluginId, plugin });
    }
  }

  private discardParticipantViews(lifecycle: ProcessPluginLifecycle, pluginId: string, pluginPath: string): void {
    for (const loader of lifecycle.participants) {
      if (loader === lifecycle.owner) continue;
      loader.releaseProcessPluginView(pluginId, pluginPath);
    }
  }

  /** Drop this loader's view of a plugin whose instance another loader owns, announcing it when the view existed. */
  private releaseProcessPluginView(pluginId: string, pluginPath: string): void {
    const held = this.plugins.has(pluginId);
    this.discardProcessPlugin(pluginId, pluginPath);
    if (held) {
      this.emit("plugin:unloaded", { pluginId });
      this.emit("plugin:stopped", pluginId);
    }
  }

  private async enqueueProcessLifecycleOperation<T>(
    lifecycleKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const predecessor = PluginLoader.processPluginLifecycleTails.get(lifecycleKey) ?? Promise.resolve();
    const queued = predecessor.catch(() => undefined).then(operation);
    const tail = queued.then(() => undefined, () => undefined);
    PluginLoader.processPluginLifecycleTails.set(lifecycleKey, tail);
    void tail.finally(() => {
      if (PluginLoader.processPluginLifecycleTails.get(lifecycleKey) === tail) {
        PluginLoader.processPluginLifecycleTails.delete(lifecycleKey);
      }
    });
    return await queued;
  }

  private async reloadPluginFresh(
    pluginId: string,
    installation: PluginInstallation,
    pluginPath: string,
    options?: { timeoutMs?: number },
  ): Promise<FusionPlugin> {
    const timeoutMs = options?.timeoutMs ?? 5000;

    // A concurrent startup load may have completed on another loader.
    const oldPlugin = this.plugins.get(pluginId);
    if (!oldPlugin) {
      throw Object.assign(new Error(`Plugin "${pluginId}" is not loaded`), {
        code: "PLUGIN_NOT_LOADED",
      });
    }

    this.log.log(`Reloading plugin: ${pluginId}`);

    /*
    FNXC:PluginSecurityScan 2026-10-07-18:01:
    Reload and rescan re-import code from disk, so they pass the same gate as the initial load before anything is imported.
    A rejection fails closed: the running instance is unloaded and the plugin parks in error, because the package on disk no longer passes the gate the operator enabled.
    */
    try {
      await this.runPreImportSecurityGate(pluginId, installation, pluginPath);
    } catch (scanErr) {
      await this.unloadInstanceBestEffort(oldPlugin, timeoutMs);
      this.discardProcessPlugin(pluginId, pluginPath);
      const errorMsg = scanErr instanceof Error ? scanErr.message : String(scanErr);
      await this.updatePluginState(pluginId, "error", errorMsg);
      this.emit("plugin:unloaded", { pluginId });
      this.emit("plugin:error", { pluginId, error: scanErr instanceof Error ? scanErr : new Error(errorMsg) });
      throw scanErr;
    }

    // Unload the old instance; reload continues even when its onUnload fails or times out.
    await this.unloadInstanceBestEffort(oldPlugin, timeoutMs);

    // Remove old module from cache
    this.invalidateModuleCache(pluginPath);

    // Snapshot old plugin for rollback
    const snapshot = { ...oldPlugin };
    const oldSchemaContract = this.pluginSchemaContracts.get(pluginId);

    try {
      // Re-import the plugin module
      const mod = await this.importPluginModule(pluginPath, true);
      const newPlugin = this.extractPluginFromModule(mod);

      // Validate manifest
      const manifestValidation = validatePluginManifest(newPlugin.manifest);
      if (!manifestValidation.valid) {
        throw new Error(
          `Invalid plugin manifest: ${manifestValidation.errors.join(", ")}`,
        );
      }

      // Update plugin state
      const schemaContract = this.options.taskStore.preflightPluginSchema(pluginId, newPlugin.hooks);
      if (schemaContract) await this.options.taskStore.runPluginSchemaInits([schemaContract]);
      newPlugin.state = "started";

      // Replace in plugins map
      this.plugins.set(pluginId, newPlugin);
      this.pluginEntryPaths.set(pluginId, pluginPath);
      if (schemaContract) this.pluginSchemaContracts.set(pluginId, schemaContract);
      else this.pluginSchemaContracts.delete(pluginId);

      // A failed or timed-out new onLoad receives onUnload before rollback reactivates the old instance.
      await this.startInstance(newPlugin, timeoutMs, "onLoad");

      await this.refreshPersistedManifestMetadata(installation, newPlugin.manifest);

      /*
      FNXC:PluginLoader 2026-10-07-18:01:
      A loaded plugin may carry a stale persisted "error", for example from an old hook failure. A successful reload persists "started"; the store treats started -> started as an idempotent no-op.
      */
      await this.updatePluginState(pluginId, "started");

      this.log.log(`Plugin ${pluginId} reloaded successfully`);

      this.recordActivationEvent(pluginId, newPlugin);
      this.emit("plugin:reloaded", { pluginId, plugin: newPlugin });
      return newPlugin;
    } catch (err) {
      // Rollback: restore old plugin
      this.log.error(`Reload failed for ${pluginId}, rolling back:`, err);

      try {
        // Restore old plugin
        this.plugins.set(pluginId, snapshot);
        this.pluginEntryPaths.set(pluginId, pluginPath);
        if (oldSchemaContract) this.pluginSchemaContracts.set(pluginId, oldSchemaContract);
        else this.pluginSchemaContracts.delete(pluginId);

        // Attempt to reactivate old plugin
        await this.startInstance(snapshot, timeoutMs, "Rollback onLoad");

        // Update store state back to started
        await this.updatePluginState(pluginId, "started");

        this.log.warn(`Rollback successful for ${pluginId}`);
      } catch (rollbackErr) {
        // Rollback also failed - remove plugin and set error state
        this.log.error(
          `Rollback failed for ${pluginId}, removing plugin:`,
          rollbackErr,
        );

        this.plugins.delete(pluginId);
        this.pluginEntryPaths.delete(pluginId);
        this.pluginSchemaContracts.delete(pluginId);

        const originalError = err instanceof Error ? err.message : String(err);
        const rollbackError = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        const combinedError = `Reload failed and rollback failed: ${originalError}; ${rollbackError}`;

        await this.updatePluginState(
          pluginId,
          "error",
          combinedError,
        );

        this.emit("plugin:unloaded", { pluginId });
        this.emit("plugin:error", {
          pluginId,
          error: new Error(combinedError),
        });

        throw err; // Throw original error
      }

      throw err;
    }
  }

  /**
   * Execute a promise with a timeout.
   */
  private withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    timeoutMessage: string,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(timeoutMessage));
      }, ms);

      promise
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  private extractPluginFromModule(mod: unknown): FusionPlugin {
    if (!mod || typeof mod !== "object") {
      throw new Error("Plugin module must export an object");
    }

    const obj = mod as Record<string, unknown>;

    // Look for default export first, then named export
    const pluginExport = obj.default ?? obj.plugin;

    if (!pluginExport || typeof pluginExport !== "object") {
      throw new Error(
        "Plugin module must export a default 'FusionPlugin' or have a 'plugin' export",
      );
    }

    const plugin = pluginExport as FusionPlugin;

    // Basic validation
    if (!plugin.manifest?.id) {
      throw new Error("Plugin must have a manifest with id");
    }

    return plugin;
  }

  private checkVersionCompatibility(requiredVersion: string): boolean {
    // Simple version comparison for now
    // In a real implementation, use a proper semver library
    const required = this.parseVersion(requiredVersion);
    const minimum = this.parseVersion(MINIMUM_FUSION_VERSION);

    if (required.major > minimum.major) return false;
    if (required.major < minimum.major) return true;
    if (required.minor > minimum.minor) return false;
    if (required.minor < minimum.minor) return true;
    return required.patch <= minimum.patch;
  }

  private parseVersion(version: string): { major: number; minor: number; patch: number } {
    const parts = version.split(".").map(Number);
    return {
      major: parts[0] || 0,
      minor: parts[1] || 0,
      patch: parts[2] || 0,
    };
  }

  private async resolveDependencies(plugin: FusionPlugin): Promise<void> {
    if (!plugin.manifest.dependencies?.length) return;

    for (const depId of plugin.manifest.dependencies) {
      if (!this.plugins.has(depId)) {
        throw new Error(
          `Plugin ${plugin.manifest.id} depends on ${depId}, which is not loaded`,
        );
      }
    }
  }

  // ── Load All ──────────────────────────────────────────────────────

  /**
   * Load all plugins that are enabled for this PluginStore's project scope in dependency order.
   */
  async loadAllPlugins(): Promise<{ loaded: number; errors: number }> {
    const plugins = await this.options.pluginStore.listPlugins();
    for (const installation of plugins) {
      if (!installation.enabled) {
        /*
         * FNXC:PluginSkills 2026-07-10-00:00:
         * Disabled-at-load plugins must be visible in normal daemon logs. Issue #1981 was expensive to diagnose because loadAllPlugins silently omitted disabled plugins, hiding that the loader was using the wrong project enablement scope.
         */
        this.log.warn(`Skipped disabled plugin during loadAllPlugins: ${installation.id}`);
      }
    }
    const sorted = this.resolveLoadOrder(plugins.filter((plugin) => plugin.enabled));

    let loaded = 0;
    let errors = 0;

    for (const installation of sorted) {
      try {
        await this.loadPlugin(installation.id);
        loaded++;
      } catch (err) {
        if ((err as { code?: string }).code === "PLUGIN_DISABLED") {
          this.log.warn(`Skipped disabled plugin during loadAllPlugins: ${installation.id}`);
          continue;
        }
        errors++;
        this.log.error(
          `Failed to load plugin ${installation.id}:`,
          err,
        );
      }
    }

    return { loaded, errors };
  }

  /**
   * Topological sort for load order.
   */
  resolveLoadOrder(plugins: PluginInstallation[]): PluginInstallation[] {
    const pluginMap = new Map(plugins.map((p) => [p.id, p]));
    const visited = new Set<string>();
    const result: PluginInstallation[] = [];
    const visiting = new Set<string>();

    const visit = (id: string) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        throw new Error(`Circular dependency detected: ${id}`);
      }

      const plugin = pluginMap.get(id);
      if (!plugin) return; // Skip plugins not in our list

      visiting.add(id);

      // Visit dependencies first
      for (const depId of plugin.dependencies || []) {
        visit(depId);
      }

      visiting.delete(id);
      visited.add(id);
      result.push(plugin);
    };

    for (const plugin of plugins) {
      visit(plugin.id);
    }

    return result;
  }

  // ── Plugin Stopping ────────────────────────────────────────────────

  /**
   * Stop and unload a single plugin.
   */
  async stopPlugin(pluginId: string): Promise<void> {
    const target = await this.resolveStopTarget(pluginId);
    if (!target) {
      this.log.log(`Plugin not loaded: ${pluginId}`);
      return;
    }
    const { pluginPath, persistState, processWide } = target;
    if (this.options.lifecycleScope === "isolated") {
      await this.stopPluginFresh(pluginId, pluginPath, persistState);
      return;
    }
    const lifecycleKey = this.getProcessLifecycleKey(pluginId, pluginPath);
    const processLifecycle = PluginLoader.processPluginLifecycles.get(lifecycleKey);
    if (!processLifecycle) {
      await this.stopPluginFresh(pluginId, pluginPath, persistState);
      return;
    }

    /*
    FNXC:PluginLoader 2026-10-07-18:01:
    Capture the predecessor before enqueueing. A later reload replaces processLifecycle.promise with its own operation, which is queued behind this stop; reading it at execution time made the stop await its own successor and deadlocked the plugin's queue.
    */
    const precedingLifecycle = processLifecycle.promise;
    await this.enqueueProcessLifecycleOperation(lifecycleKey, async () => {
      try {
        await precedingLifecycle;
      } catch {
        // A rejected load has already cleaned its local state.
      }
      if (processLifecycle.owner !== this && !processWide) {
        // Participants adopted the owner's instance; stopping one only detaches
        // that view and must not unload or persist state for the shared owner.
        processLifecycle.participants.delete(this);
        this.releaseProcessPluginView(pluginId, pluginPath);
        return;
      }
      await processLifecycle.owner.stopPluginFresh(pluginId, pluginPath, persistState);
      this.discardParticipantViews(processLifecycle, pluginId, pluginPath);
      if (PluginLoader.processPluginLifecycles.get(lifecycleKey) === processLifecycle) {
        PluginLoader.processPluginLifecycles.delete(lifecycleKey);
      }
    });
  }

  /**
   * FNXC:PluginLoader 2026-10-07-18:01:
   * A stop of a plugin that is disabled or uninstalled for this project is process-wide: the owner unloads and every adopter drops its view, whichever loader asked.
   * A stop of a still-enabled plugin from an adopter (engine shutdown) keeps detaching only that view.
   * An uninstall deletes the store record before the runner's stop runs, so the entry path falls back to this loader's in-memory map and nothing is persisted for the missing record.
   */
  private async resolveStopTarget(
    pluginId: string,
  ): Promise<{ pluginPath: string; persistState: boolean; processWide: boolean } | null> {
    try {
      const installation = await this.options.pluginStore.getPlugin(pluginId);
      return {
        pluginPath: this.resolvePluginPath(installation.path),
        persistState: true,
        processWide: !installation.enabled,
      };
    } catch (err) {
      const pluginPath = this.pluginEntryPaths.get(pluginId);
      if (!pluginPath) return null;
      return {
        pluginPath,
        persistState: false,
        processWide: (err as { code?: string }).code === "ENOENT",
      };
    }
  }

  private async stopPluginFresh(pluginId: string, pluginPath: string, persistState = true): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      this.log.log(`Plugin not loaded: ${pluginId}`);
      return;
    }

    await this.unloadInstanceBestEffort(plugin);

    if (persistState) await this.updatePluginState(pluginId, "stopped");
    this.discardProcessPlugin(pluginId, pluginPath);
    this.emit("plugin:unloaded", { pluginId });
    this.emit("plugin:stopped", pluginId);
  }

  private discardProcessPlugin(pluginId: string, pluginPath: string): void {
    this.plugins.delete(pluginId);
    this.pluginEntryPaths.delete(pluginId);
    this.pluginSchemaContracts.delete(pluginId);
    this.invalidateModuleCache(pluginPath);
  }

  /**
   * Stop all loaded plugins in reverse dependency order.
   */
  async stopAllPlugins(): Promise<void> {
    // Get plugins in reverse topological order
    const loadedPlugins = Array.from(this.plugins.values());
    const sorted = this.resolveLoadOrder(
      loadedPlugins.map((p) => ({
        id: p.manifest.id,
        name: p.manifest.name,
        version: p.manifest.version,
        description: p.manifest.description,
        author: p.manifest.author,
        homepage: p.manifest.homepage,
        path: "",
        enabled: true,
        state: p.state,
        settings: {},
        dependencies: p.manifest.dependencies,
        createdAt: "",
        updatedAt: "",
      })),
    );

    // Stop in reverse order
    for (const plugin of sorted.reverse()) {
      try {
        await this.stopPlugin(plugin.id);
      } catch (err) {
        this.log.error(`Error stopping plugin ${plugin.id}:`, err);
      }
    }
  }

  // ── Hook Invocation ────────────────────────────────────────────────

  /**
   * Invoke a hook on all loaded plugins.
   * Errors are isolated - one plugin's failure doesn't affect others.
   */
  async invokeHook(
    hookName: keyof FusionPlugin["hooks"],
    ...args: unknown[]
  ): Promise<void> {
    /*
    FNXC:PluginHooks 2026-10-07-18:01:
    Each plugin's hook, and its onError follow-up, runs under its own bound. A hanging plugin delays later plugins by at most that bound and never stops them receiving the event; a late settlement is ignored.
    */
    const timeoutMs = this.options.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    for (const [pluginId, plugin] of this.plugins) {
      const hook = plugin.hooks[hookName];
      if (!hook) continue;

      try {
        await this.withTimeout(
          this.safeCallHook(plugin, hookName, args),
          timeoutMs,
          `${hookName} hook for ${pluginId} timed out after ${timeoutMs}ms`,
        );
      } catch (err) {
        this.log.error(
          `Error in ${hookName} hook for ${pluginId}:`,
          err,
        );

        await this.recordHookFailure(pluginId, hookName, err);

        // Call onError hook if available
        if (hookName !== "onError" && plugin.hooks.onError) {
          try {
            const ctx = await this.createContext(plugin);
            await this.withTimeout(
              this.safeCallHook(plugin, "onError", [err instanceof Error ? err : new Error(String(err)), ctx]),
              timeoutMs,
              `onError hook for ${pluginId} timed out after ${timeoutMs}ms`,
            );
          } catch {
            // Non-fatal
          }
        }
      }
    }
  }

  /**
   * FNXC:PluginLoader 2026-10-07-18:01:
   * A hook failure is health information, not a lifecycle change: the plugin stays loaded and keeps serving tools, routes, runtimes, and prompt contributions.
   * Persist the failure in the record's error field while keeping state "started", so state keeps meaning "is it loaded" and reload, enable, and rescan act on the truth.
   */
  private async recordHookFailure(pluginId: string, hookName: string, err: unknown): Promise<void> {
    try {
      await this.updatePluginState(
        pluginId,
        "started",
        `${hookName} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } catch {
      // Non-fatal: health bookkeeping must not break dispatch to later plugins.
    }
  }

  private async safeCallHook(
    plugin: FusionPlugin,
    hookName: keyof FusionPlugin["hooks"],
    args: unknown[],
  ): Promise<void> {
    const hook = plugin.hooks[hookName];
    if (!hook) return;

    const fn = hook as (...args: unknown[]) => unknown;
    const result = fn(...await this.withLifecycleHookContext(plugin, hookName, args));
    if (result instanceof Promise) {
      await result;
    }
  }

  private async withLifecycleHookContext(
    plugin: FusionPlugin,
    hookName: keyof FusionPlugin["hooks"],
    args: unknown[],
  ): Promise<unknown[]> {
    if (PLUGIN_HOOK_RECEIVES_CONTEXT[hookName] !== true || this.hasPluginContext(args.at(-1))) {
      return args;
    }

    /*
    FNXC:PluginHooks 2026-07-01-13:36:
    Runtime task lifecycle hooks are invoked from fire-and-forget TaskStore event bridges, but the public hook contract still requires a per-plugin PluginContext. Append the context in PluginLoader so all runtime callers keep the fast raw event-argument path while plugins consistently receive taskStore, settings, logger, and emitEvent.

    FNXC:PluginHooks 2026-10-07-18:01:
    The executor dispatches onAgentRunStart/onAgentRunEnd with only a task id. Every hook classified in PLUGIN_HOOK_RECEIVES_CONTEXT gets the context it declares, not only the three task hooks.
    */
    return [...args, await this.createContext(plugin)];
  }

  private hasPluginContext(value: unknown): value is PluginContext {
    return Boolean(
      value
        && typeof value === "object"
        && "taskStore" in value
        && "settings" in value
        && "logger" in value
        && "emitEvent" in value,
    );
  }

  async checkPluginSetup(pluginId: string): Promise<PluginSetupCheckResult> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin "${pluginId}" is not loaded`);
    }

    if (!plugin.setup) {
      return { status: "installed" };
    }

    const timeout = plugin.setup.manifest.defaultTimeoutMs ?? 30_000;

    try {
      const ctx = await this.createContext(plugin);
      return await this.withTimeout(
        plugin.setup.hooks.checkSetup(ctx),
        timeout,
        `Setup check for "${pluginId}" timed out after ${timeout}ms`,
      );
    } catch (error) {
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async installPluginSetup(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin "${pluginId}" is not loaded`);
    }

    if (!plugin.setup?.hooks.install) {
      throw new Error(`Plugin "${pluginId}" has no install hook`);
    }

    const timeout = plugin.setup.manifest.defaultTimeoutMs ?? 120_000;
    const ctx = await this.createContext(plugin);

    try {
      await this.withTimeout(
        plugin.setup.hooks.install(ctx),
        timeout,
        `Install command for "${pluginId}" timed out after ${timeout}ms`,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes(`timed out after ${timeout}ms`)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Install hook failed for "${pluginId}": ${message}`);
    }
  }

  async uninstallPluginSetup(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin "${pluginId}" is not loaded`);
    }

    if (!plugin.setup?.hooks.uninstall) {
      return;
    }

    const timeout = plugin.setup.manifest.defaultTimeoutMs ?? 60_000;
    const ctx = await this.createContext(plugin);

    try {
      await this.withTimeout(
        plugin.setup.hooks.uninstall(ctx),
        timeout,
        `Uninstall command for "${pluginId}" timed out after ${timeout}ms`,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes(`timed out after ${timeout}ms`)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Uninstall hook failed for "${pluginId}": ${message}`);
    }
  }

  // ── Accessors ─────────────────────────────────────────────────────

  /**
   * Get all tools from loaded plugins.
   */
  getPluginTools(): PluginToolDefinition[] {
    const tools: PluginToolDefinition[] = [];
    for (const plugin of this.plugins.values()) {
      if (plugin.tools) {
        tools.push(...plugin.tools);
      }
    }
    return tools;
  }

  /**
   * Get all routes from loaded plugins.
   */
  getPluginRoutes(): Array<{ pluginId: string; route: PluginRouteDefinition }> {
    const routes: Array<{ pluginId: string; route: PluginRouteDefinition }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      if (plugin.routes) {
        for (const route of plugin.routes) {
          routes.push({ pluginId, route });
        }
      }
    }
    return routes;
  }

  /**
   * Get all UI slot definitions from loaded plugins.
   */
  getPluginUiSlots(): Array<{ pluginId: string; slot: PluginUiSlotDefinition }> {
    const slots: Array<{ pluginId: string; slot: PluginUiSlotDefinition }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      if (plugin.uiSlots) {
        for (const slot of plugin.uiSlots) {
          slots.push({
            pluginId,
            slot: {
              ...slot,
              surface: slot.surface ?? (typeof slot.slotId === "string" ? slot.slotId as PluginUiSlotDefinition["surface"] : undefined),
            },
          });
        }
      }
    }

    return slots.sort((a, b) => {
      const orderA = a.slot.order ?? Number.MAX_SAFE_INTEGER;
      const orderB = b.slot.order ?? Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      if (a.pluginId !== b.pluginId) return a.pluginId.localeCompare(b.pluginId);
      return String(a.slot.slotId).localeCompare(String(b.slot.slotId));
    });
  }


  /**
   * Get all structured UI contributions from loaded plugins.
   */
  getPluginUiContributions(): Array<{ pluginId: string; contribution: PluginUiContributionDefinition }> {
    const contributions: Array<{ pluginId: string; contribution: PluginUiContributionDefinition }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      if (plugin.uiContributions) {
        for (const contribution of plugin.uiContributions) {
          contributions.push({
            pluginId,
            contribution: normalizePluginUiContributionDefinition(contribution),
          });
        }
      }
    }

    return contributions.sort((a, b) => {
      const orderA = a.contribution.order ?? Number.MAX_SAFE_INTEGER;
      const orderB = b.contribution.order ?? Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      if (a.pluginId !== b.pluginId) return a.pluginId.localeCompare(b.pluginId);
      return a.contribution.contributionId.localeCompare(b.contribution.contributionId);
    });
  }

  private async resolveCurrentManifestPath(pluginEntryPath: string): Promise<string | null> {
    const candidates = new Set<string>();

    try {
      const entryStats = await stat(pluginEntryPath);
      if (entryStats.isDirectory()) {
        candidates.add(join(pluginEntryPath, "manifest.json"));
      }
    } catch {
      // The entry file can be temporarily absent during rebuilds; still try the
      // package-root candidates derived from the persisted loadable path.
    }

    const entryDir = dirname(pluginEntryPath);
    candidates.add(join(entryDir, "manifest.json"));

    if (PLUGIN_MANIFEST_PARENT_DIR_NAMES.has(basename(entryDir))) {
      candidates.add(join(dirname(entryDir), "manifest.json"));
    }

    for (const candidate of candidates) {
      try {
        const candidateStats = await stat(candidate);
        if (candidateStats.isFile()) {
          return candidate;
        }
      } catch {
        // Try the next candidate so unusual installs keep falling back safely.
      }
    }

    return null;
  }

  private async getCurrentManifestDashboardViews(pluginId: string): Promise<CurrentManifestDashboardViewsResult> {
    let installation: PluginInstallation;
    try {
      installation = await this.options.pluginStore.getPlugin(pluginId);
    } catch (err) {
      this.log.warn(`Could not refresh dashboard views for ${pluginId}:`, err);
      return { found: false };
    }

    const pluginPath = this.resolvePluginPath(installation.path);
    const manifestPath = await this.resolveCurrentManifestPath(pluginPath);
    if (!manifestPath) {
      return { found: false };
    }

    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (err) {
      this.log.warn(`Could not read dashboard-view manifest metadata for ${pluginId}:`, err);
      return { found: false };
    }

    const validation = validatePluginManifest(manifest);
    if (!validation.valid) {
      this.log.warn(`Could not refresh dashboard views for ${pluginId}: ${validation.errors.join(", ")}`);
      return { found: false };
    }

    const dashboardViews = (manifest as { dashboardViews?: unknown }).dashboardViews;
    if (dashboardViews === undefined) {
      return { found: true, dashboardViews: [] };
    }

    return { found: true, dashboardViews: dashboardViews as PluginDashboardViewDefinition[] };
  }

  /**
   * Get all top-level dashboard view definitions from loaded plugins.
   *
   * FNXC:Plugins 2026-06-28-12:30:
   * Navigation metadata must come from the current on-disk manifest when present because dashboard component bundles can update immediately after a rebuild while the loaded plugin module instance remains cached. Reading manifest dashboardViews here keeps desktop and mobile nav icon/label/placement in sync with the served in-view bundle for every plugin, without per-plugin pins.
   *
   * FNXC:Plugins 2026-06-28-19:58:
   * A valid manifest that omits dashboardViews is authoritative and means the rebuilt plugin now exposes no top-level views. Do not fall back to stale module dashboardViews after a successful manifest read; fallback is only for missing/unreadable/invalid manifests.
   */
  async getPluginDashboardViews(): Promise<Array<{ pluginId: string; view: PluginDashboardViewDefinition }>> {
    const views: Array<{ pluginId: string; view: PluginDashboardViewDefinition }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      const currentManifestDashboardViews = await this.getCurrentManifestDashboardViews(pluginId);
      const dashboardViews = currentManifestDashboardViews.found
        ? currentManifestDashboardViews.dashboardViews
        : plugin.dashboardViews;
      if (dashboardViews) {
        for (const view of dashboardViews) {
          views.push({ pluginId, view });
        }
      }
    }
    return views;
  }

  /**
   * Get all schema initialization hooks from loaded plugins.
   */
  getPluginSchemaInitHooks(): LoadedPluginSchemaContract[] {
    return [...this.pluginSchemaContracts.values()];
  }

  /**
   * Get all runtime registrations from loaded plugins.
   * Returns plugin ownership metadata along with the runtime registration.
   */
  getPluginRuntimes(): Array<{ pluginId: string; runtime: PluginRuntimeRegistration }> {
    const runtimes: Array<{ pluginId: string; runtime: PluginRuntimeRegistration }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      if (plugin.runtime) {
        runtimes.push({ pluginId, runtime: plugin.runtime });
      }
    }
    return runtimes;
  }

  /**
   * Get all CLI-backed provider contributions from loaded plugins.
   */
  getCliProviderContributions(): Array<{ pluginId: string; contribution: CliProviderContribution }> {
    const contributions: Array<{ pluginId: string; contribution: CliProviderContribution }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      if (!plugin.cliProviders) continue;
      for (const contribution of plugin.cliProviders) {
        contributions.push({ pluginId, contribution });
      }
    }
    return contributions;
  }

  /**
   * Get all skill contributions from loaded plugins.
   *
   * FNXC:PluginSkills 2026-07-12-00:00:
   * Plugin skill body resolution must honor skillFiles relative to the plugin package, so each contribution exposes the absolute pluginRoot alongside the SDK skill data. This is additive for old consumers and lets dashboard/session callers use the shared traversal-guarded resolver instead of guessing from the skill name.
   */
  private getPluginRoot(pluginId: string): string | undefined {
    const entryPath = this.pluginEntryPaths.get(pluginId);
    return entryPath ? resolvePluginRootFromEntryPath(entryPath) : undefined;
  }

  getPluginSkills(): Array<{ pluginId: string; skill: PluginSkillContribution; pluginRoot?: string }> {
    const skills: Array<{ pluginId: string; skill: PluginSkillContribution; pluginRoot?: string }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      if (plugin.skills) {
        for (const skill of plugin.skills) {
          skills.push({ pluginId, skill, pluginRoot: this.getPluginRoot(pluginId) });
        }
      }
    }
    return skills;
  }

  /**
   * Get raw MCP contributions from loaded plugins. Consumers must still apply
   * project_plugin_states before session or UI use.
   *
   * FNXC:PluginMcpServers 2026-07-22-12:00:
   * FN-8491 keeps loader enumeration intentionally raw so one project-scoped
   * provider can enforce enablement consistently for every caller.
   */
  getPluginMcpServers(): Array<{ pluginId: string; server: PluginMcpServerContribution }> {
    const servers: Array<{ pluginId: string; server: PluginMcpServerContribution }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      /*
       * FNXC:PluginMcpServers 2026-07-22-15:35:
       * FN-8491 must isolate malformed runtime plugin contribution containers;
       * only arrays are iterable, while individual malformed servers are
       * filtered by the shared mapper later in MCP resolution.
       */
      if (!Array.isArray(plugin.mcpServers)) continue;
      for (const server of plugin.mcpServers) servers.push({ pluginId, server });
    }
    return servers;
  }

  /**
   * Get all workflow step contributions from loaded plugins.
   */
  getPluginWorkflowSteps(): Array<{ pluginId: string; step: PluginWorkflowStepContribution }> {
    const steps: Array<{ pluginId: string; step: PluginWorkflowStepContribution }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      if (plugin.workflowSteps) {
        for (const step of plugin.workflowSteps) {
          steps.push({ pluginId, step });
        }
      }
    }
    return steps;
  }

  /**
   * Get all workflow extension contributions from loaded plugins.
   */
  getPluginWorkflowExtensions(): Array<{ pluginId: string; extension: WorkflowExtensionContribution }> {
    const extensions: Array<{ pluginId: string; extension: WorkflowExtensionContribution }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      if (plugin.workflowExtensions) {
        for (const extension of plugin.workflowExtensions) {
          extensions.push({ pluginId, extension });
        }
      }
    }
    return extensions;
  }

  /**
   * Get all trait contributions from loaded plugins (U8).
   */
  getPluginTraits(): Array<{ pluginId: string; trait: PluginTraitContribution }> {
    const traits: Array<{ pluginId: string; trait: PluginTraitContribution }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      if (plugin.traits) {
        for (const trait of plugin.traits) {
          traits.push({ pluginId, trait });
        }
      }
    }
    return traits;
  }

  /**
   * Get all workflow step templates derived from loaded plugin contributions.
   */
  getPluginWorkflowStepTemplates(): Array<{ pluginId: string; template: WorkflowStepTemplate }> {
    return this.getPluginWorkflowSteps().map(({ pluginId, step }) => ({
      pluginId,
      template: {
        id: `plugin:${pluginId}:${step.stepId}`,
        name: step.name,
        description: step.description,
        prompt: step.prompt ?? "",
        mode: step.mode,
        phase: step.phase,
        scriptName: step.scriptName,
        toolMode: step.toolMode,
        defaultOn: step.defaultOn,
        modelProvider: step.modelProvider,
        modelId: step.modelId,
        enabled: step.enabled,
        category: "Plugin",
        icon: "puzzle",
      },
    }));
  }

  /**
   * Get all prompt contributions from loaded plugins.
   */
  getPluginPromptContributions(): Array<{
    pluginId: string;
    contribution: PluginPromptContribution;
    config: PluginPromptContributions;
  }> {
    const contributions: Array<{
      pluginId: string;
      contribution: PluginPromptContribution;
      config: PluginPromptContributions;
    }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      if (plugin.promptContributions) {
        for (const contribution of plugin.promptContributions.contributions) {
          contributions.push({ pluginId, contribution, config: plugin.promptContributions });
        }
      }
    }
    return contributions;
  }

  /**
   * Get all setup metadata and hooks from loaded plugins.
   */
  getPluginSetupInfo(): Array<{ pluginId: string; manifest: PluginSetupManifest; hooks: PluginSetupHooks }> {
    const setups: Array<{ pluginId: string; manifest: PluginSetupManifest; hooks: PluginSetupHooks }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      if (plugin.setup) {
        setups.push({ pluginId, manifest: plugin.setup.manifest, hooks: plugin.setup.hooks });
      }
    }
    return setups;
  }

  /**
   * Get all loaded plugin instances.
   */
  getLoadedPlugins(): FusionPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Get a loaded plugin by id.
   */
  getPlugin(pluginId: string): FusionPlugin | undefined {
    return this.plugins.get(pluginId);
  }

  /**
   * Check if a plugin is loaded.
   */
  isPluginLoaded(pluginId: string): boolean {
    return this.plugins.has(pluginId);
  }
}
