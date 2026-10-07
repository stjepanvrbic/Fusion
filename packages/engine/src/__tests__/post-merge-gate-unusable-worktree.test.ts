/*
FNXC:PostMergeRecovery 2026-10-07-05:29:
KB-003 symptom test (real git). KB-001 stayed in In Review forever: post-landing cleanup left its task
worktree half-deleted, `.git`-less and unregistered, the branch was deleted, and every
post-merge-verification recheck died in the session-start guard with "incomplete worktree".
This reproduces each recorded-worktree state (incomplete, unregistered, absent, healthy control),
runs the post-merge node through the real graph seam and real acquisition (only the reviewer session
is stubbed), and proves the gate produces a verdict and the card finalizes without manual git repair.
All filesystem operations are portable so the simulated states run on Windows and POSIX.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings, TaskDetail } from "@fusion/core";
import { runGraphCustomNode, type RunGraphCustomNodeDeps } from "../executor/run-graph-custom-node.js";
import { ensureGraphCustomNodeWorktree } from "../executor/ensure-graph-custom-node-worktree.js";
import { NativeWorktreeBackend } from "../worktree/worktree-backend.js";
import { assertValidWorktreeSession } from "../pi.js";
import { classifyTaskWorktree } from "../worktree/worktree-pool.js";
import { finalizeProvenAutoMergeTask } from "../merge/auto-merge-finalization.js";
import { WORKFLOW_OPTIONAL_GROUP_CONTEXT_KEY, WORKFLOW_OPTIONAL_GROUP_PHASE_CONTEXT_KEY } from "../workflows/workflow-graph-executor.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.t",
};
const tracked: string[] = [];

afterEach(() => {
  for (const dir of tracked.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", env: GIT_ENV, stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function isAncestor(cwd: string, sha: string): boolean {
  try {
    git(cwd, ["merge-base", "--is-ancestor", sha, "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

type WorktreeState = "incomplete" | "unregistered" | "absent" | "healthy";

/** Lands `fusion/fn-x` onto `main`, then puts the recorded checkout into the requested KB-001 state. */
function landedTask(state: WorktreeState): { root: string; worktree: string; landedSha: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fusion-kb003-gate-")));
  tracked.push(root);
  git(root, ["init", "-q", "-b", "main"]);
  writeFileSync(join(root, "base.txt"), "base\n");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n.fusion/\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "base"]);
  const worktree = join(root, ".fusion", "worktrees", "fn-x");
  mkdirSync(join(root, ".fusion", "worktrees"), { recursive: true });
  git(root, ["worktree", "add", "-q", "-b", "fusion/fn-x", worktree, "main"]);
  writeFileSync(join(worktree, "feature.txt"), "landed feature\n");
  mkdirSync(join(worktree, "docs"), { recursive: true });
  writeFileSync(join(worktree, "docs", "guide.md"), "guide\n");
  git(worktree, ["add", "-A"]);
  git(worktree, ["commit", "-q", "-m", "feat: landed work"]);
  git(root, ["merge", "-q", "--ff-only", "fusion/fn-x"]);
  const landedSha = git(root, ["rev-parse", "main"]);

  if (state === "healthy") return { root, worktree, landedSha };

  mkdirSync(join(worktree, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(worktree, "node_modules", "pkg", "index.js"), "module.exports = {};\n");
  if (state === "incomplete") {
    // Half-deleted: `.git` file gone, part of the checkout gone, registration pruned.
    rmSync(join(worktree, ".git"), { force: true });
    rmSync(join(worktree, "docs"), { recursive: true, force: true });
    git(root, ["worktree", "prune"]);
  } else if (state === "unregistered") {
    // `.git` file still present but its admin entry is gone.
    rmSync(join(root, ".git", "worktrees", "fn-x"), { recursive: true, force: true });
  } else {
    rmSync(worktree, { recursive: true, force: true });
    git(root, ["worktree", "prune"]);
  }
  git(root, ["branch", "-D", "fusion/fn-x"]);
  return { root, worktree, landedSha };
}

function createStore(task: Record<string, unknown>) {
  const logs: string[] = [];
  const known: Record<string, unknown> = {
    getTask: vi.fn(async () => ({ ...task })),
    getSettings: vi.fn(async () => ({})),
    getRootDir: vi.fn(() => undefined),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => { Object.assign(task, patch); return { ...task }; }),
    updateTaskAtomic: vi.fn(async (_id: string, reducer: (live: Record<string, unknown>) => Record<string, unknown> | null) => {
      const patch = await reducer({ ...task });
      if (patch) Object.assign(task, patch);
      return { ...task };
    }),
    moveTaskIf: vi.fn(async (_id: string, column: string, predicate: (live: Record<string, unknown>) => boolean | Promise<boolean>) => {
      if (!await predicate({ ...task })) return { moved: false, task: { ...task } };
      task.column = column;
      return { moved: true, task: { ...task } };
    }),
    logEntry: vi.fn(async (_id: string, message: string, detail?: string) => { logs.push(detail ? `${message} ${detail}` : message); }),
    appendAgentLog: vi.fn(async () => undefined),
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    recordRunAuditEvent: vi.fn(async () => undefined),
    emit: vi.fn(),
  };
  // Unclassified store reads used by best-effort observability resolve to empty values.
  const store = new Proxy(known, {
    get(target, property: string) {
      if (property in target) return target[property];
      if (property === "then") return undefined;
      return vi.fn(async () => undefined);
    },
  });
  return { store: store as never, logs, task };
}

const POST_MERGE_NODE = {
  id: "post-merge-verification-step",
  kind: "prompt",
  config: { name: "Post-merge verification", prompt: "Verify the landed result.", toolMode: "readonly", gateMode: "gate" },
};
const POST_MERGE_CONTEXT = {
  [WORKFLOW_OPTIONAL_GROUP_CONTEXT_KEY]: "post-merge-verification",
  [WORKFLOW_OPTIONAL_GROUP_PHASE_CONTEXT_KEY]: "post-merge",
};
const APPROVE = '{"verdict":"APPROVE","notes":"Verified landed result."}';

function buildDeps(root: string, store: never, onSession: (cwd: string) => Promise<void>): RunGraphCustomNodeDeps {
  const backend = new NativeWorktreeBackend({ settings: {} });
  const ensureDeps = {
    store,
    rootDir: root,
    workspaceConfigOwner: {},
    getWorkspaceConfig: () => null,
    setWorkspaceConfig: () => undefined,
    getRunContextFor: () => undefined,
    createWorktree: async (branch: string, path: string, taskId: string, startPoint?: string, allowSiblingBranchRename?: boolean) => {
      const created = await backend.create({ rootDir: root, branch, worktreePath: path, startPoint, taskId, allowSiblingBranchRename });
      return { path: created.path, branch: created.branch };
    },
    runConfiguredCommand: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }) as never,
    addActiveWorktree: () => undefined,
    registerConfiguredCommandController: () => undefined,
    unregisterConfiguredCommandController: () => undefined,
  };
  return {
    store,
    rootDir: root,
    workspaceConfig: null,
    options: {},
    graphUnattendedRuns: new Set(),
    getRunContextFor: () => undefined,
    adoptColumnAgentForNode: vi.fn(),
    buildInjectedRuntimeEnv: vi.fn(async () => ({ env: undefined, pathEntryCount: 0, injectedKeyCount: 0 })),
    ensureGraphCustomNodeWorktree: (task: TaskDetail, settings: Settings, nodeId: string) =>
      ensureGraphCustomNodeWorktree(ensureDeps as never, task, settings, nodeId),
    executeScriptWorkflowStep: vi.fn(),
    executeWorkflowStep: vi.fn(async (_task: TaskDetail, _step: unknown, cwd: string) => {
      await onSession(cwd);
      return { success: true, output: APPROVE, verdict: "APPROVE", notes: "Verified landed result." };
    }),
    pauseForCliApproval: vi.fn(),
    resolveWorkflowInputMarkerForGraphNode: vi.fn(async () => "none"),
    runAwaitInputNode: vi.fn(),
    runCliAgentNode: vi.fn(),
    runRawCliCommand: vi.fn(),
    runConfiguredCommand: vi.fn() as never,
  };
}

function landedTaskRecord(worktree: string | undefined, landedSha: string): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: "FN-X",
    title: "Landed task",
    description: "",
    column: "in-review",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    worktree,
    branch: "fusion/fn-x",
    executionStartBranch: "fusion/fn-dependency",
    mergeRetries: 0,
    enabledWorkflowSteps: ["post-merge-verification"],
    workflowStepResults: [],
    mergeDetails: { mergeConfirmed: true, commitSha: landedSha },
    createdAt: now,
    updatedAt: now,
  };
}

async function runPostMergeNode(state: WorktreeState) {
  const { root, worktree, landedSha } = landedTask(state);
  const fixture = createStore(landedTaskRecord(worktree, landedSha));
  const sessions: string[] = [];
  const deps = buildDeps(root, fixture.store, async (cwd) => {
    // The exact guard that refused KB-001, plus proof the checkout holds the landed result.
    await assertValidWorktreeSession(cwd, root);
    expect(isAncestor(cwd, landedSha)).toBe(true);
    sessions.push(cwd);
  });
  const live = await (fixture.store as unknown as { getTask: () => Promise<TaskDetail> }).getTask();
  const result = await runGraphCustomNode(deps, POST_MERGE_NODE as never, live, {} as Settings, undefined, POST_MERGE_CONTEXT);
  return { root, worktree, landedSha, fixture, sessions, result };
}

describe("post-merge gate after a half-deleted task worktree (KB-003, real git)", () => {
  it.each(["incomplete", "unregistered"] as const)("proves the %s repro is real: the session guard refuses the broken folder", async (state) => {
    const { root, worktree } = landedTask(state);
    await expect(assertValidWorktreeSession(worktree, root)).rejects.toThrow("Refusing to start coding agent in incomplete worktree");
  });

  it.each(["incomplete", "unregistered", "absent"] as const)("re-acquires a fresh checkout for a %s recorded worktree and produces a verdict", async (state) => {
    const { root, worktree, fixture, sessions, result } = await runPostMergeNode(state);

    expect(result.outcome).toBe("success");
    expect(result.value).toBe("APPROVE");
    expect(sessions).toHaveLength(1);
    expect(fixture.task.worktree).toBeTruthy();
    expect(await classifyTaskWorktree(root, fixture.task.worktree as string)).toEqual({ ok: true });
    if (state !== "absent") {
      const recoveryRoot = join(root, ".fusion", "recovery", "worktrees");
      expect(existsSync(recoveryRoot)).toBe(true);
      expect(readdirSync(recoveryRoot).some((name) => name.startsWith("fn-x-"))).toBe(true);
      expect(existsSync(join(worktree, ".git"))).toBe(true);
    }
    expect(fixture.logs.some((line) => line.includes("acquiring a fresh checkout at the integration branch"))).toBe(true);
  });

  it("reuses a healthy recorded checkout without re-acquisition", async () => {
    const { worktree, fixture, sessions, result } = await runPostMergeNode("healthy");

    expect(result.outcome).toBe("success");
    expect(sessions).toEqual([worktree]);
    expect(fixture.task.worktree).toBe(worktree);
    expect(fixture.logs.some((line) => line.includes("acquiring a fresh checkout"))).toBe(false);
  });

  it("returns a recoverable failure when the fresh checkout does not contain the landed commit", async () => {
    const { root, worktree } = landedTask("incomplete");
    // A landed SHA that never reached the integration branch (for example a rewritten remote).
    git(root, ["checkout", "-q", "-b", "side"]);
    writeFileSync(join(root, "side.txt"), "side\n");
    git(root, ["add", "side.txt"]);
    git(root, ["commit", "-q", "-m", "side"]);
    const foreignSha = git(root, ["rev-parse", "HEAD"]);
    git(root, ["checkout", "-q", "main"]);
    const fixture = createStore(landedTaskRecord(worktree, foreignSha));
    const onSession = vi.fn(async () => undefined);
    const deps = buildDeps(root, fixture.store, onSession);
    const live = await (fixture.store as unknown as { getTask: () => Promise<TaskDetail> }).getTask();

    const result = await runGraphCustomNode(deps, POST_MERGE_NODE as never, live, {} as Settings, undefined, POST_MERGE_CONTEXT);

    expect(result).toEqual({ outcome: "failure", value: "post-merge-checkout-missing-landed-commit" });
    expect(onSession).not.toHaveBeenCalled();
  });

  it("finalizes the card to done once the approved post-merge result is recorded, without manual git repair", async () => {
    const { root, fixture, result } = await runPostMergeNode("incomplete");
    expect(result.outcome).toBe("success");
    // The graph records the approved optional-group result for the post-merge evidence gate.
    fixture.task.workflowStepResults = [{
      workflowStepId: "post-merge-verification",
      workflowStepName: "Post-merge verification",
      phase: "post-merge",
      status: "passed",
      verdict: result.value,
      completedAt: new Date().toISOString(),
    }];

    const finalized = await finalizeProvenAutoMergeTask({
      store: fixture.store,
      taskId: "FN-X",
      rootDir: root,
      source: "workflow-graph-merge-finalize",
    });

    expect(finalized.outcome).toBe("done");
    expect(fixture.task.column).toBe("done");
  });
});
