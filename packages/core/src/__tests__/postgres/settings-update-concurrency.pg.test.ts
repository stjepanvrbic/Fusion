/*
FNXC:SettingsPersistence 2026-10-07-17:59:
Every writer of the per-project config row must serialize its read-modify-write on that row, so a concurrent writer of a different key is never reverted by a stale wholesale settings rewrite.
`settings:updated` must carry the true pre-patch snapshot, including keys a null-as-delete patch clears.
The admin transaction below plays the second process: it holds the config row lock, waits until the store's write is queued behind it, then commits its own key.
*/
import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { nextWorkflowDefinitionIdAsyncImpl } from "../../task-store/workflow-definitions.js";
import type { Settings } from "../../types.js";

pgDescribe("project settings read-modify-write (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_settings_rmw" });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function readStoredSettings(): Promise<Record<string, unknown>> {
    const projectId = h.layer().projectId ?? "__legacy_unscoped__";
    const rows = await h.adminSql()<Array<{ settings: Record<string, unknown> | null }>>`
      SELECT settings FROM project.config WHERE project_id = ${projectId}`;
    return rows[0]?.settings ?? {};
  }

  async function waitForBlockedLockRequest(): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt++) {
      const rows = await h.adminSql()<Array<{ waiting: number }>>`
        SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted`;
      if ((rows[0]?.waiting ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("store write never queued behind the held config row lock");
  }

  /** Run `write` while a concurrent transaction holds the config row and commits `maxWorktrees: 9`. */
  async function raceAgainstConcurrentSettingsWriter(write: () => Promise<unknown>): Promise<void> {
    const projectId = h.layer().projectId ?? "__legacy_unscoped__";
    let pending: Promise<unknown> | undefined;
    await h.adminSql().begin(async (tx) => {
      await tx`SELECT 1 FROM project.config WHERE project_id = ${projectId} FOR UPDATE`;
      pending = write();
      await waitForBlockedLockRequest();
      await tx`UPDATE project.config SET settings = COALESCE(settings, '{}'::jsonb) || '{"maxWorktrees": 9}'::jsonb WHERE project_id = ${projectId}`;
    });
    await pending;
  }

  beforeEach(async () => {
    await h.store().updateSettings({ maxConcurrent: 2 });
  });

  it("keeps a concurrent writer's key when updateSettings commits after it", async () => {
    await raceAgainstConcurrentSettingsWriter(() => h.store().updateSettings({ maxConcurrent: 7 }));

    const stored = await readStoredSettings();
    expect(stored.maxConcurrent).toBe(7);
    expect(stored.maxWorktrees).toBe(9);
  });

  it("keeps a concurrent writer's key when a workflow step allocates its id", async () => {
    await raceAgainstConcurrentSettingsWriter(() => h.store().createWorkflowStep({ name: "Concurrent", description: "step" }));

    const stored = await readStoredSettings();
    expect(stored.maxConcurrent).toBe(2);
    expect(stored.maxWorktrees).toBe(9);
  });

  it("keeps a concurrent writer's key when a workflow definition allocates its id", async () => {
    await raceAgainstConcurrentSettingsWriter(() => nextWorkflowDefinitionIdAsyncImpl(h.store()));

    const stored = await readStoredSettings();
    expect(stored.maxConcurrent).toBe(2);
    expect(stored.maxWorktrees).toBe(9);
  });

  it("publishes the pre-patch value of keys a null patch clears", async () => {
    const store = h.store();
    await store.updateSettings({ maxWorktrees: 11, promptOverrides: { "executor-welcome": "Hello" } } as Partial<Settings>);
    const events: Array<{ settings: Settings; previous: Settings }> = [];
    store.on("settings:updated", (event: { settings: Settings; previous: Settings }) => events.push(event));

    await store.updateSettings({ maxWorktrees: null, promptOverrides: null } as unknown as Partial<Settings>);

    expect(events).toHaveLength(1);
    expect(events[0].previous.maxWorktrees).toBe(11);
    expect(events[0].previous.promptOverrides).toEqual({ "executor-welcome": "Hello" });
    expect(events[0].settings.maxWorktrees).not.toBe(11);
    expect(events[0].settings.promptOverrides).toBeUndefined();
  });
});
