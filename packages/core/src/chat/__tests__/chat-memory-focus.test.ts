/**
 * FNXC:MemoryFocus 2026-08-13-16:35:
 * RUFU-068 store persistence test for the per-conversation memory FOCUS/TOPIC
 * (chat_sessions.memory_focus). Runs against real PostgreSQL via the
 * satellite-db-injected-stores harness, applying the schema baseline (which
 * includes the newly registered 0065 migration). Asserts a focus set before a
 * "reconnect" (a fresh getSession) is read back, clearing (null) persists, and
 * an empty-string focus is normalized to null (unset → whole-project scope).
 *
 * Skipped when PostgreSQL is unreachable (FUSION_PG_TEST_SKIP=1) so the merge
 * gate stays green without a running server.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createBaselinedPgTestDatabase } from "../../__test-utils__/pg-test-harness.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { ChatStore } from "../chat-store.js";
import type { ChatSession } from "../chat-types.js";

const PG_TEST_URL_BASE =
  process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432";
const PG_AVAILABLE =
  process.env.FUSION_PG_TEST_SKIP !== "1" && Boolean(PG_TEST_URL_BASE);

const pgDescribe = PG_AVAILABLE ? describe : describe.skip;

/*
FNXC:MemoryFocus 2026-08-21-13:35:
RUFU-146 review (PRRT_kwDOSA-8Y86a7RZb): FUSION_PG_TEST_URL_BASE comes from the
environment and must never reach a shell.

FNXC:TestInfraWindows 2026-10-08-08:20:
Admin DDL runs through the shared harness maintenance connection instead of `psql`, which is not on PATH on Windows hosts or Windows CI.
No subprocess means no quoting surface at all.

FNXC:TestInfraWindows 2026-10-08-09:05:
Each test clones the run-shared golden template (the exact applySchemaBaseline end-state) instead of paying a full baseline DDL run per test, which exceeded the 15s test budget under full-lane load on Windows.
The test still calls applySchemaBaseline itself, so the 0065 migration stays asserted through the baseline (a marker-check no-op on the clone).
*/
interface Ctx {
  db: Awaited<ReturnType<typeof createBaselinedPgTestDatabase>>;
  layer: AsyncDataLayer;
  store: ChatStore;
}

async function setupCtx(): Promise<Ctx> {
  const db = await createBaselinedPgTestDatabase("fusion_chat_focus_test");
  const testUrl = db.testUrl;
  const { createConnectionSetFromUrl } = await import("../../postgres/connection.js");
  const { applySchemaBaseline } = await import("../../postgres/schema-applier.js");
  const { resolveBackendWithOptions } = await import("../../postgres/backend-resolver.js");
  const backend = resolveBackendWithOptions({ databaseUrl: testUrl, databaseMigrationUrl: testUrl });
  const connections = await createConnectionSetFromUrl(backend, { poolMax: 3, connectTimeoutSeconds: 5 });
  await applySchemaBaseline(connections.migration);
  const layer = createAsyncDataLayer(connections);
  return { db, layer, store: new ChatStore(layer) };
}

async function teardownCtx(ctx: Ctx | null): Promise<void> {
  if (!ctx) return;
  try { await ctx.layer.close(); } catch { /* best-effort */ }
  try { await ctx.db.drop(); } catch { /* best-effort */ }
}

let sessionCounter = 0;

async function makeSession(ctx: Ctx): Promise<ChatSession> {
  return ctx.store.createSession({
    agentId: "agent-001",
    title: `Focus Session ${++sessionCounter}`,
    projectId: null,
  });
}

pgDescribe("ChatStore memory focus persistence (RUFU-068)", () => {
  let ctx: Ctx | null = null;

  afterEach(async () => {
    await teardownCtx(ctx);
    ctx = null;
  });

  it("persists a set memory focus and reads it back after a reconnect (fresh getSession)", async () => {
    ctx = await setupCtx();
    const session = await makeSession(ctx);
    // Focus is unset by default → whole-project scope.
    expect(session.memoryFocus).toBeNull();

    await ctx.store.setSessionMemoryFocus(session.id, "Stash & LCM memory");

    // "Reconnect": a fresh getSession reads the persisted focus back.
    const reopened = await ctx.store.getSession(session.id);
    expect(reopened?.memoryFocus).toBe("Stash & LCM memory");
    expect(reopened?.id).toBe(session.id);
  });

  it("clearing focus (null) persists as unset → whole-project scope", async () => {
    ctx = await setupCtx();
    const session = await makeSession(ctx);
    await ctx.store.setSessionMemoryFocus(session.id, "GUI improvements");
    await ctx.store.setSessionMemoryFocus(session.id, null);

    const reopened = await ctx.store.getSession(session.id);
    expect(reopened?.memoryFocus).toBeNull();
  });

  it("normalizes an empty-string focus to null (unset)", async () => {
    ctx = await setupCtx();
    const session = await makeSession(ctx);
    await ctx.store.setSessionMemoryFocus(session.id, "   ");

    const reopened = await ctx.store.getSession(session.id);
    expect(reopened?.memoryFocus).toBeNull();
  });

  it("threads memoryFocus through createSession on create", async () => {
    ctx = await setupCtx();
    const session = await ctx.store.createSession({
      agentId: "agent-002",
      title: "Pre-focused",
      projectId: null,
      memoryFocus: "testing",
    });

    const reopened = await ctx.store.getSession(session.id);
    expect(reopened?.memoryFocus).toBe("testing");
  });
});