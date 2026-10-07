import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_CODING_WORKFLOW_IR, type Settings, type Task, type TaskStore } from "@fusion/core";
import { POST_MERGE_PUBLICATION_REPROBE_INTERVAL_MS, resumeMissingPostMergeGate } from "../merge/post-merge-gate-reseed.js";

/*
FNXC:PostMergePublication 2026-10-07-13:00:
The built-in post-merge verification gate can only pass once the landed commit is on the push remote,
because its evidence is hosted CI on that remote. A reseed against an unpublished commit runs a reviewer
that must REVISE, so the reseed seam proves publication first and otherwise reports the waiting state once.
*/
const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
let sequence = 0;

type Git = (args: string[], cwd: string, timeout: number, signal?: AbortSignal) => Promise<string>;

function fixture(options: { pushAfterMerge: boolean; workflowStepId?: string; customWorkflow?: boolean }) {
  const workflowStepId = options.workflowStepId ?? "post-merge-verification";
  const rejection = {
    workflowStepId, phase: "post-merge", status: "failed", verdict: "REVISE",
    completedAt: new Date(Date.now() - 61 * 60_000).toISOString(), notes: "No Full Suite run exists",
  };
  const task = {
    id: `FN-PUB-${++sequence}`, column: "in-review", updatedAt: "2026-10-07T13:00:00.000Z", autoMerge: true, steps: [],
    mergeDetails: { mergeConfirmed: true, commitSha: sha, mergeTargetBranch: "main" },
    enabledWorkflowSteps: [workflowStepId],
    workflowStepResults: [{ ...rejection, priorAttempts: [rejection, rejection, rejection] }],
  } as unknown as Task;
  const settings = { autoMerge: true, pushAfterMerge: options.pushAfterMerge } as Settings;
  const items: unknown[] = [];
  const workflowId = options.customWorkflow ? "WF-001" : "builtin:coding";
  const customIr = JSON.stringify(BUILTIN_CODING_WORKFLOW_IR).replaceAll("\"post-merge-verification\"", `"${workflowStepId}"`);
  let updatedAtCounter = 0;
  const store = {
    rootDir: `/repo-publication-${sequence}`,
    getTask: vi.fn(async () => structuredClone(task)),
    getSettings: vi.fn(async () => settings),
    updateTaskAtomic: vi.fn(async (_id: string, update: (live: Task) => Partial<Task> | null | Promise<Partial<Task> | null>) => {
      const patch = await update(structuredClone(task));
      if (patch) Object.assign(task, patch, { updatedAt: `2026-10-07T13:00:0${++updatedAtCounter}.000Z` });
      return structuredClone(task);
    }),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId, stepIds: task.enabledWorkflowSteps ?? [] })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId, stepIds: task.enabledWorkflowSteps ?? [] })),
    getWorkflowDefinition: vi.fn(async (id: string) => (id === "WF-001" ? { ir: customIr } : undefined)),
    listWorkflowWorkItemsForTask: vi.fn(async () => items),
    seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(async (input: { expectedTaskUpdatedAt?: string }) => {
      if (items.length) return { seeded: false, reason: "active-continuation" as const };
      if (input.expectedTaskUpdatedAt !== task.updatedAt) return { seeded: false, reason: "stale-task" as const };
      items.push(input);
      return { seeded: true, workItemId: "post-merge-continuation" };
    }),
  } as unknown as TaskStore;
  const remote = { tip: "" };
  const git = vi.fn<Git>(async (args) => {
    if (args[0] === "ls-remote") return remote.tip ? `${remote.tip}\trefs/heads/main` : "";
    if (args[0] === "push") { remote.tip = sha; return ""; }
    if (args[0] === "merge-base" && args[3] === otherSha) throw Object.assign(new Error("not an ancestor"), { code: 1 });
    return "";
  });
  return { task, settings, store, items, git, remote };
}

const publicationLogs = (store: TaskStore) => vi.mocked(store.logEntry).mock.calls
  .map(([, message]) => message as string)
  .filter((message) => message.includes("waiting for publication"));
const publicationAudits = (store: TaskStore) => vi.mocked(store.recordRunAuditEvent!).mock.calls
  .map(([event]) => event as { mutationType: string; metadata: Record<string, unknown> })
  .filter((event) => event.mutationType === "task:post-merge-gate-awaiting-publication");

describe("post-merge verification publication precondition", () => {
  afterEach(() => vi.useRealTimers());
  const advancePastReprobeInterval = () => vi.setSystemTime(Date.now() + POST_MERGE_PUBLICATION_REPROBE_INTERVAL_MS + 1);

  it("re-probes a waiting landing at most once per interval, while a manual retry probes immediately", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { task, store, items, git, remote } = fixture({ pushAfterMerge: false });
    const probes = () => git.mock.calls.filter(([args]) => args[0] === "ls-remote").length;

    await expect(resumeMissingPostMergeGate(store, task.id, { git })).resolves.toMatchObject({ outcome: "awaiting-publication", reason: "push-disabled" });
    await expect(resumeMissingPostMergeGate(store, task.id, { git })).resolves.toMatchObject({ outcome: "awaiting-publication", reason: "push-disabled" });
    expect(probes()).toBe(1);

    remote.tip = sha;
    await expect(resumeMissingPostMergeGate(store, task.id, { manualRetry: true, git })).resolves.toMatchObject({ outcome: "resumed" });
    expect(probes()).toBe(2);
    expect(items).toHaveLength(1);
  });

  it("re-probes after the interval and reseeds once the commit is published", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { task, store, items, git, remote } = fixture({ pushAfterMerge: false });
    await resumeMissingPostMergeGate(store, task.id, { git });
    remote.tip = sha;
    await expect(resumeMissingPostMergeGate(store, task.id, { git })).resolves.toMatchObject({ outcome: "awaiting-publication" });
    advancePastReprobeInterval();
    await expect(resumeMissingPostMergeGate(store, task.id, { git })).resolves.toEqual({ outcome: "resumed", gateId: "post-merge-verification" });
    expect(items).toHaveLength(1);
  });

  it("reseeds the gate when the landed commit is already on the push remote", async () => {
    const { task, store, items, git, remote } = fixture({ pushAfterMerge: false });
    remote.tip = sha;
    await expect(resumeMissingPostMergeGate(store, task.id, { git })).resolves.toEqual({ outcome: "resumed", gateId: "post-merge-verification" });
    expect(items).toHaveLength(1);
    expect(git.mock.calls.some(([args]) => args[0] === "push")).toBe(false);
    expect(publicationLogs(store)).toEqual([]);
  });

  it("treats a newer remote tip containing the landed commit as published", async () => {
    const { task, store, items, git, remote } = fixture({ pushAfterMerge: false });
    remote.tip = "c".repeat(40);
    await expect(resumeMissingPostMergeGate(store, task.id, { git })).resolves.toMatchObject({ outcome: "resumed" });
    expect(items).toHaveLength(1);
  });

  it("waits without running the reviewer when push-after-merge is off, logging and auditing once across ticks", async () => {
    const { task, store, items, git } = fixture({ pushAfterMerge: false });
    for (let tick = 0; tick < 2; tick++) {
      await expect(resumeMissingPostMergeGate(store, task.id, { git })).resolves.toMatchObject({
        outcome: "awaiting-publication", gateId: "post-merge-verification", reason: "push-disabled",
      });
    }
    expect(items).toEqual([]);
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
    expect(git.mock.calls.some(([args]) => args[0] === "push")).toBe(false);
    expect(publicationLogs(store)).toEqual([
      "[post-merge] Post-merge verification is waiting for publication: aaaaaaaaaaaa is not on origin/main and Push after merge is off. Enable Push after merge or push main to origin; the gate re-runs once the commit is on the remote.",
    ]);
    const audits = publicationAudits(store);
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toEqual({
      taskId: task.id, nodeId: "post-merge-verification", reason: "push-disabled", remote: "origin", shortSha: "aaaaaaaaaaaa",
    });
    expect(task.workflowStepResults?.[0]).toMatchObject({ status: "failed", verdict: "REVISE" });
  });

  it("treats a diverged remote branch that lacks the landed commit as unpublished", async () => {
    const { task, store, items, git, remote } = fixture({ pushAfterMerge: false });
    remote.tip = otherSha;
    await expect(resumeMissingPostMergeGate(store, task.id, { git })).resolves.toMatchObject({ outcome: "awaiting-publication", reason: "push-disabled" });
    expect(items).toEqual([]);
  });

  it("publishes through confirmed-merge push recovery and then reseeds when push-after-merge is on", async () => {
    const { task, store, items, git, remote } = fixture({ pushAfterMerge: true });
    await expect(resumeMissingPostMergeGate(store, task.id, { git })).resolves.toEqual({ outcome: "resumed", gateId: "post-merge-verification" });
    expect(git).toHaveBeenCalledWith(["push", "origin", `${sha}:refs/heads/main`], store.rootDir, expect.any(Number));
    expect(remote.tip).toBe(sha);
    expect(items).toHaveLength(1);
    expect(task.mergeDetails?.pushRecovery?.pushedAt).toBeTruthy();
    expect(publicationLogs(store)).toEqual([]);
  });

  it("does not reseed when push recovery fails, and reports the push failure once", async () => {
    const { task, store, items, git } = fixture({ pushAfterMerge: true });
    const base = git.getMockImplementation()!;
    git.mockImplementation(async (args, ...rest) => {
      if (args[0] === "push") throw new Error("rejected: non-fast-forward");
      return base(args, ...rest);
    });
    for (let tick = 0; tick < 2; tick++) {
      await expect(resumeMissingPostMergeGate(store, task.id, { git })).resolves.toMatchObject({ outcome: "awaiting-publication", reason: "push-failed" });
    }
    expect(items).toEqual([]);
    expect(publicationLogs(store)).toHaveLength(1);
    expect(publicationLogs(store)[0]).toContain("aaaaaaaaaaaa is not on origin/main");
    expect(publicationAudits(store).map((event) => event.metadata.reason)).toEqual(["push-failed"]);
  });

  it("fails closed for this tick when publication cannot be determined, without treating it as unpublished", async () => {
    const { task, store, items, git } = fixture({ pushAfterMerge: true });
    git.mockImplementation(async (args) => {
      if (args[0] === "ls-remote") throw new Error("Could not resolve host");
      return "";
    });
    await expect(resumeMissingPostMergeGate(store, task.id, { git })).resolves.toMatchObject({ outcome: "awaiting-publication", reason: "publication-unknown" });
    expect(items).toEqual([]);
    expect(git.mock.calls.some(([args]) => args[0] === "push")).toBe(false);
    expect(publicationLogs(store)).toEqual([
      "[post-merge] Post-merge verification is waiting for publication: could not determine whether aaaaaaaaaaaa is on origin/main (remote unreachable or git error). The gate re-runs once the remote can confirm the commit.",
    ]);
    expect(publicationAudits(store).map((event) => event.metadata.reason)).toEqual(["publication-unknown"]);
  });

  it("logs again when the waiting state changes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { task, store, git } = fixture({ pushAfterMerge: false });
    const base = git.getMockImplementation()!;
    git.mockImplementation(async (args, ...rest) => {
      if (args[0] === "ls-remote") throw new Error("Could not resolve host");
      return base(args, ...rest);
    });
    await resumeMissingPostMergeGate(store, task.id, { git });
    git.mockImplementation(base);
    advancePastReprobeInterval();
    await resumeMissingPostMergeGate(store, task.id, { git });
    expect(publicationAudits(store).map((event) => event.metadata.reason)).toEqual(["publication-unknown", "push-disabled"]);
  });

  it("applies to an explicit manual retry: it reports the waiting state instead of running the reviewer", async () => {
    const { task, store, items, git } = fixture({ pushAfterMerge: false });
    task.workflowStepResults![0].completedAt = new Date().toISOString();
    const result = await resumeMissingPostMergeGate(store, task.id, { manualRetry: true, git });
    expect(result).toMatchObject({ outcome: "awaiting-publication", reason: "push-disabled", message: expect.stringContaining("Push after merge is off") });
    expect(items).toEqual([]);
  });

  it("leaves a user-defined post-merge gate unaffected by remote publication", async () => {
    const { task, store, items, git } = fixture({ pushAfterMerge: false, workflowStepId: "custom-post-merge-gate", customWorkflow: true });
    await expect(resumeMissingPostMergeGate(store, task.id, { git })).resolves.toEqual({ outcome: "resumed", gateId: "custom-post-merge-gate" });
    expect(items).toHaveLength(1);
    expect(git).not.toHaveBeenCalled();
  });
});
