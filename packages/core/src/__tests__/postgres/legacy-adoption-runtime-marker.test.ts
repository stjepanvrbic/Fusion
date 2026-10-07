/*
FNXC:LegacyAdoption 2026-07-22-10:15:
#2387 only reproduced after startup re-bound TaskStore to fusion_runtime. Unit
fakes cannot prove the restricted role's access, so this PG integration test
exercises the same restricted role and proves a clean second store-open sweep
short-circuits instead of recreating CLI warn spam.

FNXC:LegacyAdoption 2026-10-07-21:05:
The drained marker is per project. A clean project's open must never certify another project's census, so two project-bound stores are opened clean-first and the other project must still adopt.
*/
import {expect, it, vi} from "vitest";
import {and, eq, sql} from "drizzle-orm";
import {TaskStore} from "../../store.js";
import {createConnectionSetFromUrl} from "../../postgres/connection.js";
import {createAsyncDataLayer} from "../../postgres/data-layer.js";
import * as schema from "../../postgres/schema/index.js";
import {LEGACY_ADOPTION_DRAINED_META_KEY} from "../../task-store/lifecycle-ops.js";
import {createTaskStoreForTest, pgDescribe} from "../../__test-utils__/pg-test-harness.js";

type Harness = Awaited<ReturnType<typeof createTaskStoreForTest>>;

function runtimeLayerFactory(harness: Harness) {
  return async (projectId: string) => {
    const connections = await createConnectionSetFromUrl(
      {
        mode: "external",
        runtimeUrl: harness.testUrl,
        migrationUrl: harness.testUrl,
        migrationUrlOverridden: false,
      },
      {poolMax: 1, connectTimeoutSeconds: 5, projectId, useRuntimeRole: true},
    );
    return createAsyncDataLayer(connections, {projectId});
  };
}

async function drainedMarker(harness: Harness, projectId: string): Promise<string | null> {
  const rows = await harness.adminDb
    .select({value: schema.project.projectMeta.value})
    .from(schema.project.projectMeta)
    .where(and(
      eq(schema.project.projectMeta.projectId, projectId),
      eq(schema.project.projectMeta.key, LEGACY_ADOPTION_DRAINED_META_KEY),
    ));
  return rows[0]?.value ?? null;
}

async function seedTask(
  harness: Harness,
  projectId: string,
  id: string,
  fields: {status?: string; userPaused?: boolean},
): Promise<void> {
  const now = new Date().toISOString();
  await harness.adminDb.insert(schema.project.tasks).values({
    projectId,
    id,
    description: `${id} legacy fixture`,
    column: "todo",
    currentStep: 0,
    createdAt: now,
    updatedAt: now,
    status: fields.status ?? null,
    userPaused: fields.userPaused ? 1 : 0,
  } as never);
}

async function taskRow(harness: Harness, projectId: string, id: string) {
  const rows = await harness.adminDb
    .select({status: schema.project.tasks.status, legacyAdoptedAt: schema.project.tasks.legacyAdoptedAt})
    .from(schema.project.tasks)
    .where(and(eq(schema.project.tasks.projectId, projectId), eq(schema.project.tasks.id, id)));
  return rows[0];
}

pgDescribe("legacy-adoption drained marker: fusion_runtime integration (#2387)", () => {
  it("reads and writes the project marker under fusion_runtime, then short-circuits a second clean sweep", async () => {
    const harness = await createTaskStoreForTest({prefix: "legacy_adoption_runtime_marker", copyFromGolden: true});
    const createRuntimeLayer = runtimeLayerFactory(harness);
    let firstStore: TaskStore | undefined;
    let secondStore: TaskStore | undefined;
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect((await createRuntimeLayer("legacy-marker-test")).db.execute(sql`SELECT current_user`))
        .resolves.toEqual([{current_user: "fusion_runtime"}]);
      expect(await drainedMarker(harness, "legacy-marker-test")).toBeNull();

      // Two independently runtime-bound stores model two CLI opens: the first scans and
      // writes the marker; the second must read it before listTasks can start a census.
      firstStore = new TaskStore(harness.rootDir, undefined, {asyncLayer: await createRuntimeLayer("legacy-marker-test")});
      const firstListTasks = vi.spyOn(firstStore, "listTasks");
      await firstStore.init();
      expect(firstListTasks).toHaveBeenCalled();
      expect(await drainedMarker(harness, "legacy-marker-test")).toEqual(expect.any(String));
      await firstStore.close();
      firstStore = undefined;

      secondStore = new TaskStore(harness.rootDir, undefined, {asyncLayer: await createRuntimeLayer("legacy-marker-test")});
      const secondListTasks = vi.spyOn(secondStore, "listTasks");
      await secondStore.init();
      expect(secondListTasks).not.toHaveBeenCalled();
      expect([...stderr.mock.calls, ...warnings.mock.calls].filter(([message]) =>
        String(message).includes("Legacy-adoption drained-marker"),
      )).toEqual([]);
    } finally {
      stderr.mockRestore();
      warnings.mockRestore();
      if (firstStore) await firstStore.close();
      if (secondStore) await secondStore.close();
      await harness.teardown();
    }
  });

  it("a clean project's marker never suppresses adoption in another project", async () => {
    const harness = await createTaskStoreForTest({prefix: "legacy_adoption_two_projects", copyFromGolden: true});
    const createRuntimeLayer = runtimeLayerFactory(harness);
    const stores: TaskStore[] = [];
    const open = async (projectId: string) => {
      const store = new TaskStore(harness.rootDir, undefined, {asyncLayer: await createRuntimeLayer(projectId)});
      stores.push(store);
      await store.init();
      return store;
    };
    try {
      await seedTask(harness, "project-clean", "FN-1", {status: "queued"});
      await seedTask(harness, "project-legacy", "FN-1", {status: "plan-review-unavailable"});
      await seedTask(harness, "project-legacy", "FN-2", {status: "plan-review-unavailable", userPaused: true});
      await seedTask(harness, "project-legacy", "FN-3", {status: "queued"});

      // The clean project opens first: only live statuses, so it records ITS marker.
      await open("project-clean");
      expect(await drainedMarker(harness, "project-clean")).toEqual(expect.any(String));
      expect(await drainedMarker(harness, "project-legacy")).toBeNull();

      // The other project still adopts its legacy row on open.
      await open("project-legacy");
      expect(await taskRow(harness, "project-legacy", "FN-1")).toMatchObject({status: null, legacyAdoptedAt: expect.any(String)});
      // The operator-paused candidate is untouched, and the live status is preserved.
      expect(await taskRow(harness, "project-legacy", "FN-2")).toMatchObject({status: "plan-review-unavailable", legacyAdoptedAt: null});
      expect(await taskRow(harness, "project-legacy", "FN-3")).toMatchObject({status: "queued", legacyAdoptedAt: null});
      // A paused candidate keeps that project's census un-drained so it stays adoptable after unpause.
      expect(await drainedMarker(harness, "project-legacy")).toBeNull();
      expect(await taskRow(harness, "project-clean", "FN-1")).toMatchObject({status: "queued", legacyAdoptedAt: null});
    } finally {
      for (const store of stores) await store.close();
      await harness.teardown();
    }
  });
});
