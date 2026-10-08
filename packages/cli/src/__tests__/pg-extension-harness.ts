/**
 * FNXC:PostgresCutover 2026-07-04-00:00:
 * Reusable PostgreSQL fixture + typed mocks for CLI extension (agent-tool) tests.
 *
 * The CLI extension's agent tools resolve their store via `getStore(cwd)`, which
 * the SQLite→PostgreSQL cutover rewired to boot the backend through
 * `createTaskStoreForBackend`. These tests can no longer construct a legacy
 * SQLite `new TaskStore(rootDir)` — that runtime was removed (VAL-REMOVAL-005).
 *
 * This harness reuses core's `createSharedPgTaskStoreTestHarness` (one isolated
 * PG database per describe block, truncated between tests) and injects the
 * resulting store into the extension's per-root cache via
 * `__setCachedStoreForTesting`, so every tool call for the harness rootDir
 * resolves to the SAME PostgreSQL-backed store the test seeds against. No
 * embedded PostgreSQL is started in the test process — the shared external test
 * server (localhost:5432, or FUSION_PG_TEST_URL_BASE) is used, and the whole
 * describe is skipped when PostgreSQL is unreachable (pgDescribe contract).
 *
 * Assert against task state through `store().getTask(id, { includeDeleted: true })`
 * — it returns `deletedAt` and `allowResurrection` for soft-deleted rows in
 * backend mode, so no raw drizzle handle is needed at the CLI layer.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import kbExtension, {
  __clearExtensionStoreBootStateForTesting,
  __setCachedStoreForTesting,
  __setExtensionStoreBootFactoryForTesting,
  closeCachedStores,
} from "../extension.js";
import { SecretsStore, type TaskStore } from "@fusion/core";

export { pgDescribe };

/** One text content part of a fusion tool result. */
export interface ToolResultContent {
  type: "text";
  text: string;
}

/** The shape every fusion agent tool resolves to. */
export interface ToolResult {
  content: ToolResultContent[];
  details?: Record<string, unknown>;
  isError?: boolean;
}

/** Context handed to every registered tool's execute callback. */
export interface ToolExecuteContext {
  cwd: string;
  taskId?: string;
  agentId?: string;
  runId?: string;
}

/** A registered agent tool, as the mock API stores it. */
export interface RegisteredTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ToolExecuteContext,
  ) => Promise<ToolResult>;
}

/** Minimal in-process mock of the pi ExtensionAPI registration surface. */
export interface MockApi {
  readonly tools: Map<string, RegisteredTool>;
  registerTool(tool: RegisteredTool): void;
  registerCommand(): void;
  on(): void;
}

/** Build a mock ExtensionAPI that records registered tools in a Map. */
export function createMockApi(): MockApi {
  const tools = new Map<string, RegisteredTool>();
  return {
    tools,
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerCommand() {
      // no-op for tests
    },
    on() {
      // no-op for tests
    },
  };
}

/**
 * Hand a {@link MockApi} to the extension. The mock only implements the tool-
 * registration surface, so it is cast once at this library boundary (the pi
 * ExtensionAPI type is far broader than the registration calls exercised here).
 */
export function registerExtension(api: MockApi): void {
  kbExtension(api as unknown as ExtensionAPI);
}

export interface PgExtensionHarness {
  /** The project rootDir the PG-backed store is scoped to (also the tool-call cwd). */
  readonly rootDir: () => string;
  /** The shared PostgreSQL-backed TaskStore (seed + assert against this). */
  readonly store: () => TaskStore;
  /** Vitest lifecycle hooks; wire them with beforeAll/beforeEach/afterEach/afterAll. */
  readonly beforeAll: () => Promise<void>;
  readonly beforeEach: () => Promise<void>;
  readonly afterEach: () => Promise<void>;
  readonly afterAll: () => Promise<void>;
}

/** Marker carried by every cold-cache boot the harness refuses; asserted by regression tests. */
export const PG_HARNESS_COLD_BOOT_FORBIDDEN = "PG extension harness: cold-cache TaskStore boot is forbidden";

/*
FNXC:CliTests 2026-10-08-15:30:
KB-081: Full Suite run 37758138036 (Linux, Test shard 3/4) showed a timed-out test body keep running after afterEach's closeCachedStores() emptied the extension cache.
Its next fn_* tool call cold-booted createTaskStoreForBackend, which started embedded PostgreSQL in the worker HOME, and the subprocess guard blamed the NEXT test for a left-running postmaster.
Harness consumers must never cold-boot a backend: every tool call resolves the injected store, so any cold-cache boot (orphaned continuation, foreign cwd, cache gap) rejects immediately with a clearly worded error.
A test that genuinely needs a boot must set its own factory via __setExtensionStoreBootFactoryForTesting; never weaken this guard to make a consumer pass.
*/
const forbidColdCacheBoot: Parameters<typeof __setExtensionStoreBootFactoryForTesting>[0] = async (options) => {
  throw new Error(
    `${PG_HARNESS_COLD_BOOT_FORBIDDEN} for ${options.rootDir} \u2014 it would start embedded PostgreSQL; ` +
      "inject the store for this root or set an explicit boot factory",
  );
};

/**
 * Build a CLI extension test harness backed by an isolated PostgreSQL database.
 * The store is injected into the extension cache so `getStore(rootDir)` returns
 * it for every tool call. `closeCachedStores()` runs in afterEach so injected
 * entries never leak across tests.
 */
export function createPgExtensionHarness(prefix: string): PgExtensionHarness {
  /*
  FNXC:WorkflowAgentRouting 2026-08-07-18:40:
  FN-8764 made AgentStore.init() unconditionally provision the four durable built-in
  workflow-owner agents, and that provisioning requires a bound asyncLayer.projectId
  (backendProjectId rejects the empty/unbound partition to avoid mixing ownership on a
  shared PG cluster). Bind this CLI-extension harness to a real projectId end-to-end so the
  connection GUC `fusion.project_id`, the layer's projectId, and the seeded config row all
  agree: agents (explicit project_id) and their config revisions (GUC-default project_id)
  land in the SAME partition, so the (project_id, agent_id) FK on agent_config_revisions holds.
  A project-agnostic bind (projectId "") would split those writes across partitions and
  reintroduce the FN-8764 provisioning throw.
  */
  const pg = createSharedPgTaskStoreTestHarness({ prefix, projectId: `ext_${prefix}` });
  return {
    rootDir: pg.rootDir,
    store: pg.store,
    beforeAll: async () => {
      __setExtensionStoreBootFactoryForTesting(forbidColdCacheBoot);
      await pg.beforeAll();
    },
    beforeEach: async () => {
      // Drop any stale inflight/cooldown from a previous test (the clear also resets the factory), then re-arm the guard.
      __clearExtensionStoreBootStateForTesting();
      __setExtensionStoreBootFactoryForTesting(forbidColdCacheBoot);
      await pg.beforeEach();
      __setCachedStoreForTesting(pg.rootDir(), pg.store());
    },
    afterEach: async () => {
      await closeCachedStores();
      await pg.afterEach();
    },
    afterAll: async () => {
      try {
        await pg.afterAll();
      } finally {
        __setExtensionStoreBootFactoryForTesting();
      }
    },
  };
}

/**
 * Install an in-memory-key SecretsStore so extension tests exercise real encryption without
 * resolving the developer's global Fusion key directory.
 */
export function injectSecretsStore(harness: PgExtensionHarness): SecretsStore {
  const layer = harness.store().getAsyncLayer();
  if (!layer) throw new Error("harness store has no async layer");
  const noopDb = {
    prepare: () => { throw new Error("sync DB not available in backend-mode test"); },
    bumpLastModified: () => {},
  };
  const secretsStore = new SecretsStore(noopDb as never, noopDb as never, async () => Buffer.alloc(32, 7), { asyncLayer: layer });
  harness.store().secretsStore = secretsStore;
  return secretsStore;
}

/** Look up a registered tool, failing the test loudly if it was never registered. */
export function requireTool(api: MockApi, name: string): RegisteredTool {
  const tool = api.tools.get(name);
  if (!tool) throw new Error(`extension did not register tool "${name}"`);
  return tool;
}
