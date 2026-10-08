/*
FNXC:PostMergeRecovery 2026-10-08-07:08:
KB-042 symptom test (real git). A landed workspace task whose clean per-repository checkouts lack their
repository's landed squash SHA used to fail the post-merge gate immediately and wait for an operator.
Each repository is now recovered in place, independently: a clean checkout is detached at its landed
branch tip, while a dirty or unrecoverable repository alone holds the gate as a recoverable failure.
Only the reviewer session is stubbed; git, containment and recovery run for real on every platform.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspaceTaskWorktreeDir, type Settings, type TaskDetail } from "@fusion/core";
import { runGraphCustomNode, type RunGraphCustomNodeDeps } from "../executor/run-graph-custom-node.js";
import { WORKFLOW_OPTIONAL_GROUP_CONTEXT_KEY, WORKFLOW_OPTIONAL_GROUP_PHASE_CONTEXT_KEY } from "../workflows/workflow-graph-executor.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.t",
};
const REPOS = ["repo-a", "repo-b"] as const;
type Repo = typeof REPOS[number];
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

interface WorkspaceFixture {
  root: string;
  paths: Record<Repo, string>;
  shas: Record<Repo, string>;
  task: Record<string, unknown>;
}

/**
 * Builds a workspace root with two sub-repositories, each with a task worktree on `fusion/fn-x-<repo>`
 * under the workspace task directory, then squash-lands a commit on each repository's `main` that the
 * task checkouts never see. `alreadyLanded` repositories instead fast-forward `main` to the task branch,
 * so their checkout already contains the landed SHA.
 */
function landedWorkspace(opts: { alreadyLanded?: Repo[]; baseBranches?: Partial<Record<Repo, string>> } = {}): WorkspaceFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fusion-kb042-ws-")));
  tracked.push(root);
  const taskDir = resolveWorkspaceTaskWorktreeDir(root, {}, "FN-X");
  mkdirSync(taskDir, { recursive: true });
  const paths = {} as Record<Repo, string>;
  const shas = {} as Record<Repo, string>;
  for (const repo of REPOS) {
    const repoRoot = join(root, repo);
    mkdirSync(repoRoot, { recursive: true });
    git(repoRoot, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repoRoot, "base.txt"), "base\n");
    git(repoRoot, ["add", "-A"]);
    git(repoRoot, ["commit", "-q", "-m", "base"]);
    git(repoRoot, ["branch", "release"]);
    const worktree = join(taskDir, repo);
    git(repoRoot, ["worktree", "add", "-q", "-b", `fusion/fn-x-${repo}`, worktree, "main"]);
    paths[repo] = worktree;
    if (opts.alreadyLanded?.includes(repo)) {
      writeFileSync(join(worktree, "feature.txt"), `${repo} feature\n`);
      git(worktree, ["add", "-A"]);
      git(worktree, ["commit", "-q", "-m", "feat: landed work"]);
      git(repoRoot, ["merge", "-q", "--ff-only", `fusion/fn-x-${repo}`]);
    } else {
      writeFileSync(join(repoRoot, "squashed.txt"), `${repo} squashed\n`);
      git(repoRoot, ["add", "squashed.txt"]);
      git(repoRoot, ["commit", "-q", "-m", "feat(FN-X): squash"]);
    }
    shas[repo] = git(repoRoot, ["rev-parse", "main"]);
  }
  const now = new Date().toISOString();
  const task: Record<string, unknown> = {
    id: "FN-X",
    title: "Landed workspace task",
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
    worktree: undefined,
    branch: undefined,
    workspaceRoot: root,
    repositoryScope: { state: "confirmed", revision: 1, repositories: [...REPOS] },
    workspaceWorktrees: Object.fromEntries(REPOS.map((repo) => [repo, {
      worktreePath: paths[repo],
      branch: `fusion/fn-x-${repo}`,
      baseCommitSha: "base",
      ...(opts.baseBranches?.[repo] ? { baseBranch: opts.baseBranches[repo] } : {}),
    }])),
    mergeRetries: 0,
    enabledWorkflowSteps: ["post-merge-verification"],
    workflowStepResults: [],
    mergeDetails: { mergeConfirmed: true, commitSha: shas["repo-a"], workspaceLandedShas: { ...shas } },
    createdAt: now,
    updatedAt: now,
  };
  return { root, paths, shas, task };
}

function createStore(task: Record<string, unknown>) {
  const logs: string[] = [];
  const known: Record<string, unknown> = {
    getTask: vi.fn(async () => structuredClone(task)),
    getSettings: vi.fn(async () => ({})),
    getRootDir: vi.fn(() => undefined),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => { Object.assign(task, patch); return { ...task }; }),
    updateTaskAtomic: vi.fn(async (_id: string, reducer: (live: Record<string, unknown>) => Record<string, unknown> | null) => {
      const patch = await reducer({ ...task });
      if (patch) Object.assign(task, patch);
      return { ...task };
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
  return { store: store as never, logs, getLive: () => (known.getTask as () => Promise<TaskDetail>)() };
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

function buildDeps(root: string, store: never, onSession: () => Promise<void>) {
  const ensureGraphCustomNodeWorktree = vi.fn(async (task: TaskDetail) => task);
  const executeWorkflowStep = vi.fn(async () => {
    await onSession();
    return { success: true, output: APPROVE, verdict: "APPROVE", notes: "Verified landed result." };
  });
  const deps = {
    store,
    rootDir: root,
    workspaceConfig: { repos: [...REPOS] },
    options: {},
    graphUnattendedRuns: new Set(),
    getRunContextFor: () => undefined,
    adoptColumnAgentForNode: vi.fn(),
    buildInjectedRuntimeEnv: vi.fn(async () => ({ env: undefined, pathEntryCount: 0, injectedKeyCount: 0 })),
    ensureGraphCustomNodeWorktree,
    executeScriptWorkflowStep: vi.fn(),
    executeWorkflowStep,
    pauseForCliApproval: vi.fn(),
    resolveWorkflowInputMarkerForGraphNode: vi.fn(async () => "none"),
    runAwaitInputNode: vi.fn(),
    runCliAgentNode: vi.fn(),
    runRawCliCommand: vi.fn(),
    runConfiguredCommand: vi.fn() as never,
  } as unknown as RunGraphCustomNodeDeps;
  return { deps, executeWorkflowStep, ensureGraphCustomNodeWorktree };
}

async function runNode(fixture: WorkspaceFixture, store: ReturnType<typeof createStore>, onSession: () => Promise<void>) {
  const harness = buildDeps(fixture.root, store.store, onSession);
  const result = await runGraphCustomNode(harness.deps, POST_MERGE_NODE as never, await store.getLive(), {} as Settings, undefined, POST_MERGE_CONTEXT);
  return { result, ...harness };
}

function branchTips(fixture: WorkspaceFixture): Record<Repo, string> {
  return Object.fromEntries(REPOS.map((repo) => [repo, git(join(fixture.root, repo), ["rev-parse", `fusion/fn-x-${repo}`])])) as Record<Repo, string>;
}

describe("workspace post-merge gate in-place recovery (KB-042, real git)", () => {
  it("recovers every clean repository lacking its landed SHA and runs the gate", async () => {
    const fixture = landedWorkspace();
    const store = createStore(fixture.task);
    const tipsBefore = branchTips(fixture);
    const pointersBefore = structuredClone(fixture.task.workspaceWorktrees);
    const { result, executeWorkflowStep, ensureGraphCustomNodeWorktree } = await runNode(fixture, store, async () => {
      for (const repo of REPOS) expect(isAncestor(fixture.paths[repo], fixture.shas[repo])).toBe(true);
    });

    expect(result).toMatchObject({ outcome: "success", value: "APPROVE" });
    expect(executeWorkflowStep).toHaveBeenCalledOnce();
    expect(ensureGraphCustomNodeWorktree).not.toHaveBeenCalled();
    expect(fixture.task.workspaceWorktrees).toEqual(pointersBefore);
    expect(branchTips(fixture)).toEqual(tipsBefore);
    for (const repo of REPOS) {
      expect(git(fixture.paths[repo], ["branch", "--show-current"])).toBe("");
      expect(store.logs.filter((line) => line.includes("detached") && line.includes(`workspace repository '${repo}'`) && line.includes("at the tip of main"))).toHaveLength(1);
    }
  });

  it("recovers a clean repository, holds a dirty sibling with an operator reason, and resumes once it is clean", async () => {
    const fixture = landedWorkspace();
    const store = createStore(fixture.task);
    writeFileSync(join(fixture.paths["repo-b"], "base.txt"), "uncommitted edit\n");
    const repoBHead = git(fixture.paths["repo-b"], ["rev-parse", "HEAD"]);
    const onSession = vi.fn(async () => {
      for (const repo of REPOS) expect(isAncestor(fixture.paths[repo], fixture.shas[repo])).toBe(true);
    });

    const parked = await runNode(fixture, store, onSession);

    expect(parked.result).toEqual({ outcome: "failure", value: "post-merge-checkout-missing-landed-commit" });
    expect(onSession).not.toHaveBeenCalled();
    expect(isAncestor(fixture.paths["repo-a"], fixture.shas["repo-a"])).toBe(true);
    expect(git(fixture.paths["repo-a"], ["branch", "--show-current"])).toBe("");
    expect(git(fixture.paths["repo-b"], ["rev-parse", "HEAD"])).toBe(repoBHead);
    expect(git(fixture.paths["repo-b"], ["branch", "--show-current"])).toBe("fusion/fn-x-repo-b");
    expect(git(fixture.paths["repo-b"], ["status", "--porcelain"])).toContain("base.txt");
    expect(store.logs.some((line) => line.includes("'repo-b'") && line.includes(fixture.paths["repo-b"]) && line.includes("has uncommitted changes"))).toBe(true);
    expect(store.logs.some((line) => line.includes("does not contain") && line.includes("'repo-a'"))).toBe(false);

    git(fixture.paths["repo-b"], ["checkout", "--", "base.txt"]);
    const resumed = await runNode(fixture, store, onSession);
    expect(resumed.result).toMatchObject({ outcome: "success", value: "APPROVE" });
    expect(onSession).toHaveBeenCalledOnce();
  });

  it("refuses a repository whose landed SHA is not on its recorded base branch, without moving it", async () => {
    const fixture = landedWorkspace({ baseBranches: { "repo-b": "release" } });
    const store = createStore(fixture.task);
    const repoBHead = git(fixture.paths["repo-b"], ["rev-parse", "HEAD"]);
    const onSession = vi.fn(async () => undefined);

    const { result } = await runNode(fixture, store, onSession);

    expect(result).toEqual({ outcome: "failure", value: "post-merge-checkout-missing-landed-commit" });
    expect(onSession).not.toHaveBeenCalled();
    expect(git(fixture.paths["repo-b"], ["rev-parse", "HEAD"])).toBe(repoBHead);
    expect(git(fixture.paths["repo-b"], ["branch", "--show-current"])).toBe("fusion/fn-x-repo-b");
    expect(store.logs.some((line) => line.includes("'repo-b'") && line.includes(`is not on release`))).toBe(true);
  });

  it("leaves a repository that already contains its landed SHA attached and untouched", async () => {
    const fixture = landedWorkspace({ alreadyLanded: ["repo-a"] });
    const store = createStore(fixture.task);
    const repoAHead = git(fixture.paths["repo-a"], ["rev-parse", "HEAD"]);

    const { result } = await runNode(fixture, store, async () => undefined);

    expect(result).toMatchObject({ outcome: "success", value: "APPROVE" });
    expect(git(fixture.paths["repo-a"], ["rev-parse", "HEAD"])).toBe(repoAHead);
    expect(git(fixture.paths["repo-a"], ["branch", "--show-current"])).toBe("fusion/fn-x-repo-a");
    expect(git(fixture.paths["repo-b"], ["branch", "--show-current"])).toBe("");
    expect(isAncestor(fixture.paths["repo-b"], fixture.shas["repo-b"])).toBe(true);
    expect(store.logs.filter((line) => line.includes("detached"))).toHaveLength(1);
  });

  it("fails closed for a repository with no recorded checkout path", async () => {
    const fixture = landedWorkspace();
    (fixture.task.workspaceWorktrees as Record<string, Record<string, unknown>>)["repo-b"] = { branch: "fusion/fn-x-repo-b" };
    const store = createStore(fixture.task);
    const onSession = vi.fn(async () => undefined);

    const { result } = await runNode(fixture, store, onSession);

    expect(result).toEqual({ outcome: "failure", value: "post-merge-checkout-missing-landed-commit" });
    expect(onSession).not.toHaveBeenCalled();
    expect(store.logs.some((line) => line.includes("'repo-b'") && line.includes("no recorded checkout"))).toBe(true);
  });
});
