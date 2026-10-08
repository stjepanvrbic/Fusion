import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";

import { finalizeProvenAutoMergeTask } from "../merge/auto-merge-finalization.js";
import { ACTIVE_MERGE_STATUSES } from "../merge/merge-active-status.js";
import { finalizeMergeConfirmedWorkflowGraphTask } from "../executor/merge-confirmed-finalize.js";
import { SelfHealingManager } from "../self-healing.js";

/*
FNXC:PostMergeRecovery 2026-10-08-08:14:
A confirmed landing is not an in-flight merge (KB-032, KB-036).

Original symptom: a landed card kept `status: "landing"` after the finalizer deferred for its required post-merge gate.
The stamp counted the card as a live capacity holder, its runnable gate row was never admitted, and every ~16 s the deferral wrote the same two task-log lines again.

Surface enumeration (engine only, no UI):
- Every merge-active status (`merging`, `merging-pr`, `merging-fix`, `reviewing`, `landing`) left on a confirmed card.
- Every non-finalizable gate state: absent (resumable), pending, and failed.
- Every finalizer caller that writes a per-pass deferral line: the merger's own log callback, the workflow-graph merge-confirmed finalizer, and self-healing's merged-review sweep.
- Self-healing's stale-merge sweep, which must clear the same residue in place and keep today's behaviour for unconfirmed stamps.
*/

const STALE = "2026-10-08T07:00:00.000Z";

function landedCard(patch: Partial<Task> = {}): Task {
  return {
    id: "KB-036",
    title: "landed card",
    description: "landed card",
    column: "in-review",
    status: "landing",
    error: null,
    paused: false,
    userPaused: false,
    autoMerge: true,
    dependencies: [],
    steps: [{ name: "Implement", status: "done" }],
    currentStep: 1,
    log: [],
    mergeDetails: { mergeConfirmed: true, commitSha: "74d0bdf8af31", mergeTargetBranch: "main" },
    enabledWorkflowSteps: ["post-merge-verification"],
    workflowStepResults: [],
    createdAt: STALE,
    updatedAt: STALE,
    ...patch,
  } as unknown as Task;
}

function makeStore(task: Task) {
  const store = {
    getTask: vi.fn(async () => task),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(task, patch)),
    updateTaskAtomic: vi.fn(async (_id: string, update: (current: Task) => Partial<Task> | null | Promise<Partial<Task> | null>) => {
      const patch = await update(task);
      return patch ? Object.assign(task, patch) : task;
    }),
    moveTask: vi.fn(async (_id: string, column: string) => Object.assign(task, { column })),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(),
    getSettings: vi.fn(async () => ({})),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: task.enabledWorkflowSteps ?? [] })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: task.enabledWorkflowSteps ?? [] })),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
  } as unknown as TaskStore & { logEntry: ReturnType<typeof vi.fn> };
  store.moveTaskIf = vi.fn(async (_id, column, predicate, options) => {
    if (!await predicate(task)) return { task, moved: false };
    return { task: await store.moveTask(task.id, column, options), moved: true };
  }) as never;
  return store;
}

const GATE_STATES = [
  { label: "absent", results: [] },
  { label: "pending", results: [{ workflowStepId: "post-merge-verification", phase: "post-merge", status: "pending" }] },
  { label: "failed", results: [{ workflowStepId: "post-merge-verification", phase: "post-merge", status: "failed", verdict: "REVISE", completedAt: new Date().toISOString() }] },
] as const;

/** One finalizer pass exactly as the merger runs it: its `log` callback writes the task log. */
function deferViaMerger(store: TaskStore, task: Task) {
  return finalizeProvenAutoMergeTask({
    store,
    taskId: task.id,
    source: "direct-ai-merge",
    log: async (message) => { await store.logEntry(task.id, message); },
  });
}

describe("finalizer deferral on a confirmed landing", () => {
  for (const gate of GATE_STATES) {
    it.each([...ACTIVE_MERGE_STATUSES])(`clears a leftover '%s' stamp in place while the gate is ${gate.label}`, async (status) => {
      const task = landedCard({ id: `KB-036-${status}-${gate.label}`, status, workflowStepResults: structuredClone(gate.results) as never });
      const store = makeStore(task);
      const mergeDetails = structuredClone(task.mergeDetails);
      const evidence = structuredClone(task.workflowStepResults);

      const result = await deferViaMerger(store, task);

      expect(result).toMatchObject({ outcome: "blocked", postMergeEvidenceBlocked: true });
      expect(task.status).toBeNull();
      expect(task.column).toBe("in-review");
      expect(task.error).toBeNull();
      expect(task.mergeDetails).toEqual({
        ...mergeDetails,
        postMergeDeferral: expect.objectContaining({ gateId: "post-merge-verification", commitSha: "74d0bdf8af31" }),
      });
      expect(task.workflowStepResults).toEqual(evidence);
      expect(store.moveTask).not.toHaveBeenCalled();
    });
  }

  it("leaves a status that is not merge activity untouched", async () => {
    const task = landedCard({ id: "KB-036-FAILED", status: "failed", error: "operator park" });
    const store = makeStore(task);

    await deferViaMerger(store, task);

    expect(task.status).toBe("failed");
    expect(task.error).toBe("operator park");
  });

  it("does not write a second task-log line for an unchanged deferral", async () => {
    const task = landedCard({ id: "KB-036-REPEAT" });
    const store = makeStore(task);

    await deferViaMerger(store, task);
    const afterFirst = store.logEntry.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);
    for (let pass = 0; pass < 3; pass += 1) {
      const repeat = await deferViaMerger(store, task);
      expect(repeat).toMatchObject({ outcome: "blocked", repeatedDeferral: true });
    }

    expect(store.logEntry.mock.calls.length).toBe(afterFirst);
  });

  it("reports again once the gate's evidence changes", async () => {
    const task = landedCard({ id: "KB-036-CHANGE" });
    const store = makeStore(task);

    await deferViaMerger(store, task);
    const afterFirst = store.logEntry.mock.calls.length;
    task.workflowStepResults = structuredClone(GATE_STATES[2].results) as never;
    const changed = await deferViaMerger(store, task);

    expect(changed.repeatedDeferral).toBeUndefined();
    expect(store.logEntry.mock.calls.length).toBeGreaterThan(afterFirst);
  });
});

describe("workflow-graph merge-confirmed finalizer", () => {
  it("records an unchanged post-merge deferral once", async () => {
    const task = landedCard({ id: "KB-GRAPH" });
    const store = makeStore(task);
    const deps = { rootDir: "/repo", store, getRunContextFor: () => undefined };

    for (let pass = 0; pass < 4; pass += 1) {
      await expect(finalizeMergeConfirmedWorkflowGraphTask(deps, task.id, "graph-failure")).resolves.toBe(true);
    }

    const lines = store.logEntry.mock.calls.map((call) => String(call[1]));
    expect(lines.filter((line) => line.startsWith("Workflow graph observed confirmed merge"))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith("Workflow graph merge-confirmed finalization blocked"))).toHaveLength(1);
    expect(task.status).toBeNull();
  });
});

describe("self-healing agrees on confirmed-landing residue", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function staleSweepStore(cards: Task[]) {
    const byId = new Map(cards.map((card) => [card.id, card]));
    return {
      byId,
      store: {
        getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false })),
        listTasks: vi.fn(async (options?: { column?: string }) => [...byId.values()].filter((card) => !options?.column || card.column === options.column)),
        getTask: vi.fn(async (id: string) => byId.get(id)),
        updateTaskAtomic: vi.fn(async (id: string, update: (current: Task) => Partial<Task> | null) => {
          const current = byId.get(id)!;
          const patch = update(current);
          return patch ? Object.assign(current, patch) : current;
        }),
        updateTask: vi.fn(async (id: string, patch: Partial<Task>) => Object.assign(byId.get(id)!, patch)),
        logEntry: vi.fn(async () => undefined),
      } as unknown as TaskStore,
    };
  }

  it("clears a stale stamp on a confirmed landing in place and never re-enqueues it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T08:00:00.000Z"));
    const landed = landedCard();
    const { store } = staleSweepStore([landed]);
    const enqueueMerge = vi.fn();
    const manager = new SelfHealingManager(store, {
      rootDir: "/repo",
      staleMergingStatusMinAgeMs: 5 * 60_000,
      getActiveMergeTaskId: () => null,
      enqueueMerge,
    });

    await expect(manager.recoverStaleMergingStatus()).resolves.toBe(1);

    expect(landed.status).toBeNull();
    expect(landed.column).toBe("in-review");
    expect(landed.mergeDetails).toMatchObject({ mergeConfirmed: true, commitSha: "74d0bdf8af31" });
    expect(enqueueMerge).not.toHaveBeenCalled();
    manager.stop();
  });

  it("keeps a confirmed landing's stamp while its merger is the live in-process owner", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T08:00:00.000Z"));
    const landed = landedCard();
    const { store } = staleSweepStore([landed]);
    const manager = new SelfHealingManager(store, {
      rootDir: "/repo",
      staleMergingStatusMinAgeMs: 5 * 60_000,
      getActiveMergeTaskId: () => landed.id,
    });

    await expect(manager.recoverStaleMergingStatus()).resolves.toBe(0);

    expect(landed.status).toBe("landing");
    manager.stop();
  });

  it("keeps today's clear-and-re-enqueue for an unconfirmed stale stamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T08:00:00.000Z"));
    const unconfirmed = landedCard({ id: "KB-UNCONFIRMED", status: "merging", mergeDetails: undefined });
    const { store } = staleSweepStore([unconfirmed]);
    const enqueueMerge = vi.fn();
    const manager = new SelfHealingManager(store, {
      rootDir: "/repo",
      staleMergingStatusMinAgeMs: 5 * 60_000,
      getActiveMergeTaskId: () => null,
      enqueueMerge,
    });

    await expect(manager.recoverStaleMergingStatus()).resolves.toBe(1);

    expect(unconfirmed.status).toBeNull();
    expect(enqueueMerge).toHaveBeenCalledWith("KB-UNCONFIRMED");
    manager.stop();
  });

  it("writes one merged-review deferral line across repeated sweeps", async () => {
    const landed = landedCard({ id: "KB-SWEEP" });
    const store = makeStore(landed);
    Object.assign(store, {
      listTasks: vi.fn(async (options?: { column?: string }) => (!options?.column || options.column === landed.column ? [landed] : [])),
    });
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    Object.assign(manager, {
      resolveSelfHealingMergeTarget: vi.fn(async () => ({ branch: "main", source: "settings" })),
      isCommitReachableFromBranch: vi.fn(async () => true),
      recordSelfHealingBranchGroupMemberLanding: vi.fn(async () => undefined),
    });

    for (let sweep = 0; sweep < 3; sweep += 1) await manager.recoverMergedReviewTasks();

    const lines = store.logEntry.mock.calls.map((call) => String(call[1]));
    expect(lines.filter((line) => line.startsWith("Auto-recovery skipped") || line.startsWith("Auto-recovery resumed"))).toHaveLength(1);
    expect(landed.status).toBeNull();
    manager.stop();
  });
});
