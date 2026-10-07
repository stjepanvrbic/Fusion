/**
 * FNXC:ArchiveCleanup 2026-10-07-18:55:
 * Branch and task-directory cleanup run after the archive transaction committed. A held file on Windows (agent-log tail, editor, AV scan) or a git failure must never surface a committed archive as failed: the archive call resolves, the snapshot and tombstone stay, and residue is left for reconciliation.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const rmFaults = vi.hoisted(() => ({ blockedDirs: new Set<string>(), calls: [] as Array<{ path: string; options: unknown }> }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: (async (path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
      const target = resolve(String(path));
      rmFaults.calls.push({ path: target, options });
      if (rmFaults.blockedDirs.has(target)) {
        throw Object.assign(new Error(`EBUSY: resource busy or locked, rm '${target}'`), { code: "EBUSY" });
      }
      return actual.rm(path, options);
    }) as typeof actual.rm,
  };
});

import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { findArchivedTaskEntry } from "../../task-store/async/async-archive-lineage.js";

pgDescribe("archive post-commit cleanup (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_archive_cleanup" });

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    rmFaults.blockedDirs.clear();
    rmFaults.calls.length = 0;
    await h.beforeEach();
  });
  afterEach(async () => {
    rmFaults.blockedDirs.clear();
    vi.restoreAllMocks();
    await h.afterEach();
  });
  afterAll(h.afterAll);

  it("resolves a committed archive when the task directory stays locked, retrying the removal first", async () => {
    const store = h.store();
    const task = await store.createTaskWithReservedId(
      { description: "locked task directory", column: "done" },
      { taskId: "FN-501", applyDefaultWorkflowSteps: false },
    );
    const dir = resolve(store.taskDir(task.id));
    rmFaults.blockedDirs.add(dir);

    const archived = await store.archiveTask(task.id, { cleanup: true });

    expect(archived.id).toBe(task.id);
    expect(await findArchivedTaskEntry(h.layer().db, task.id, h.layer().projectId)).toBeDefined();
    expect(existsSync(dir)).toBe(true);
    const removal = rmFaults.calls.find((call) => call.path === dir);
    expect(removal?.options).toMatchObject({ recursive: true, force: true });
    expect((removal?.options as { maxRetries?: number }).maxRetries).toBeGreaterThan(0);
  });

  it("resolves a committed archive when branch cleanup fails and still removes the task directory", async () => {
    const store = h.store();
    const task = await store.createTaskWithReservedId(
      { description: "branch cleanup fails", column: "done" },
      { taskId: "FN-502", applyDefaultWorkflowSteps: false },
    );
    vi.spyOn(store, "cleanupBranchForTask").mockRejectedValue(new Error("git branch -D failed"));

    await expect(store.archiveTask(task.id, { cleanup: true })).resolves.toMatchObject({ id: task.id });

    expect(await findArchivedTaskEntry(h.layer().db, task.id, h.layer().projectId)).toBeDefined();
    expect(existsSync(store.taskDir(task.id))).toBe(false);
  });
});
