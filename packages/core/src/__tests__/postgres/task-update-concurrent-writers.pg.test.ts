/**
 * FNXC:TaskRowConcurrency 2026-10-07-21:40:
 * Two TaskStore instances against one database stand in for two processes (dashboard engine and
 * an agent's CLI). Store A is held after it has read and mutated its snapshot but before its row
 * transaction; store B commits a disjoint change in that window. Every generic task-row writer must
 * then write only the columns its own caller changed, so B's committed columns survive A's write.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { TaskStore } from "../../store.js";

type WriterName = "atomicWriteTaskJsonWithAudit" | "atomicWriteTaskJson";

/** Hold the next row write of `store` until `release()` is called. */
function holdNextRowWrite(store: TaskStore): { reached: Promise<void>; release: () => void; restore: () => void } {
  let signalReached!: () => void;
  const reached = new Promise<void>((resolve) => { signalReached = resolve; });
  let releaseWrite!: () => void;
  const released = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const originals = new Map<WriterName, (...args: never[]) => Promise<void>>();
  let held = false;
  for (const name of ["atomicWriteTaskJsonWithAudit", "atomicWriteTaskJson"] as const) {
    const original = (store[name] as (...args: never[]) => Promise<void>).bind(store);
    originals.set(name, original);
    (store as unknown as Record<string, unknown>)[name] = async (...args: never[]) => {
      if (!held) {
        held = true;
        signalReached();
        await released;
      }
      return original(...args);
    };
  }
  return {
    reached,
    release: () => releaseWrite(),
    restore: () => {
      for (const name of originals.keys()) delete (store as unknown as Record<string, unknown>)[name];
    },
  };
}

pgDescribe("task-row writers preserve concurrent writers' columns (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_task_concurrent" });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);

  const secondStore = (): TaskStore => new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() });

  /**
   * Run `writerA` on store A, hold it after its snapshot read, run `writerB` on store B to
   * completion, then let A commit.
   */
  async function interleave(storeA: TaskStore, writerA: () => Promise<unknown>, writerB: () => Promise<unknown>): Promise<void> {
    const hold = holdNextRowWrite(storeA);
    try {
      const pendingA = writerA();
      await hold.reached;
      await writerB();
      hold.release();
      await pendingA;
    } finally {
      hold.release();
      hold.restore();
    }
  }

  describe.each([
    ["updateTask", (store: TaskStore, id: string) => store.updateTask(id, { title: "written by A" })],
    ["updateTaskAtomic", (store: TaskStore, id: string) => store.updateTaskAtomic(id, () => ({ title: "written by A" }))],
    ["updateTask with runContext", (store: TaskStore, id: string) => store.updateTask(id, { title: "written by A" }, { agentId: "agent-a", runId: "run-a" })],
  ] as const)("%s", (_label, writeTitle) => {
    it("keeps a status clear, a pause and a log entry committed by another store", async () => {
      const storeA = h.store();
      const storeB = secondStore();
      const task = await storeA.createTask({ description: "two-writer target" });
      await storeA.updateTask(task.id, { status: "planning" });

      await interleave(
        storeA,
        () => writeTitle(storeA, task.id),
        async () => {
          await storeB.updateTask(task.id, { status: null, pausedReason: "operator hold" });
          await storeB.logEntry(task.id, "entry written by B");
        },
      );

      const fresh = await secondStore().getTask(task.id);
      expect(fresh.title).toBe("written by A");
      expect(fresh.status).toBeUndefined();
      expect(fresh.pausedReason).toBe("operator hold");
      expect(fresh.log.map((entry) => entry.action)).toContain("entry written by B");
    });
  });

  it("logEntry with a runContext keeps another store's column write and appends after its log entry", async () => {
    const storeA = h.store();
    const storeB = secondStore();
    const task = await storeA.createTask({ description: "log merge target" });

    await interleave(
      storeA,
      () => storeA.logEntry(task.id, "entry written by A", undefined, { agentId: "agent-a", runId: "run-a" }),
      async () => {
        await storeB.logEntry(task.id, "entry written by B");
        await storeB.updateTask(task.id, { summary: "summary written by B" });
      },
    );

    const fresh = await secondStore().getTask(task.id);
    const actions = fresh.log.map((entry) => entry.action);
    expect(actions).toContain("entry written by A");
    expect(actions).toContain("entry written by B");
    expect(fresh.summary).toBe("summary written by B");
  });

  it("concurrent fast-path logEntry calls from two stores lose no entries", async () => {
    const storeA = h.store();
    const storeB = secondStore();
    const task = await storeA.createTask({ description: "fast-path log target" });

    await Promise.all(Array.from({ length: 8 }, (_unused, index) => [
      storeA.logEntry(task.id, `A-${index}`),
      storeB.logEntry(task.id, `B-${index}`),
    ]).flat());

    const actions = (await secondStore().getTask(task.id)).log.map((entry) => entry.action);
    for (let index = 0; index < 8; index++) {
      expect(actions).toContain(`A-${index}`);
      expect(actions).toContain(`B-${index}`);
    }
  });

  it("updateTaskAtomic re-runs its updater when another store changed a column it writes", async () => {
    const storeA = h.store();
    const storeB = secondStore();
    const task = await storeA.createTask({ description: "counter target" });
    let updaterRuns = 0;

    await interleave(
      storeA,
      () => storeA.updateTaskAtomic(task.id, (current) => {
        updaterRuns++;
        return { recoveryRetryCount: (current.recoveryRetryCount ?? 0) + 1 };
      }),
      () => storeB.updateTaskAtomic(task.id, (current) => ({ recoveryRetryCount: (current.recoveryRetryCount ?? 0) + 1 })),
    );

    expect((await secondStore().getTask(task.id)).recoveryRetryCount).toBe(2);
    expect(updaterRuns).toBe(2);
  });

  it("pauseTask keeps another store's column write", async () => {
    const storeA = h.store();
    const storeB = secondStore();
    const task = await storeA.createTask({ description: "pause target" });

    await interleave(
      storeA,
      () => storeA.pauseTask(task.id, true),
      () => storeB.updateTask(task.id, { summary: "summary written by B" }),
    );

    const fresh = await secondStore().getTask(task.id);
    expect(fresh.paused).toBe(true);
    expect(fresh.summary).toBe("summary written by B");
  });

  it("addAttachment keeps another store's column write", async () => {
    const storeA = h.store();
    const storeB = secondStore();
    const task = await storeA.createTask({ description: "attachment target" });

    await interleave(
      storeA,
      () => storeA.addAttachment(task.id, "note.txt", Buffer.from("hello"), "text/plain"),
      () => storeB.updateTask(task.id, { summary: "summary written by B" }),
    );

    const fresh = await secondStore().getTask(task.id);
    expect(fresh.attachments?.map((attachment) => attachment.originalName)).toContain("note.txt");
    expect(fresh.summary).toBe("summary written by B");
  });

  it("updateTaskDependencies keeps another store's column write", async () => {
    const storeA = h.store();
    const storeB = secondStore();
    const prerequisite = await storeA.createTask({ description: "prerequisite" });
    const task = await storeA.createTask({ description: "dependency target" });

    await interleave(
      storeA,
      () => storeA.updateTaskDependencies(task.id, { operation: "add", dependency: prerequisite.id }),
      () => storeB.updateTask(task.id, { summary: "summary written by B" }),
    );

    const fresh = await secondStore().getTask(task.id);
    expect(fresh.dependencies).toEqual([prerequisite.id]);
    expect(fresh.summary).toBe("summary written by B");
  });

  it("the writer's returned task reflects the other store's committed columns", async () => {
    const storeA = h.store();
    const storeB = secondStore();
    const task = await storeA.createTask({ description: "returned snapshot target" });
    let returned: Awaited<ReturnType<TaskStore["updateTask"]>> | undefined;

    await interleave(
      storeA,
      async () => { returned = await storeA.updateTask(task.id, { title: "written by A" }); },
      () => storeB.updateTask(task.id, { summary: "summary written by B" }),
    );

    expect(returned?.title).toBe("written by A");
    expect(returned?.summary).toBe("summary written by B");
  });
});
