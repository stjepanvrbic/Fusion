import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskDetail, TaskStore } from "@fusion/core";
import { holdForSessionContention } from "../executor/session-contention-hold.js";
import { createAuthoritativeWorkflowSeams } from "../executor/create-authoritative-workflow-seams.js";
import { FOREACH_ACTIVE_CONTEXT_KEY } from "../workflows/workflow-node-handlers.js";
import { SESSION_CONTENTION_HOLD_VALUE } from "../workflows/workflow-graph-executor.js";
import { createRecoveryFakeStore } from "./_recovery-fake-store.js";

describe("workspace acquisition contention hold", () => {
  afterEach(() => vi.useRealTimers());

  it("maps a foreach step-session acquisition refusal to the scheduling-hold graph value", async () => {
    const live = { id: "FN-179-foreach", worktree: "/tmp/fn-179", steps: [] } as unknown as TaskDetail;
    const seams = createAuthoritativeWorkflowSeams({
      store: { getTask: vi.fn(async () => live) },
      graphStepActiveContext: new Map(),
      runProjectedGraphTaskStep: vi.fn(async () => ({
        outcome: "failure",
        error: "workspace sub-repo Merge acquisition is in progress for task MRG-050",
      })),
    } as never, {} as never);

    const result = await seams.stepExecute?.(live, {
      [FOREACH_ACTIVE_CONTEXT_KEY]: { foreachNodeId: "steps", stepIndex: 0, instanceId: "steps#0:step-execute" },
    });

    expect(result).toMatchObject({ outcome: "failure", value: SESSION_CONTENTION_HOLD_VALUE });
  });

  it("retains the durable attempt count across scheduled re-execution", async () => {
    vi.useFakeTimers();
    let task = {
      id: "FN-179-wait",
      column: "in-progress",
      status: "in-progress",
      sessionContentionHoldCount: 0,
    } as unknown as TaskDetail;
    const reexecute = vi.fn(async () => undefined);
    const store = {
      getTask: async () => task,
      updateTask: async (_id: string, patch: Partial<Task>) => {
        task = { ...task, ...patch };
      },
      updateTaskAtomic: async (_id: string, updater: (current: TaskDetail) => Partial<Task> | null) => {
        const patch = updater(task);
        if (patch) task = { ...task, ...patch };
        return task;
      },
      logEntry: async () => undefined,
    } as unknown as TaskStore;
    const result = { context: { "node:execute:error": "workspace sub-repo Merge acquisition is in progress for task MRG-050" } } as never;

    await holdForSessionContention({ store, getRunContextFor: () => undefined, reexecute }, task, task, result);
    expect(task).toMatchObject({ status: "contention-hold", sessionContentionHoldCount: 1 });

    await vi.runAllTimersAsync();
    expect(task).toMatchObject({ status: null, sessionContentionHoldCount: 1, sessionContentionWaitReason: null });
    expect(reexecute).toHaveBeenCalledOnce();

    await holdForSessionContention({ store, getRunContextFor: () => undefined, reexecute }, task, task, result);
    expect(task).toMatchObject({ status: "contention-hold", sessionContentionHoldCount: 2 });
  });

  it("parks an exhausted contention episode visibly and keeps its durable budget", async () => {
    /*
    FNXC:RecoveryOwnership 2026-10-07-18:04:
    Clearing the wait on exhaustion used to leave a WIP card with no session, no scheduled resume
    and no visible state. Exhaustion is now a failed park naming the holder, and the counter stays.
    */
    const fake = createRecoveryFakeStore({
      id: "FN-179-exhausted",
      status: "contention-hold",
      sessionContentionHoldCount: 10,
      sessionContentionWaitReason: "workspace sub-repo Merge acquisition is in progress for task MRG-050",
    });
    const result = { context: { "node:execute:error": "workspace sub-repo Merge acquisition is in progress for task MRG-050" } } as never;
    const reexecute = vi.fn(async () => undefined);

    await holdForSessionContention({ store: fake.store, getRunContextFor: () => undefined, reexecute }, fake.task, fake.task as TaskDetail, result);

    expect(fake.task).toMatchObject({ status: "failed", sessionContentionHoldCount: 10 });
    expect(fake.task.error).toContain("MRG-050");
    expect(reexecute).not.toHaveBeenCalled();
    expect(fake.audits.map((row) => row.metadata?.owner)).toEqual(["graph-session-contention"]);
  });

  describe("a delayed retry only owns the episode it was armed for", () => {
    const contentionError = { context: { "node:execute:error": "workspace sub-repo Merge acquisition is in progress for task MRG-050" } } as never;

    async function armHold() {
      vi.useFakeTimers();
      const fake = createRecoveryFakeStore({ id: "FN-C006", column: "in-progress", status: "in-progress", sessionContentionHoldCount: 0 });
      const reexecute = vi.fn(async () => undefined);
      await holdForSessionContention({ store: fake.store, getRunContextFor: () => undefined, reexecute }, fake.task, fake.task as TaskDetail, contentionError);
      expect(fake.task.status).toBe("contention-hold");
      return { fake, reexecute };
    }

    it.each([
      ["a newer failure", { status: "failed", error: "newer failure" }],
      ["an approval hold", { status: "awaiting-approval" }],
      ["completion", { column: "done", status: undefined }],
      ["a manual review transition", { column: "in-review", status: undefined }],
      ["a newer contention episode", { sessionContentionHoldCount: 2 }],
      ["a column move", { columnMovedAt: "2026-10-07T12:00:00.000Z" }],
      ["deletion", { deletedAt: "2026-10-07T12:00:00.000Z" }],
    ])("writes nothing and does not execute after %s", async (_label, patch) => {
      const { fake, reexecute } = await armHold();
      fake.task = { ...fake.task, ...(patch as Partial<Task>) };
      const before = { ...fake.task };
      await vi.runAllTimersAsync();
      expect(reexecute).not.toHaveBeenCalled();
      expect(fake.task).toEqual(before);
    });

    it("releases a paused same-episode hold without executing", async () => {
      const { fake, reexecute } = await armHold();
      fake.task = { ...fake.task, userPaused: true };
      await vi.runAllTimersAsync();
      expect(reexecute).not.toHaveBeenCalled();
      expect(fake.task.status).toBeUndefined();
      expect(fake.task.sessionContentionHoldCount).toBe(1);
    });

    it("retries exactly once for the unchanged episode", async () => {
      const { fake, reexecute } = await armHold();
      await vi.runAllTimersAsync();
      expect(reexecute).toHaveBeenCalledOnce();
      expect(fake.task.status).toBeUndefined();
    });
  });
});
