import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";

const execMock = vi.fn();

vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFn: any = (cmd: string, opts: any, cb: any) => {
    const callback = typeof opts === "function" ? opts : cb;
    execMock(cmd, opts)
      .then((stdout: string) => callback?.(null, stdout, ""))
      .catch((err: Error) => callback?.(err, "", err.message));
  };
  execFn[promisify.custom] = (cmd: string, opts?: any) =>
    execMock(cmd, opts).then((stdout: string) => ({ stdout, stderr: "" }));
  const execFileFn: any = (file: string, args: readonly string[], opts: any, cb: any) => {
    execMock([file, ...args].join(" "), opts)
      .then((stdout: string) => cb?.(null, stdout, ""))
      .catch((err: Error) => cb?.(err, "", err.message));
  };
  execFileFn[promisify.custom] = (file: string, args: readonly string[], opts?: any) =>
    execMock([file, ...args].join(" "), opts).then((stdout: string) => ({ stdout, stderr: "" }));
  return { exec: execFn, execSync: vi.fn(), execFile: execFileFn };
});

import { SelfHealingManager } from "../self-healing.js";
import * as branchConflicts from "../execution/branch-conflicts.js";
import * as worktreePool from "../worktree/worktree-pool.js";
import { withBranchWriteProvenance } from "./branch-write-provenance-store-stub.js";

/*
FNXC:WorkflowRecovery 2026-10-15-19:30:
Regression contract for KB-168: an already-merged rejection whose task, candidate, owner, branch, base and reason are unchanged is recorded once (one task log line, one run-audit row), not on every 5-minute self-healing pass.
The refusal itself stays; a change in any identity field records again, and the decision comes from the task's persisted log so a restarted manager reaches the same answer.
Covers the four helper callers: already-merged recovery, branch-misbound recovery, and the reclaim sweep's tip-already-merged arm (foreign-tip rejection and ownership-lookup failure).
*/

const REJECTED = "task:auto-recover-already-merged-rejected";
const SHA_A = "15621df56801aaaabbbbccccddddeeeeffff0000";
const SHA_B = "9f00d1ce0bad1111222233334444555566667777";
const FIVE_MINUTES = 5 * 60 * 1000;

type Reason = "foreign-task-tip" | "foreign-lineage-tip" | "foreign-landed-commit" | "ownership-unverifiable";

interface FakeStore extends EventEmitter {
  tasks: Map<string, any>;
  audits: any[];
  logCap: number;
}

/**
 * Stateful fake: `getTask` returns the full persisted log, `listTasks` returns slim rows with `log: []` like the real
 * slim read, and `logEntry` appends and splices the oldest entries above the cap like the core activity log.
 */
function createStore(seed: any[]): FakeStore & TaskStore {
  const emitter = new EventEmitter() as FakeStore & TaskStore;
  const store = emitter as any;
  store.tasks = new Map(seed.map((task) => [task.id, { ...task, log: [...(task.log ?? [])] }]));
  store.audits = [];
  store.logCap = 1000;
  store.getSettings = vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false });
  store.listTasks = vi.fn(async (filter?: { column?: string }) =>
    [...store.tasks.values()]
      .filter((task: any) => !filter?.column || task.column === filter.column)
      .map((task: any) => ({ ...task, log: [] })));
  store.getTask = vi.fn(async (id: string) => {
    const task = store.tasks.get(id);
    if (!task) throw new Error(`Task ${id} not found`);
    return { ...task, log: [...task.log] };
  });
  store.logEntry = vi.fn(async (id: string, action: string) => {
    const task = store.tasks.get(id);
    task.log.push({ timestamp: new Date().toISOString(), action });
    if (task.log.length > store.logCap) task.log.splice(0, task.log.length - store.logCap);
  });
  store.recordRunAuditEvent = vi.fn(async (event: any) => {
    store.audits.push(event);
  });
  store.updateTask = vi.fn(withBranchWriteProvenance(async () => undefined));
  store.updateTaskAtomic = vi.fn(async (taskId: string, mutate: (task: Record<string, unknown>) => any) => {
    const task = await store.getTask(taskId);
    const patch = await mutate(task);
    if (patch) await store.updateTask(taskId, patch);
    return patch ? { ...task, ...patch } : task;
  });
  store.moveTask = vi.fn().mockResolvedValue(undefined);
  store.handoffToReview = vi.fn(async (taskId: string) => ({ id: taskId, column: "in-review", updatedAt: new Date().toISOString() }));
  store.recordAgentActivity = vi.fn().mockResolvedValue(undefined);
  return emitter;
}

function reviewTask(id = "KB-168", overrides: Record<string, unknown> = {}) {
  return {
    id,
    column: "in-review",
    status: "failed",
    paused: false,
    mergeRetries: 99,
    mergeDetails: undefined,
    branch: `fusion/${id.toLowerCase()}`,
    log: [],
    ...overrides,
  };
}

function holdTask(id = "KB-500") {
  return { id, column: "todo", checkedOutBy: null, branch: `fusion/${id.toLowerCase()}`, worktree: `/tmp/${id.toLowerCase()}`, baseCommitSha: SHA_A, log: [] };
}

describe("already-merged rejection is recorded once per identity", () => {
  let store: FakeStore & TaskStore;
  let managers: SelfHealingManager[];
  let baseBranch: string;
  let foreignTip: { sha: string; owner?: string; reason: Reason } | null;

  function newManager(): SelfHealingManager {
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/kb-176" });
    managers.push(manager);
    vi.spyOn(manager as any, "resolveSelfHealingMergeTarget").mockImplementation(async () => ({ branch: baseBranch }));
    vi.spyOn(manager as any, "branchTipForeignOwnership").mockImplementation(async () => foreignTip);
    vi.spyOn(manager as any, "isBranchTipMisboundToTask").mockImplementation(async () => ({
      misbound: false,
      branchMissing: false,
      branchTip: foreignTip?.sha ?? SHA_A,
      landed: null,
      rejection: foreignTip ? { reason: foreignTip.reason, owner: foreignTip.owner } : undefined,
    }));
    vi.spyOn(manager as any, "readCommitTaskOwnership").mockResolvedValue({ rejectionReason: "foreign-task" });
    vi.spyOn(manager as any, "foreignTipRejection").mockImplementation(async () =>
      foreignTip ? { reason: foreignTip.reason, owner: foreignTip.owner } : null);
    return manager;
  }

  function rejectionLines(taskId: string): string[] {
    return store.tasks.get(taskId).log
      .map((entry: any) => entry.action as string)
      .filter((action: string) => action.startsWith(`[recovery] already-merged rejected ${taskId} `));
  }

  function rejectionRows(taskId: string): any[] {
    return store.audits.filter((event) => event.mutationType === REJECTED && event.taskId === taskId);
  }

  function advancePass(): void {
    vi.setSystemTime(Date.now() + FIVE_MINUTES);
  }

  async function passes(count: number, run: () => Promise<unknown>): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await run();
      advancePass();
    }
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T12:10:00.000Z"));
    managers = [];
    baseBranch = "fusion/kb-167";
    foreignTip = { sha: SHA_A, owner: "KB-159", reason: "foreign-task-tip" };
    execMock.mockReset();
    execMock.mockResolvedValue("");
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValue(true);
    vi.spyOn(worktreePool, "classifyTaskWorktree").mockResolvedValue({ ok: true } as any);
  });

  afterEach(() => {
    for (const manager of managers) manager.stop();
    vi.useRealTimers();
  });

  describe("symptom (KB-168)", () => {
    it("records an unchanged foreign-tip rejection once across passes, and a new candidate once more", async () => {
      store = createStore([reviewTask()]);
      const manager = newManager();

      await passes(3, () => manager.recoverAlreadyMergedReviewTasks());

      expect(rejectionLines("KB-168")).toEqual([
        "[recovery] already-merged rejected KB-168 candidate=15621df56801 owner=KB-159 branch=fusion/kb-168 base=fusion/kb-167 reason=foreign-task-tip",
      ]);
      expect(rejectionRows("KB-168")).toHaveLength(1);

      foreignTip = { sha: SHA_B, owner: "KB-159", reason: "foreign-task-tip" };
      await passes(1, () => manager.recoverAlreadyMergedReviewTasks());
      expect(rejectionLines("KB-168")).toHaveLength(2);
      expect(rejectionRows("KB-168")).toHaveLength(2);
      expect(rejectionRows("KB-168")[1].metadata.candidateSha).toBe(SHA_B);

      await passes(2, () => manager.recoverAlreadyMergedReviewTasks());
      expect(rejectionLines("KB-168")).toHaveLength(2);
      expect(rejectionRows("KB-168")).toHaveLength(2);

      // The refusal itself is unchanged: nothing is finalized or moved.
      expect(store.updateTask).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalled();
    });

    it("keeps the card's real history when the log is one entry below the cap", async () => {
      const real = Array.from({ length: 999 }, (_, index) => ({ timestamp: `2026-10-12T00:00:${String(index % 60).padStart(2, "0")}.000Z`, action: `real entry ${index}` }));
      store = createStore([reviewTask("KB-168", { log: real })]);
      const manager = newManager();

      await passes(5, () => manager.recoverAlreadyMergedReviewTasks());

      const log = store.tasks.get("KB-168").log.map((entry: any) => entry.action);
      expect(log.slice(0, 999)).toEqual(real.map((entry) => entry.action));
      expect(rejectionLines("KB-168")).toHaveLength(1);
      expect(rejectionRows("KB-168")).toHaveLength(1);
    });
  });

  describe("every call site records an unchanged rejection once", () => {
    for (const reason of ["foreign-task-tip", "foreign-lineage-tip", "ownership-unverifiable"] as const) {
      it(`already-merged recovery, ${reason}`, async () => {
        store = createStore([reviewTask()]);
        foreignTip = { sha: SHA_A, owner: reason === "ownership-unverifiable" ? undefined : "KB-159", reason };
        const manager = newManager();

        await passes(3, () => manager.recoverAlreadyMergedReviewTasks());

        expect(rejectionLines("KB-168")).toHaveLength(1);
        expect(rejectionRows("KB-168")).toHaveLength(1);
        expect(rejectionRows("KB-168")[0].metadata).toMatchObject({ reason, phase: "recover-already-merged-review" });
      });
    }

    for (const reason of ["foreign-task-tip", "foreign-lineage-tip"] as const) {
      it(`branch-misbound recovery, ${reason}`, async () => {
        store = createStore([reviewTask("KB-300", { status: null, mergeRetries: 0 })]);
        foreignTip = { sha: SHA_A, owner: "KB-159", reason };
        const manager = newManager();

        await passes(3, () => manager.recoverBranchMisboundInReviewTasks());

        expect(rejectionLines("KB-300")).toHaveLength(1);
        expect(rejectionRows("KB-300")).toHaveLength(1);
        expect(rejectionRows("KB-300")[0].metadata).toMatchObject({ reason, phase: "recover-branch-misbound-in-review" });
      });
    }

    for (const reason of ["foreign-task-tip", "foreign-lineage-tip"] as const) {
      it(`reclaim sweep tip-already-merged arm, ${reason}`, async () => {
        store = createStore([holdTask()]);
        foreignTip = { sha: SHA_A, owner: "KB-159", reason };
        vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValue({ kind: "tip-already-merged", livePath: null, tipSha: SHA_A, integrationRef: "main" } as any);
        const manager = newManager();

        await passes(3, () => manager.reclaimSelfOwnedBranchConflicts());

        expect(rejectionLines("KB-500")).toHaveLength(1);
        expect(rejectionRows("KB-500")).toHaveLength(1);
        expect(rejectionRows("KB-500")[0].metadata).toMatchObject({ reason, phase: "tip-already-merged", baseBranch: "main" });
        expect(store.updateTask).not.toHaveBeenCalledWith("KB-500", expect.objectContaining({ branch: null }));
      });
    }

    it("reclaim sweep tip-already-merged arm, ownership lookup failure", async () => {
      store = createStore([holdTask()]);
      vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValue({ kind: "tip-already-merged", livePath: null, tipSha: SHA_A, integrationRef: "main" } as any);
      const manager = newManager();
      vi.mocked((manager as any).readCommitTaskOwnership).mockRejectedValue(new Error("git show failed"));

      await passes(3, () => manager.reclaimSelfOwnedBranchConflicts());

      expect(rejectionLines("KB-500")).toEqual([
        "[recovery] already-merged rejected KB-500 candidate=15621df56801 owner=unknown branch=fusion/kb-500 base=main reason=ownership-unverifiable",
      ]);
      expect(rejectionRows("KB-500")).toHaveLength(1);
      expect(rejectionRows("KB-500")[0].metadata).toMatchObject({ reason: "ownership-unverifiable", phase: "tip-already-merged" });
    });

    it("foreign-landed-commit, through the helper directly", async () => {
      // `foreign-landed-commit` is a member of the helper's reason type with no production producer today.
      store = createStore([reviewTask()]);
      const manager = newManager();
      const reject = () => (manager as any).rejectForeignAlreadyMergedCandidate({
        task: { id: "KB-168" },
        candidateSha: SHA_A,
        candidateOwner: "KB-159",
        taskBranch: "fusion/kb-168",
        baseBranch: "main",
        reason: "foreign-landed-commit",
        phase: "direct",
      });

      await passes(3, reject);

      expect(rejectionLines("KB-168")).toHaveLength(1);
      expect(rejectionRows("KB-168")).toHaveLength(1);
      expect(rejectionRows("KB-168")[0].metadata.reason).toBe("foreign-landed-commit");
    });
  });

  describe("identity", () => {
    type Identity = { candidateSha: string; candidateOwner?: string; taskBranch?: string | null; baseBranch: string; reason: Reason };
    const first: Identity = { candidateSha: SHA_A, candidateOwner: "KB-159", taskBranch: "fusion/kb-168", baseBranch: "main", reason: "foreign-task-tip" };

    function rejecter(manager: SelfHealingManager, phase = "direct") {
      return (identity: Identity) => (manager as any).rejectForeignAlreadyMergedCandidate({ task: { id: "KB-168" }, phase, ...identity });
    }

    const changes: Array<[string, Partial<Identity>, (row: any) => void]> = [
      ["candidate", { candidateSha: SHA_B }, (row) => expect(row.metadata.candidateSha).toBe(SHA_B)],
      ["owner", { candidateOwner: "KB-160" }, (row) => expect(row.metadata.candidateOwner).toBe("KB-160")],
      ["owner to unknown", { candidateOwner: undefined }, (row) => expect(row.metadata.candidateOwner).toBeNull()],
      ["branch", { taskBranch: "fusion/kb-168-2" }, (row) => expect(row.metadata.taskBranch).toBe("fusion/kb-168-2")],
      ["base", { baseBranch: "fusion/kb-167" }, (row) => expect(row.metadata.baseBranch).toBe("fusion/kb-167")],
      ["reason", { reason: "foreign-lineage-tip" }, (row) => expect(row.metadata.reason).toBe("foreign-lineage-tip")],
    ];

    for (const [field, change, check] of changes) {
      it(`a changed ${field} is recorded once`, async () => {
        store = createStore([reviewTask()]);
        const reject = rejecter(newManager());
        await reject(first);
        await reject(first);

        await reject({ ...first, ...change });
        await reject({ ...first, ...change });

        expect(rejectionLines("KB-168")).toHaveLength(2);
        expect(rejectionRows("KB-168")).toHaveLength(2);
        check(rejectionRows("KB-168")[1]);
      });
    }

    it("compares with the last recorded rejection, so A, B, A records three times", async () => {
      store = createStore([reviewTask()]);
      const reject = rejecter(newManager());
      const second = { ...first, candidateSha: SHA_B };

      await reject(first);
      await reject(second);
      await reject(first);

      expect(rejectionLines("KB-168")).toHaveLength(3);
      expect(rejectionRows("KB-168")).toHaveLength(3);
    });

    it("unrelated entries between two identical rejections do not re-arm recording", async () => {
      store = createStore([reviewTask()]);
      const reject = rejecter(newManager());

      await reject(first);
      await store.logEntry("KB-168", "[merge] something else happened");
      await store.logEntry("KB-168", "[recovery] already-merged rejected KB-1680 candidate=x owner=y branch=z base=main reason=foreign-task-tip");
      await reject(first);

      expect(rejectionLines("KB-168")).toHaveLength(1);
      expect(rejectionRows("KB-168")).toHaveLength(1);
    });

    it("records again once the last rejection has been evicted by the log cap", async () => {
      store = createStore([reviewTask()]);
      store.logCap = 3;
      const reject = rejecter(newManager());

      await reject(first);
      for (const index of [1, 2, 3]) await store.logEntry("KB-168", `real entry ${index}`);
      await reject(first);

      expect(rejectionLines("KB-168")).toHaveLength(1);
      expect(rejectionRows("KB-168")).toHaveLength(2);
    });

    it("phase is not identity: the same refusal from two sweeps is one record", async () => {
      store = createStore([reviewTask()]);
      const manager = newManager();

      await manager.recoverAlreadyMergedReviewTasks();
      advancePass();
      await manager.recoverBranchMisboundInReviewTasks();

      expect(rejectionLines("KB-168")).toHaveLength(1);
      expect(rejectionRows("KB-168")).toHaveLength(1);
      expect(rejectionRows("KB-168")[0].metadata.phase).toBe("recover-already-merged-review");
    });
  });

  describe("persistence", () => {
    it("a restarted manager reaches the same decision from the persisted log", async () => {
      store = createStore([reviewTask()]);
      const before = newManager();
      await passes(1, () => before.recoverAlreadyMergedReviewTasks());
      before.stop();

      const after = newManager();
      await passes(2, () => after.recoverAlreadyMergedReviewTasks());
      expect(rejectionLines("KB-168")).toHaveLength(1);
      expect(rejectionRows("KB-168")).toHaveLength(1);

      foreignTip = { sha: SHA_B, owner: "KB-159", reason: "foreign-task-tip" };
      await passes(1, () => after.recoverAlreadyMergedReviewTasks());
      expect(rejectionLines("KB-168")).toHaveLength(2);
      expect(rejectionRows("KB-168")).toHaveLength(2);
    });

    it("records on every call when the task read fails", async () => {
      store = createStore([reviewTask()]);
      const manager = newManager();
      vi.mocked(store.getTask).mockRejectedValue(new Error("database unavailable"));

      await passes(3, () => manager.recoverAlreadyMergedReviewTasks());

      expect(rejectionLines("KB-168")).toHaveLength(3);
      expect(rejectionRows("KB-168")).toHaveLength(3);
      expect(store.updateTask).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalled();
    });

    it("records on every call when the task read carries no log", async () => {
      store = createStore([reviewTask()]);
      const manager = newManager();
      vi.mocked(store.getTask).mockImplementation(async (id: string) => ({ id, column: "in-review" }) as any);

      await passes(3, () => manager.recoverAlreadyMergedReviewTasks());

      expect(rejectionLines("KB-168")).toHaveLength(3);
      expect(rejectionRows("KB-168")).toHaveLength(3);
      expect(store.updateTask).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalled();
    });
  });
});
