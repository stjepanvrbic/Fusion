/*
FNXC:ArchiveCleanup 2026-10-07-21:40:
Cold storage is the authoritative terminal snapshot of an archived task, and retention cleanup must never degrade it.
Cleanup rebuilt the snapshot from the soft-deleted row, whose column is already the archive marker, so it overwrote the
recorded pre-archive column and log and a later unarchive restored the card to the complete lane. Cleanup also hard-deleted
soft-deleted tombstones that were never archived, and one failed directory removal aborted the whole sweep.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { findArchivedTaskEntry } from "../../task-store/async/async-archive-lineage.js";

const rmFailures = vi.hoisted(() => new Set<string>());
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: vi.fn(async (path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
      if ([...rmFailures].some((marker) => String(path).endsWith(marker))) {
        throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      }
      return actual.rm(path, options);
    }),
  };
});

pgDescribe("cleanupArchivedTasks keeps the cold snapshot authoritative (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_archived_cleanup_snapshot" });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => {
    await h.beforeEach();
    rmFailures.clear();
  });
  afterEach(h.afterEach);

  it("archive, cleanup, unarchive restores the card to the column it was archived from", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "archived from the queue" });
    await store.archiveTask(task.id, { cleanup: false });
    const archivedEntry = await findArchivedTaskEntry(h.layer().db, task.id, h.layer().projectId);
    expect(archivedEntry?.preArchiveColumn).toBe("todo");

    expect(await store.cleanupArchivedTasks()).toContain(task.id);

    const afterCleanup = await findArchivedTaskEntry(h.layer().db, task.id, h.layer().projectId);
    expect(afterCleanup?.preArchiveColumn).toBe("todo");
    expect(afterCleanup?.log).toEqual(archivedEntry?.log);

    const restored = await store.unarchiveTask(task.id);
    expect(restored.column).toBe("todo");
  });

  it("leaves a soft-deleted tombstone that was never archived", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "deleted, not archived" });
    await store.deleteTask(task.id);

    expect(await store.cleanupArchivedTasks()).not.toContain(task.id);
    expect((await store.getTask(task.id, { includeDeleted: true })).deletedAt).toBeTruthy();
  });

  it("a directory removal failure on one task neither fails the sweep nor skips the others", async () => {
    const store = h.store();
    const stuck = await store.createTask({ description: "directory held open" });
    const clean = await store.createTask({ description: "directory removable" });
    await store.archiveTask(stuck.id, { cleanup: false });
    await store.archiveTask(clean.id, { cleanup: false });
    await mkdir(store.taskDir(stuck.id), { recursive: true });
    rmFailures.add(stuck.id);

    const cleaned = await store.cleanupArchivedTasks();

    expect(cleaned).toEqual(expect.arrayContaining([stuck.id, clean.id]));
    expect(existsSync(store.taskDir(clean.id))).toBe(false);
  });
});
