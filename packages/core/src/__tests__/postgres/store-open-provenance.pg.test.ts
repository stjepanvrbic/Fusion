import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../../postgres/schema/index.js";
import { TaskStore } from "../../store.js";
import { CORE_RUN_AUDIT_EMIT_TIMEOUT_MS } from "../../run-audit/emit-bounded-run-audit.js";
import { createSharedPgTaskStoreTestHarness, pgDescribe } from "../../__test-utils__/pg-test-harness.js";

/*
FNXC:RunAudit 2026-10-07-20:45:
Every TaskStore.init() records one ids/paths-only `store:open` provenance row, and telemetry failure never prevents the store from opening.
*/
pgDescribe("TaskStore.init store-open provenance", () => {
  const h = createSharedPgTaskStoreTestHarness({ prefix: "fusion_store_open" });
  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(h.beforeEach);
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.afterEach();
  });

  // Extra stores share the harness pool; close() would end it for later tests, so they are left open like sibling suites do.
  function newStore(): TaskStore {
    return new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() });
  }

  async function storeOpenRows() {
    return h.adminDb()
      .select()
      .from(schema.project.runAuditEvents)
      .where(eq(schema.project.runAuditEvents.mutationType, "store:open"));
  }

  it("emits exactly one store:open row per init with ids/paths-only provenance", async () => {
    await newStore().init();
    await newStore().init();

    const rows = await storeOpenRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.domain).toBe("database");
      expect(row.target).toBe(h.rootDir());
      expect(row.metadata).toEqual({
        pid: process.pid,
        ppid: process.ppid,
        execPath: process.execPath,
        entry: process.argv[1] ?? null,
        cwd: process.cwd(),
        nodeVersion: process.version,
      });
    }
  });

  it.each([
    ["absent", (store: TaskStore) => { (store as unknown as { recordRunAuditEvent?: unknown }).recordRunAuditEvent = undefined; }],
    ["throwing", (store: TaskStore) => { vi.spyOn(store, "recordRunAuditEvent").mockImplementation(() => { throw new Error("sink threw"); }); }],
    ["rejecting", (store: TaskStore) => { vi.spyOn(store, "recordRunAuditEvent").mockRejectedValue(new Error("sink rejected")); }],
    ["hanging", (store: TaskStore) => {
      vi.spyOn(store, "recordRunAuditEvent").mockImplementation(() => new Promise<never>(() => {}));
      // Fire only the bounded seam's timeout immediately instead of waiting it out.
      const realSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms?: number, ...args: unknown[]) =>
        realSetTimeout(callback, ms === CORE_RUN_AUDIT_EMIT_TIMEOUT_MS ? 0 : ms, ...args)) as never);
    }],
  ] as const)("a %s audit sink cannot prevent the store from opening", async (_kind, sabotage) => {
    const store = newStore();
    sabotage(store);
    await expect(store.init()).resolves.toBeUndefined();
    await expect(store.listTasks()).resolves.toEqual(expect.any(Array));
  });
});
