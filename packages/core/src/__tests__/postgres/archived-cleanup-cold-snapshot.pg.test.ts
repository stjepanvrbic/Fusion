/*
FNXC:ArchiveCleanup 2026-10-07-21:40:
Cold storage is the authoritative terminal snapshot of an archived task, and retention cleanup must never degrade it.
Cleanup rebuilt the snapshot from the soft-deleted row, whose column is already the archive marker, so it overwrote the
recorded pre-archive column and log and a later unarchive restored the card to the complete lane. Cleanup also hard-deleted
soft-deleted tombstones that were never archived, and one failed directory removal aborted the whole sweep.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { findArchivedTaskEntry } from "../../task-store/async/async-archive-lineage.js";
import { readTaskRow } from "../../task-store/async/async-persistence.js";
import { isUnplannedSeedPrompt } from "../../mesh/mesh-task-replication.js";
import type { TaskStore } from "../../store.js";

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

  /*
  FNXC:ArchiveRestore 2026-10-11-16:12:
  An unplanned card restored from the archive must still read as unplanned, so restore writes a seed prompt byte-for-byte.
  Before the fix restore File Scope sanitized every prompt, so a seed whose request quoted `## File Scope` with `origin/main` lost that line and the restored card read as planned.
  Both seed shapes run through both restore paths: in place over the tombstoned row after default archive cleanup, and the row rebuilt from the snapshot after retention cleanup removed it.
  A real plan is still sanitized on restore.
  */
  const quotedScopeRequest = "Tighten the guard.\n\n## File Scope\n- `packages/core/src/example.ts`\n- `origin/main`";
  const promptOf = (store: TaskStore, id: string) => readFile(join(store.taskDir(id), "PROMPT.md"), "utf-8");

  const seedShapes: Array<[string, (store: TaskStore) => Promise<string>]> = [
    ["bootstrap stub", async (store) => (await store.createTask({ title: "Seed example", description: quotedScopeRequest })).id],
    ["refinement seed", async (store) => {
      const source = await store.createTask({ title: "Scoped source", description: "Completed scoped work", column: "done" });
      return (await store.refineTask(source.id, quotedScopeRequest)).id;
    }],
  ];

  const restorePaths: Array<[string, (h: SharedPgTaskStoreHarness, id: string) => Promise<void>]> = [
    ["in place over the tombstoned row", async (h, id) => {
      await h.store().archiveTask(id);
      expect((await readTaskRow(h.layer(), id, { includeDeleted: true }))?.deletedAt).toBeTruthy();
      expect(existsSync(h.store().taskDir(id))).toBe(false);
    }],
    ["from the snapshot after cleanup removed the row", async (h, id) => {
      await h.store().archiveTask(id, { cleanup: false });
      expect(await h.store().cleanupArchivedTasks()).toContain(id);
      expect(await readTaskRow(h.layer(), id, { includeDeleted: true })).toBeUndefined();
      expect(existsSync(h.store().taskDir(id))).toBe(false);
    }],
  ];

  it.each(seedShapes.flatMap(([shape, create]) => restorePaths.map(([path, archive]) => [shape, path, create, archive] as const)))(
    "restores a %s quoting an invalid File Scope token %s verbatim and unplanned",
    async (_shape, _path, create, archive) => {
      const store = h.store();
      const id = await create(store);
      const before = await promptOf(store, id);
      expect(before).toContain("`origin/main`");

      await archive(h, id);
      const restored = await store.unarchiveTask(id);
      const after = await promptOf(store, id);

      expect(after).toBe(before);
      expect(isUnplannedSeedPrompt(after, restored.id, restored.title, restored.description)).toBe(true);
    },
  );

  it.each(restorePaths)("still File Scope sanitizes a real plan restored %s", async (_path, archive) => {
    const store = h.store();
    const task = await store.createTask({ title: "Planned example", description: "planned work" });
    const plan = `# ${task.id}: Planned example\n\n## Mission\n\nDo it.\n\n## File Scope\n\n- \`packages/core/src/example.ts\`\n- \`origin/main\`\n\n## Steps\n\n### Step 1: Go\n`;
    await writeFile(join(store.taskDir(task.id), "PROMPT.md"), plan);

    await archive(h, task.id);
    await store.unarchiveTask(task.id);
    const after = await promptOf(store, task.id);

    expect(after).toBe(plan.replace("- `origin/main`\n", ""));
  });
});
