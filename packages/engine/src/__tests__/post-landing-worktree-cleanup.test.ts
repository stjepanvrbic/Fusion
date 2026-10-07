import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  existsSyncMock,
  rmdirSyncMock,
  removeWorktreeMock,
  classifyTaskWorktreeMock,
  pruneWorktreeAdminEntriesMock,
  ActiveSessionWorktreeRemovalErrorMock,
  canonicalizeOverride,
} = vi.hoisted(() => {
  class ActiveSessionWorktreeRemovalErrorMock extends Error {
    constructor() {
      super("cannot remove active-session worktree");
      this.name = "ActiveSessionWorktreeRemovalError";
    }
  }
  return {
    existsSyncMock: vi.fn(),
    rmdirSyncMock: vi.fn(),
    removeWorktreeMock: vi.fn(),
    classifyTaskWorktreeMock: vi.fn(),
    pruneWorktreeAdminEntriesMock: vi.fn(),
    ActiveSessionWorktreeRemovalErrorMock,
    // Lets a test give canonicalizePath a distinct result without losing the real implementation elsewhere.
    canonicalizeOverride: { fn: undefined as ((path: string) => string) | undefined },
  };
});

vi.mock("../worktree/worktree-pool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worktree/worktree-pool.js")>();
  return {
    ...actual,
    classifyTaskWorktree: classifyTaskWorktreeMock,
    canonicalizePath: (path: string) => canonicalizeOverride.fn?.(path) ?? actual.canonicalizePath(path),
  };
});
vi.mock("../worktree/worktree-prune.js", () => ({
  pruneWorktreeAdminEntries: pruneWorktreeAdminEntriesMock,
}));

vi.mock("node:fs", () => ({ existsSync: existsSyncMock, rmdirSync: rmdirSyncMock }));
vi.mock("../worktree/worktree-backend.js", () => ({
  ActiveSessionWorktreeRemovalError: ActiveSessionWorktreeRemovalErrorMock,
  RemovalReason: { CompletionLandedCleanup: "completion-landed-cleanup" },
  removeWorktree: removeWorktreeMock,
}));

import { activeSessionRegistry } from "../agents/active-session-registry.js";
import { finalizeProvenAutoMergeTask } from "../merge/auto-merge-finalization.js";
import { cleanupLandedTaskWorktree, cleanupLandedWorkspaceTaskWorktrees } from "../merge/post-landing-worktree-cleanup.js";

function createFinalizationStore(options: { column?: string; worktree?: string | null } = {}) {
  const task: any = {
    id: "FN-251",
    column: options.column ?? "in-review",
    status: null,
    error: null,
    blockedBy: null,
    overlapBlockedBy: null,
    mergeRetries: 0,
    worktree: options.worktree === undefined ? "/repo/.worktrees/fn-251" : options.worktree,
    steps: [],
    /*
    FNXC:PostMergeEvidence 2026-09-29-11:04:
    Finalization now requires the default-on post-merge gate's durable approval. The shared landed
    fixture carries real proof and approval so these tests continue to exercise cleanup and terminal
    move behavior rather than an earlier fail-closed evidence refusal.
    */
    workflowStepResults: [{ workflowStepId: "post-merge-verification", status: "passed", verdict: "APPROVE" }],
    mergeDetails: { mergeConfirmed: true, commitSha: "abc123" },
  };
  const callOrder: string[] = [];
  const updateTask = vi.fn(async (_id: string, patch: Record<string, unknown>) => {
    if (patch.worktree === null) callOrder.push("cleanup");
    Object.assign(task, patch);
    return task;
  });
  const moveTaskIf = vi.fn(async (_id: string, column: string, predicate: (live: typeof task) => Promise<boolean>) => {
    if (await predicate(task)) {
      callOrder.push("move");
      task.column = column;
      return { moved: true, task };
    }
    return { moved: false, task };
  });
  const updateTaskAtomic = vi.fn(async (_id: string, reducer: (current: typeof task) => Record<string, unknown>) => {
    Object.assign(task, reducer(task));
    return task;
  });
  const logEntry = vi.fn().mockResolvedValue(task);
  return {
    task,
    callOrder,
    updateTask,
    updateTaskAtomic,
    moveTaskIf,
    logEntry,
    store: {
      getTask: vi.fn(async () => task),
      getSettings: vi.fn(async () => ({})),
      getTaskWorkflowSelection: vi.fn(() => undefined),
      getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
      getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
      updateTask,
      updateTaskAtomic,
      moveTaskIf,
      logEntry,
      recordRunAuditEvent: vi.fn(),
    },
  };
}

function createStore(options: { withSettings?: boolean } = {}) {
  const updateTask = vi.fn().mockResolvedValue({ id: "FN-251" });
  const logEntry = vi.fn().mockResolvedValue({ id: "FN-251" });
  const getSettings = vi.fn().mockResolvedValue({});
  return {
    store: {
      updateTask,
      logEntry,
      ...(options.withSettings === false ? {} : { getSettings }),
    },
    updateTask,
    logEntry,
    getSettings,
  };
}

/*
FNXC:WorktreeCleanup 2026-10-07-05:29:
KB-003 cleanup classifies the checkout before and after git removal. Module-wide defaults keep the
existing FN-251 cases on a usable registered checkout; partial-removal cases override the probe.
*/
beforeEach(() => {
  classifyTaskWorktreeMock.mockReset();
  classifyTaskWorktreeMock.mockResolvedValue({ ok: true });
  pruneWorktreeAdminEntriesMock.mockReset();
  pruneWorktreeAdminEntriesMock.mockResolvedValue(undefined);
});

describe("cleanupLandedTaskWorktree", () => {
  beforeEach(() => {
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(true);
    rmdirSyncMock.mockReset();
    removeWorktreeMock.mockReset();
    removeWorktreeMock.mockResolvedValue({ removed: true, classification: "removed" });
  });

  describe("truthful outcomes for unusable checkouts (KB-003)", () => {
    const worktreePath = "/repo/.worktrees/fn-251";
    const gitFailure = Object.assign(new Error("Command failed: git worktree remove\nerror: failed to delete '/repo/.worktrees/fn-251': Directory not empty"), { code: 255 });

    function run(store: unknown, extra: Record<string, unknown> = {}) {
      return cleanupLandedTaskWorktree({
        store: store as never,
        taskId: "FN-251",
        worktreePath,
        rootDir: "/repo",
        landedSha: "abc123",
        source: "ai-merge-finalize",
        ...extra,
      });
    }

    function loggedText(logEntry: ReturnType<typeof vi.fn>): string {
      return logEntry.mock.calls.map((call) => call.join(" ")).join("\n");
    }

    it("deletes the residue git left after unregistering during this call and reports removed", async () => {
      const { store, updateTask, logEntry } = createStore();
      classifyTaskWorktreeMock
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: false, classification: "incomplete", reason: "missing .git metadata" });
      removeWorktreeMock.mockRejectedValueOnce(gitFailure);
      const removeResidualDirectory = vi.fn().mockResolvedValue({ removed: true });

      await expect(run(store, { removeResidualDirectory })).resolves.toEqual({ outcome: "removed", removed: true });

      expect(removeResidualDirectory).toHaveBeenCalledWith(worktreePath);
      expect(pruneWorktreeAdminEntriesMock).toHaveBeenCalled();
      expect(updateTask).toHaveBeenCalledWith("FN-251", { worktree: null });
      expect(loggedText(logEntry)).not.toContain("cleanup preserved");
      expect(loggedText(logEntry)).toContain("residual files deleted");
    });

    it("reports partially-removed and clears the pointer when residue cannot be deleted", async () => {
      const { store, updateTask, logEntry } = createStore();
      classifyTaskWorktreeMock
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: false, classification: "unregistered", reason: "not registered in git worktree list" });
      removeWorktreeMock.mockRejectedValueOnce(gitFailure);
      const removeResidualDirectory = vi.fn().mockResolvedValue({ removed: false });

      await expect(run(store, { removeResidualDirectory })).resolves.toEqual({ outcome: "partially-removed", removed: false });

      expect(updateTask).toHaveBeenCalledWith("FN-251", { worktree: null });
      expect(loggedText(logEntry)).toContain("partially removed");
      expect(loggedText(logEntry)).toContain("residual files remain");
      expect(loggedText(logEntry)).not.toContain("cleanup preserved");
    });

    it("never deletes a checkout that was already unusable before cleanup ran", async () => {
      const { store, updateTask, logEntry } = createStore();
      classifyTaskWorktreeMock.mockResolvedValueOnce({ ok: false, classification: "unregistered", reason: "not registered in git worktree list" });
      const removeResidualDirectory = vi.fn().mockResolvedValue({ removed: true });

      await expect(run(store, { removeResidualDirectory })).resolves.toEqual({ outcome: "residual-unusable", removed: false });

      expect(removeWorktreeMock).not.toHaveBeenCalled();
      expect(removeResidualDirectory).not.toHaveBeenCalled();
      expect(updateTask).toHaveBeenCalledWith("FN-251", { worktree: null });
      expect(loggedText(logEntry)).toContain("already unusable (unregistered)");
    });

    it("reports removed when git failed but the checkout is gone", async () => {
      const { store, updateTask } = createStore();
      classifyTaskWorktreeMock
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: false, classification: "missing", reason: "worktree directory does not exist" });
      removeWorktreeMock.mockRejectedValueOnce(gitFailure);

      await expect(run(store)).resolves.toEqual({ outcome: "removed", removed: true });
      expect(updateTask).toHaveBeenCalledWith("FN-251", { worktree: null });
    });

    it("keeps preserved-deliverable when a usable checkout really remains", async () => {
      const { store, updateTask } = createStore();
      removeWorktreeMock.mockRejectedValueOnce(new Error(`preserving ${worktreePath}: uncommitted or ignored content present`));
      const removeResidualDirectory = vi.fn();

      await expect(run(store, { removeResidualDirectory })).resolves.toEqual({
        outcome: "preserved-deliverable",
        removed: false,
        preservedReason: "deliverable",
      });
      expect(removeResidualDirectory).not.toHaveBeenCalled();
      expect(updateTask).not.toHaveBeenCalled();
    });

    it("keeps a generic git failure preserved when the post-probe still finds a usable checkout", async () => {
      const { store, updateTask } = createStore();
      removeWorktreeMock.mockRejectedValueOnce(gitFailure);

      await expect(run(store)).resolves.toEqual(expect.objectContaining({ outcome: "preserved-deliverable", removed: false }));
      expect(classifyTaskWorktreeMock).toHaveBeenCalledTimes(2);
      expect(updateTask).not.toHaveBeenCalled();
    });

    it("fails closed on a repo-root pointer without deleting anything", async () => {
      const { store, updateTask } = createStore();
      classifyTaskWorktreeMock.mockResolvedValueOnce({ ok: false, classification: "repo-root", reason: "worktree path is the project root, not a task worktree" });
      const removeResidualDirectory = vi.fn();

      await expect(run(store, { removeResidualDirectory })).resolves.toEqual({
        outcome: "preserved-unverifiable",
        removed: false,
        preservedReason: "unverifiable",
      });
      expect(removeWorktreeMock).not.toHaveBeenCalled();
      expect(removeResidualDirectory).not.toHaveBeenCalled();
      expect(updateTask).not.toHaveBeenCalled();
    });

    it("emits a bounded partial-removal audit whose sink failures cannot change the outcome", async () => {
      const { store } = createStore();
      classifyTaskWorktreeMock
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: false, classification: "incomplete", reason: "missing .git metadata" });
      removeWorktreeMock.mockRejectedValueOnce(gitFailure);
      const audit = { git: vi.fn().mockRejectedValue(new Error("audit sink down")) };

      await expect(run(store, { audit, removeResidualDirectory: vi.fn().mockResolvedValue({ removed: false }) }))
        .resolves.toEqual({ outcome: "partially-removed", removed: false });
      expect(audit.git).toHaveBeenCalledWith({
        type: "worktree:removal-partial",
        target: worktreePath,
        metadata: { taskId: "FN-251", source: "ai-merge-finalize", classification: "incomplete", phase: "during-removal", residual: true },
      });
    });
  });

  it.each([
    { name: "has no worktree pointer", worktreePath: undefined, rootDir: "/repo" },
    { name: "has no root directory", worktreePath: "/repo/.worktrees/fn-251", rootDir: undefined },
  ])("returns nothing-to-remove when it $name", async ({ worktreePath, rootDir }) => {
    const { store, updateTask } = createStore();

    await expect(cleanupLandedTaskWorktree({
      store: store as never,
      taskId: "FN-251",
      worktreePath,
      rootDir,
      source: "test",
    })).resolves.toEqual({ outcome: "nothing-to-remove", removed: false });

    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("clears a stale worktree pointer when the path is already absent", async () => {
    const { store, updateTask } = createStore();
    existsSyncMock.mockReturnValue(false);

    await expect(cleanupLandedTaskWorktree({
      store: store as never,
      taskId: "FN-251",
      worktreePath: "/repo/.worktrees/fn-251",
      rootDir: "/repo",
      source: "test",
    })).resolves.toEqual({ outcome: "nothing-to-remove", removed: false });

    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(updateTask).toHaveBeenCalledWith("FN-251", { worktree: null });
  });

  it("clears only the worktree pointer after removal", async () => {
    const { store, updateTask, getSettings } = createStore();
    const fence = { assertOwned: vi.fn() };

    await expect(cleanupLandedTaskWorktree({
      store: store as never,
      taskId: "FN-251",
      worktreePath: "/repo/.worktrees/fn-251",
      rootDir: "/repo",
      landedSha: "abc123",
      source: "workflow-graph-merge-finalize",
      fence,
    })).resolves.toEqual({ outcome: "removed", removed: true });

    expect(getSettings).toHaveBeenCalledOnce();
    expect(removeWorktreeMock).toHaveBeenCalledWith(expect.objectContaining({
      rootDir: "/repo",
      worktreePath: "/repo/.worktrees/fn-251",
      taskId: "FN-251",
      reason: "completion-landed-cleanup",
      postLandingProof: { landedSha: "abc123", source: "workflow-graph-merge-finalize" },
    }));
    expect(fence.assertOwned).toHaveBeenCalledWith("finalization");
    expect(updateTask).toHaveBeenCalledWith("FN-251", { worktree: null });
  });

  it("does not report removal until a rejected pointer clear converges", async () => {
    const { store, updateTask, logEntry } = createStore();
    updateTask.mockRejectedValueOnce(new Error("transient task-store failure"));

    await expect(cleanupLandedTaskWorktree({
      store: store as never,
      taskId: "FN-251",
      worktreePath: "/repo/.worktrees/fn-251",
      rootDir: "/repo",
      source: "test",
    })).resolves.toEqual({ outcome: "nothing-to-remove", removed: false });

    expect(logEntry).toHaveBeenCalledWith(
      "FN-251",
      "Post-landing worktree cleanup pointer clear pending",
      expect.stringContaining("/repo/.worktrees/fn-251"),
    );
    expect(removeWorktreeMock).toHaveBeenCalledOnce();

    existsSyncMock.mockReturnValue(false);
    await expect(cleanupLandedTaskWorktree({
      store: store as never,
      taskId: "FN-251",
      worktreePath: "/repo/.worktrees/fn-251",
      rootDir: "/repo",
      source: "self-healing-completion-convergence",
    })).resolves.toEqual({ outcome: "nothing-to-remove", removed: false });

    expect(removeWorktreeMock).toHaveBeenCalledOnce();
    expect(updateTask).toHaveBeenCalledTimes(2);
    expect(updateTask).toHaveBeenLastCalledWith("FN-251", { worktree: null });
  });

  /*
  FNXC:WorktreeCleanup 2026-10-07-13:33:
  KB-005 regression: KB-003's live-session short-circuit returned before removeWorktree, silently dropping the
  `worktree:removal-refused-active-session` audit that pipeline S10 requires. These cases use the real
  registry so the short-circuit (not a mocked removeWorktree refusal) is what is exercised.
  */
  describe("active-session refusal audit (KB-005)", () => {
    const worktreePath = "/repo/.worktrees/fn-251";
    const canonicalPath = "/canonical/repo/.worktrees/fn-251";
    const registration = { taskId: "FN-251", kind: "executor" as const, ownerKey: "kb-005-test" };
    const refusalAudit = {
      type: "worktree:removal-refused-active-session",
      target: worktreePath,
      metadata: { taskId: "FN-251", reason: "completion-landed-cleanup", kind: "executor" },
    };
    const preserved = { outcome: "preserved-active-session", removed: false, preservedReason: "active-session" };

    afterEach(() => {
      activeSessionRegistry.unregisterPath(worktreePath);
      activeSessionRegistry.unregisterPath(canonicalPath);
      canonicalizeOverride.fn = undefined;
    });

    function run(store: unknown, audit?: { git: ReturnType<typeof vi.fn> }) {
      return cleanupLandedTaskWorktree({
        store: store as never,
        taskId: "FN-251",
        worktreePath,
        rootDir: "/repo",
        source: "ai-merge-finalize",
        ...(audit ? { audit: audit as never } : {}),
      });
    }

    function expectPreservedWithoutGitWork(updateTask: ReturnType<typeof vi.fn>, logEntry: ReturnType<typeof vi.fn>) {
      expect(removeWorktreeMock).not.toHaveBeenCalled();
      expect(updateTask).not.toHaveBeenCalled();
      expect(logEntry).toHaveBeenCalledWith(
        "FN-251",
        "Post-landing worktree cleanup preserved",
        expect.stringContaining(`${worktreePath}: active-session`),
      );
    }

    it("audits the refusal when the session is registered under the raw path", async () => {
      const { store, updateTask, logEntry } = createStore();
      const audit = { git: vi.fn().mockResolvedValue(undefined) };
      activeSessionRegistry.registerPath(worktreePath, registration);

      await expect(run(store, audit)).resolves.toEqual(preserved);

      expect(audit.git).toHaveBeenCalledOnce();
      expect(audit.git).toHaveBeenCalledWith(refusalAudit);
      expectPreservedWithoutGitWork(updateTask, logEntry);
    });

    it("audits the refusal when the session is registered only under the canonical path", async () => {
      const { store, updateTask, logEntry } = createStore();
      const audit = { git: vi.fn().mockResolvedValue(undefined) };
      canonicalizeOverride.fn = (path) => (path === worktreePath ? canonicalPath : path);
      activeSessionRegistry.registerPath(canonicalPath, { ...registration, kind: "merger" as never });

      await expect(run(store, audit)).resolves.toEqual(preserved);

      expect(audit.git).toHaveBeenCalledOnce();
      expect(audit.git).toHaveBeenCalledWith({ ...refusalAudit, metadata: { ...refusalAudit.metadata, kind: "merger" } });
      expectPreservedWithoutGitWork(updateTask, logEntry);
    });

    it("keeps the same outcome when the audit sink rejects", async () => {
      const { store, updateTask, logEntry } = createStore();
      const audit = { git: vi.fn().mockRejectedValue(new Error("audit sink down")) };
      activeSessionRegistry.registerPath(worktreePath, registration);

      await expect(run(store, audit)).resolves.toEqual(preserved);

      expect(audit.git).toHaveBeenCalledWith(refusalAudit);
      expectPreservedWithoutGitWork(updateTask, logEntry);
    });

    it("keeps the same outcome when no auditor is supplied", async () => {
      const { store, updateTask, logEntry } = createStore();
      activeSessionRegistry.registerPath(worktreePath, registration);

      await expect(run(store)).resolves.toEqual(preserved);

      expectPreservedWithoutGitWork(updateTask, logEntry);
    });

    it("emits no refusal audit when no session owns the checkout", async () => {
      const { store, updateTask } = createStore();
      const audit = { git: vi.fn().mockResolvedValue(undefined) };

      await expect(run(store, audit)).resolves.toEqual({ outcome: "removed", removed: true });

      expect(removeWorktreeMock).toHaveBeenCalledOnce();
      expect(updateTask).toHaveBeenCalledWith("FN-251", { worktree: null });
      expect(audit.git).not.toHaveBeenCalledWith(expect.objectContaining({ type: "worktree:removal-refused-active-session" }));
    });
  });

  it("keeps an active-session worktree while recording the preservation", async () => {
    const { store, updateTask, logEntry } = createStore();
    removeWorktreeMock.mockRejectedValueOnce(new ActiveSessionWorktreeRemovalErrorMock());

    await expect(cleanupLandedTaskWorktree({
      store: store as never,
      taskId: "FN-251",
      worktreePath: "/repo/.worktrees/fn-251",
      rootDir: "/repo",
      source: "test",
    })).resolves.toEqual({
      outcome: "preserved-active-session",
      removed: false,
      preservedReason: "active-session",
    });

    expect(updateTask).not.toHaveBeenCalled();
    expect(logEntry).toHaveBeenCalledWith(
      "FN-251",
      "Post-landing worktree cleanup preserved",
      expect.stringContaining("/repo/.worktrees/fn-251: active-session"),
    );
  });

  it.each([
    {
      name: "deliverable content",
      error: new Error("preserving /repo/.worktrees/fn-251: uncommitted or ignored content present"),
      outcome: "preserved-deliverable",
      preservedReason: "deliverable",
    },
    {
      name: "an unverifiable checkout",
      error: new Error("preserving /repo/.worktrees/fn-251: status probe failed (broken registration)"),
      outcome: "preserved-unverifiable",
      preservedReason: "unverifiable",
    },
  ])("keeps $name and writes a durable log entry", async ({ error, outcome, preservedReason }) => {
    const { store, updateTask, logEntry } = createStore();
    removeWorktreeMock.mockRejectedValueOnce(error);

    await expect(cleanupLandedTaskWorktree({
      store: store as never,
      taskId: "FN-251",
      worktreePath: "/repo/.worktrees/fn-251",
      rootDir: "/repo",
      source: "test",
    })).resolves.toEqual({ outcome, removed: false, preservedReason });

    expect(updateTask).not.toHaveBeenCalled();
    expect(logEntry).toHaveBeenCalledWith(
      "FN-251",
      "Post-landing worktree cleanup preserved",
      expect.stringContaining(`/repo/.worktrees/fn-251: ${preservedReason}`),
    );
  });

  it.each([
    "workflow-graph-merge-finalize",
    "merge-confirmed-fast-path",
    "self-healing",
    "direct-ai-merge",
  ])("cleans before the complete-column move for %s", async (source) => {
    const { store, task, callOrder, updateTask, moveTaskIf } = createFinalizationStore();
    removeWorktreeMock.mockImplementationOnce(async () => {
      callOrder.push("remove");
      return { removed: true, classification: "removed" };
    });

    const result = await finalizeProvenAutoMergeTask({
      store: store as never,
      taskId: task.id,
      rootDir: "/repo",
      source: source as never,
    });

    expect(result.outcome).toBe("done");
    expect(callOrder).toEqual(expect.arrayContaining(["remove", "cleanup", "move"]));
    expect(callOrder.indexOf("remove")).toBeLessThan(callOrder.indexOf("move"));
    expect(callOrder.indexOf("cleanup")).toBeLessThan(callOrder.indexOf("move"));
    expect(updateTask).toHaveBeenCalledWith(task.id, { worktree: null });
    expect(moveTaskIf).toHaveBeenCalledWith(task.id, "done", expect.any(Function), expect.any(Object));
    expect(task.worktree).toBeNull();
  });

  it.each([
    new Error("preserving /repo/.worktrees/fn-251: uncommitted or ignored content present"),
    new Error("preserving /repo/.worktrees/fn-251: status probe failed (broken registration)"),
  ])("finalizes a durable landing when cleanup preserves content", async (error) => {
    const { store, task, moveTaskIf } = createFinalizationStore();
    removeWorktreeMock.mockRejectedValueOnce(error);

    const result = await finalizeProvenAutoMergeTask({
      store: store as never,
      taskId: task.id,
      rootDir: "/repo",
      source: "workflow-graph-merge-finalize",
    });

    expect(result.outcome).toBe("done");
    expect(moveTaskIf).toHaveBeenCalledWith(task.id, "done", expect.any(Function), expect.any(Object));
    expect(task.worktree).toBe("/repo/.worktrees/fn-251");
  });

  it("skips cleanup without a root directory but still completes", async () => {
    const { store, task, moveTaskIf } = createFinalizationStore();

    const result = await finalizeProvenAutoMergeTask({
      store: store as never,
      taskId: task.id,
      source: "workflow-graph-merge-finalize",
    });

    expect(result.outcome).toBe("done");
    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(moveTaskIf).toHaveBeenCalledWith(task.id, "done", expect.any(Function), expect.any(Object));
  });

  it("does no git work for a workspace-shaped task without a singular worktree", async () => {
    const { store, task, moveTaskIf } = createFinalizationStore({ worktree: null });
    task.workspaceWorktrees = [{ repoRelPath: "packages/a", worktreePath: "/repo/.worktrees/a" }];

    const result = await finalizeProvenAutoMergeTask({
      store: store as never,
      taskId: task.id,
      rootDir: "/repo",
      source: "workflow-graph-merge-finalize",
    });

    expect(result.outcome).toBe("done");
    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(moveTaskIf).toHaveBeenCalledWith(task.id, "done", expect.any(Function), expect.any(Object));
  });

  it("keeps an active-session worktree while still moving the task to complete", async () => {
    const { store, task, moveTaskIf, logEntry } = createFinalizationStore();
    removeWorktreeMock.mockRejectedValueOnce(new ActiveSessionWorktreeRemovalErrorMock());

    const result = await finalizeProvenAutoMergeTask({
      store: store as never,
      taskId: task.id,
      rootDir: "/repo",
      source: "workflow-graph-merge-finalize",
    });

    expect(result.outcome).toBe("done");
    expect(task.worktree).toBe("/repo/.worktrees/fn-251");
    expect(moveTaskIf).toHaveBeenCalledWith(task.id, "done", expect.any(Function), expect.any(Object));
    expect(logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("active-session"));
  });

  it("still completes when clearing a removed worktree pointer fails", async () => {
    const { store, task, updateTask, moveTaskIf, logEntry } = createFinalizationStore();
    const update = updateTask.getMockImplementation()!;
    let rejectPointerClear = true;
    updateTask.mockImplementation(async (id: string, patch: Record<string, unknown>) => {
      if (patch.worktree === null && rejectPointerClear) {
        rejectPointerClear = false;
        throw new Error("transient task-store failure");
      }
      return await update(id, patch);
    });

    const result = await finalizeProvenAutoMergeTask({
      store: store as never,
      taskId: task.id,
      rootDir: "/repo",
      source: "workflow-graph-merge-finalize",
    });

    expect(result.outcome).toBe("done");
    expect(task.worktree).toBe("/repo/.worktrees/fn-251");
    expect(moveTaskIf).toHaveBeenCalledWith(task.id, "done", expect.any(Function), expect.any(Object));
    expect(logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("pointer is pending"));
  });

  it("reclaims an already-complete task through the convergence path", async () => {
    const { store, task, moveTaskIf, updateTask } = createFinalizationStore({ column: "done" });

    const result = await finalizeProvenAutoMergeTask({
      store: store as never,
      taskId: task.id,
      rootDir: "/repo",
      source: "workflow-graph-merge-finalize",
    });

    expect(result.outcome).toBe("already-done");
    expect(updateTask).toHaveBeenCalledWith(task.id, { worktree: null });
    expect(moveTaskIf).not.toHaveBeenCalled();
  });

  it("uses empty settings when a minimal store has no settings reader", async () => {
    const { store, getSettings } = createStore({ withSettings: false });

    await expect(cleanupLandedTaskWorktree({
      store: store as never,
      taskId: "FN-251",
      worktreePath: "/repo/.worktrees/fn-251",
      rootDir: "/repo",
      source: "test",
    })).resolves.toEqual({ outcome: "removed", removed: true });

    expect(getSettings).not.toHaveBeenCalled();
    expect(removeWorktreeMock).toHaveBeenCalledWith(expect.objectContaining({ settings: {} }));
  });
});

describe("cleanupLandedWorkspaceTaskWorktrees", () => {
  beforeEach(() => {
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(true);
    rmdirSyncMock.mockReset();
    removeWorktreeMock.mockReset();
    removeWorktreeMock.mockResolvedValue({ removed: true, classification: "removed" });
  });

  function workspaceTask(workspaceWorktrees: Record<string, { worktreePath: string; branch: string }>) {
    return { id: "FN-268", workspaceWorktrees } as any;
  }

  it("proof-cleans every repository once and retires the empty task directory", async () => {
    const { store } = createStore();
    const task = workspaceTask({
      api: { worktreePath: "/workspace/.fusion/worktrees/fn-268/api", branch: "fusion/fn-268" },
      "apps/web": { worktreePath: "/workspace/.fusion/worktrees/fn-268/apps/web", branch: "fusion/fn-268" },
    });

    await expect(cleanupLandedWorkspaceTaskWorktrees({
      store: store as never,
      task,
      workspaceRootDir: "/workspace",
      landedShas: { api: "api-sha", "apps/web": "web-sha" },
      source: "workspace-finalize",
    })).resolves.toEqual(expect.objectContaining({
      removedRepoRels: ["api", "apps/web"],
      preserved: [],
      taskDirectoryRemoved: true,
      removed: true,
    }));

    expect(removeWorktreeMock).toHaveBeenCalledTimes(2);
    expect(removeWorktreeMock).toHaveBeenCalledWith(expect.objectContaining({
      rootDir: "/workspace/api",
      postLandingProof: { landedSha: "api-sha", source: "workspace-finalize" },
    }));
    expect(removeWorktreeMock).toHaveBeenCalledWith(expect.objectContaining({
      rootDir: "/workspace/apps/web",
      postLandingProof: { landedSha: "web-sha", source: "workspace-finalize" },
    }));
    expect(rmdirSyncMock).toHaveBeenCalledWith("/workspace/.fusion/worktrees/fn-268");
  });

  it("preserves active and deliverable checkout paths without retiring their task directory", async () => {
    const { store, logEntry } = createStore();
    const task = workspaceTask({
      api: { worktreePath: "/workspace/.fusion/worktrees/fn-268/api", branch: "fusion/fn-268" },
      web: { worktreePath: "/workspace/.fusion/worktrees/fn-268/web", branch: "fusion/fn-268" },
    });
    removeWorktreeMock.mockRejectedValueOnce(new Error("preserving /workspace/.fusion/worktrees/fn-268/api: uncommitted content present"));
    removeWorktreeMock.mockRejectedValueOnce(new ActiveSessionWorktreeRemovalErrorMock());

    const result = await cleanupLandedWorkspaceTaskWorktrees({
      store: store as never,
      task,
      workspaceRootDir: "/workspace",
      source: "workspace-finalize",
    });

    expect(result).toEqual(expect.objectContaining({ taskDirectoryRemoved: false, removed: false }));
    expect(result.preserved).toEqual(expect.arrayContaining([
      expect.objectContaining({ repoRel: "api", reason: "deliverable" }),
      expect.objectContaining({ repoRel: "web", reason: "active-session" }),
    ]));
    expect(rmdirSyncMock).not.toHaveBeenCalled();
    expect(logEntry).toHaveBeenCalledWith("FN-268", "Post-landing worktree cleanup preserved", expect.stringContaining("deliverable"));
  });

  it("settles a half-deleted child instead of reporting it preserved, keeping the task directory beside a deliverable one", async () => {
    const { store, logEntry } = createStore();
    const task = workspaceTask({
      api: { worktreePath: "/workspace/.fusion/worktrees/fn-268/api", branch: "fusion/fn-268" },
      web: { worktreePath: "/workspace/.fusion/worktrees/fn-268/web", branch: "fusion/fn-268" },
    });
    classifyTaskWorktreeMock
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, classification: "incomplete", reason: "missing .git metadata" })
      .mockResolvedValueOnce({ ok: true });
    removeWorktreeMock.mockRejectedValueOnce(new Error("error: failed to delete '/workspace/.fusion/worktrees/fn-268/api': Directory not empty"));
    removeWorktreeMock.mockRejectedValueOnce(new Error("preserving /workspace/.fusion/worktrees/fn-268/web: uncommitted content present"));

    const result = await cleanupLandedWorkspaceTaskWorktrees({
      store: store as never,
      task,
      workspaceRootDir: "/workspace",
      source: "workspace-finalize",
      removeResidualDirectory: vi.fn().mockResolvedValue({ removed: false }),
    });

    expect(result.preserved).toEqual([expect.objectContaining({ repoRel: "web", reason: "deliverable" })]);
    expect(result.removedRepoRels).toEqual([]);
    expect(result.taskDirectoryRemoved).toBe(false);
    expect(rmdirSyncMock).not.toHaveBeenCalled();
    expect(logEntry).toHaveBeenCalledWith("FN-268", "Post-landing worktree cleanup partially removed", expect.stringContaining("fn-268/api"));
    expect(logEntry).not.toHaveBeenCalledWith("FN-268", "Post-landing worktree cleanup preserved", expect.stringContaining("fn-268/api"));
  });

  it("settles a lone half-deleted child and attempts the empty-shell task directory removal", async () => {
    const { store } = createStore();
    const task = workspaceTask({ api: { worktreePath: "/workspace/.fusion/worktrees/fn-268/api", branch: "fusion/fn-268" } });
    classifyTaskWorktreeMock
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, classification: "unregistered", reason: "not registered in git worktree list" });
    removeWorktreeMock.mockRejectedValueOnce(new Error("error: failed to delete '/workspace/.fusion/worktrees/fn-268/api'"));
    rmdirSyncMock.mockImplementation(() => { throw Object.assign(new Error("ENOTEMPTY"), { code: "ENOTEMPTY" }); });

    const result = await cleanupLandedWorkspaceTaskWorktrees({
      store: store as never,
      task,
      workspaceRootDir: "/workspace",
      source: "workspace-finalize",
      removeResidualDirectory: vi.fn().mockResolvedValue({ removed: false }),
    });

    expect(result.preserved).toEqual([]);
    expect(result.taskDirectoryRemoved).toBe(false);
    expect(rmdirSyncMock).toHaveBeenCalled();
  });

  it("settles absent paths and removes a duplicate recorded path only once", async () => {
    const { store } = createStore();
    const shared = "/workspace/.fusion/worktrees/fn-268/shared";
    const task = workspaceTask({
      api: { worktreePath: shared, branch: "fusion/fn-268" },
      web: { worktreePath: shared, branch: "fusion/fn-268" },
      absent: { worktreePath: "/workspace/.fusion/worktrees/fn-268/absent", branch: "fusion/fn-268" },
    });
    existsSyncMock.mockImplementation((path: string) => path !== "/workspace/.fusion/worktrees/fn-268/absent");

    const result = await cleanupLandedWorkspaceTaskWorktrees({
      store: store as never,
      task,
      workspaceRootDir: "/workspace",
      source: "workspace-finalize",
    });

    expect(removeWorktreeMock).toHaveBeenCalledTimes(1);
    expect(result.removedRepoRels).toEqual(["api", "web"]);
    expect(result.preserved).toEqual([]);
    expect(result.taskDirectoryRemoved).toBe(true);
  });

  it("does not remove a legacy-layout task directory", async () => {
    const { store } = createStore();
    const task = workspaceTask({
      api: { worktreePath: "/workspace/api/.worktrees/fn-268", branch: "fusion/fn-268" },
    });

    const result = await cleanupLandedWorkspaceTaskWorktrees({
      store: store as never,
      task,
      workspaceRootDir: "/workspace",
      source: "workspace-finalize",
    });

    expect(result).toEqual(expect.objectContaining({ removedRepoRels: ["api"], taskDirectoryRemoved: false, removed: true }));
    expect(rmdirSyncMock).not.toHaveBeenCalled();
  });
});
