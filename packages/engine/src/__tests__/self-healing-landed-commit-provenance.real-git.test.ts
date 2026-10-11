/*
FNXC:LandedCommitProvenance 2026-10-11-07:40:
Regression for recycled task IDs. A task whose work never reached the integration branch was finalized as merged against a six-month-old upstream commit that only shared its ID in the subject, and post-landing cleanup then deleted its unmerged branch and worktree.
Every landed-commit recovery must report "not landed" for that shape and leave the card, branch and worktree intact, while genuine landings (squash, lineage-only, advanced base, subject-only on the task branch) are still found.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";
import { findAlreadyMergedTaskCommit } from "../merge/already-merged-detector.js";
import { classifyOwnedLandedEvidence } from "../merge/merger-owned-landed.js";

const TASK_ID = "KB-900";
const LINEAGE = "lin-kb-900-0001";
const BRANCH = "fusion/kb-900";
const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

function gitDate(ms: number): string {
  return `${Math.floor(ms / 1_000)} +0000`;
}

function git(cwd: string, args: string[], atMs?: number): string {
  const env = atMs === undefined
    ? process.env
    : { ...process.env, GIT_COMMITTER_DATE: gitDate(atMs), GIT_AUTHOR_DATE: gitDate(atMs) };
  return execFileSync("git", args, { cwd, env, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function commit(cwd: string, file: string, content: string, atMs: number, messages: string[]): string {
  writeFileSync(path.join(cwd, file), content, "utf-8");
  git(cwd, ["add", file]);
  git(cwd, ["commit", "-q", ...messages.flatMap((message) => ["-m", message])], atMs);
  return git(cwd, ["rev-parse", "HEAD"]);
}

function branchExists(repo: string, branch: string): boolean {
  try {
    git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

const roots: string[] = [];

interface Fixture {
  repo: string;
  worktree: string;
  now: number;
  createdAt: string;
  oldSha: string;
  baseSha: string;
  branchSha: string;
}

/**
 * The KB-012 shape: `main` carries an old `feat(KB-900): …` commit 190 days older than the task,
 * later unrelated commits, and an unmerged task branch with one trailered commit checked out in a worktree.
 */
function buildRecycledIdFixture(opts: { oldCommitTrailer?: boolean; withWorktree?: boolean } = {}): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb112-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "wt-kb-900");
  mkdirSync(repo);
  const now = Date.now();
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  commit(repo, "readme.md", "init\n", now - 200 * DAY, ["init"]);
  const oldSha = commit(repo, "dashboard.ts", "export const paused = true;\n", now - 190 * DAY, [
    `feat(${TASK_ID}): add --paused flag to dashboard command`,
    ...(opts.oldCommitTrailer ? [`Fusion-Task-Id: ${TASK_ID}`] : []),
  ]);
  commit(repo, "later.ts", "export const later = 1;\n", now - 2 * HOUR, ["chore: later unrelated change"]);
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  commit(repo, "main-only.ts", "export const mainOnly = 1;\n", now - 30 * 60_000, ["chore: main moves on"]);
  git(repo, ["branch", BRANCH, baseSha]);
  let branchSha: string;
  if (opts.withWorktree === false) {
    git(repo, ["checkout", "-q", BRANCH]);
    branchSha = commit(repo, "work.ts", "export const work = 1;\n", now - 20 * 60_000, [
      `feat(${TASK_ID}): real work`,
      `Fusion-Task-Id: ${TASK_ID}\nFusion-Task-Lineage: ${LINEAGE}`,
    ]);
    git(repo, ["checkout", "-q", "main"]);
  } else {
    git(repo, ["worktree", "add", "-q", worktree, BRANCH]);
    branchSha = commit(worktree, "work.ts", "export const work = 1;\n", now - 20 * 60_000, [
      `feat(${TASK_ID}): real work`,
      `Fusion-Task-Id: ${TASK_ID}\nFusion-Task-Lineage: ${LINEAGE}`,
    ]);
  }
  return { repo, worktree, now, createdAt: new Date(now - HOUR).toISOString(), oldSha, baseSha, branchSha };
}

function makeTask(fixture: Fixture, overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    lineageId: LINEAGE,
    title: TASK_ID,
    description: TASK_ID,
    column: "in-review",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: fixture.createdAt,
    updatedAt: new Date(fixture.now - HOUR).toISOString(),
    baseBranch: "main",
    branch: BRANCH,
    worktree: fixture.worktree,
    baseCommitSha: fixture.baseSha,
    autoMerge: true,
    ...overrides,
  } as Task;
}

function withoutBase(task: Task): Task {
  const { baseCommitSha: _ignored, ...rest } = task;
  return rest as Task;
}

function createStore(tasks: Map<string, Task>): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  const settings = {
    globalPause: false,
    enginePaused: false,
    autoMerge: true,
    maintenanceIntervalMs: 0,
    taskStuckTimeoutMs: 60_000,
    defaultBaseBranch: "main",
  } as unknown as Settings;
  return Object.assign(emitter, {
    getSettings: vi.fn(async () => settings),
    listTasks: vi.fn(async ({ column }: { column?: string } = {}) => [...tasks.values()].filter((t) => !column || t.column === column)),
    getTask: vi.fn(async (id: string) => tasks.get(id)),
    updateTask: vi.fn(async (id: string, updates: Partial<Task>) => {
      const next = { ...tasks.get(id)!, ...updates } as Task;
      tasks.set(id, next);
      return next;
    }),
    logEntry: vi.fn(async (id: string, message: string) => {
      const cur = tasks.get(id)!;
      tasks.set(id, { ...cur, log: [...(cur.log ?? []), { timestamp: new Date().toISOString(), action: message }] } as Task);
    }),
    moveTask: vi.fn(async (id: string, column: string) => {
      const next = { ...tasks.get(id)!, column } as Task;
      tasks.set(id, next);
      return next;
    }),
    getBranchGroup: vi.fn(async () => null),
    walCheckpoint: vi.fn(() => ({ busy: 0, log: 0, checkpointed: 0 })),
    clearStaleExecutionStartBranchReferences: vi.fn(() => []),
    updateSettings: vi.fn(),
    mergeTask: vi.fn(),
    getRootDir: vi.fn(() => ""),
    recordRunAuditEvent: vi.fn(async () => undefined),
  }) as unknown as TaskStore & EventEmitter;
}

function setup(task: Task, repo: string) {
  const tasks = new Map([[task.id, task]]);
  const store = createStore(tasks);
  const enqueueMerge = vi.fn();
  const manager = new SelfHealingManager(store, {
    rootDir: repo,
    getExecutingTaskIds: () => new Set(),
    enqueueMerge,
    clearMergeActive: vi.fn(),
  });
  const findLanded = (target: Task, options?: { preferEarliestOwnedCommit?: boolean }) =>
    (manager as unknown as { findLandedTaskCommit: (t: Task, o?: unknown) => Promise<{ sha: string } | null> })
      .findLandedTaskCommit(target, options);
  return { tasks, store, manager, enqueueMerge, findLanded };
}

function updatesFor(store: TaskStore): Array<Partial<Task>> {
  return (store.updateTask as ReturnType<typeof vi.fn>).mock.calls
    .filter(([id]) => id === TASK_ID)
    .map(([, patch]) => patch as Partial<Task>);
}

function logMessages(store: TaskStore): string[] {
  return (store.logEntry as ReturnType<typeof vi.fn>).mock.calls.map(([, message]) => String(message));
}

function expectNotFinalized(store: TaskStore, fixture: Fixture): void {
  expect(store.moveTask).not.toHaveBeenCalled();
  expect(updatesFor(store).some((patch) => "mergeDetails" in patch)).toBe(false);
  expect(logMessages(store).some((message) => message.startsWith("Auto-recovered: merge deadlock resolved via landed commit"))).toBe(false);
  expect(branchExists(fixture.repo, BRANCH)).toBe(true);
  expect(existsSync(fixture.worktree)).toBe(true);
}

const baseVariants = [
  { name: "with baseCommitSha", strip: false },
  { name: "without baseCommitSha", strip: true },
] as const;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("landed-commit recovery rejects recycled task IDs (KB-012 shape)", () => {
  for (const variant of baseVariants) {
    describe(variant.name, () => {
      const shape = (fixture: Fixture, overrides: Partial<Task> = {}) => {
        const task = makeTask(fixture, overrides);
        return variant.strip ? withoutBase(task) : task;
      };

      it("N1 recoverStuckMergeDeadlocks does not finalize, keeps branch and worktree", async () => {
        const fixture = buildRecycledIdFixture();
        const { store, manager, findLanded } = setup(
          shape(fixture, { status: "failed", mergeRetries: 10, error: "AI merge failed: 429" }),
          fixture.repo,
        );
        await manager.recoverStuckMergeDeadlocks();

        expect(updatesFor(store).some((patch) => (patch.mergeDetails as { commitSha?: string } | undefined)?.commitSha === fixture.oldSha)).toBe(false);
        expectNotFinalized(store, fixture);
        expect(await findLanded(shape(fixture))).toBeNull();
        manager.stop();
      });

      it("N2 recoverInterruptedMergingTasks clears status and re-enqueues the merge", async () => {
        const fixture = buildRecycledIdFixture();
        const { store, manager, enqueueMerge } = setup(shape(fixture, { status: "merging" }), fixture.repo);

        await manager.recoverInterruptedMergingTasks();

        expectNotFinalized(store, fixture);
        expect(updatesFor(store)).toContainEqual({ status: null, error: null });
        expect(enqueueMerge).toHaveBeenCalledWith(TASK_ID);
        expect(logMessages(store)).toContain("Auto-recovered: stale merge status cleared; merge will be retried");
        manager.stop();
      });

      it("N3 recoverDoneTaskMergeMetadata does not repair a confirmed record pointing at the old commit", async () => {
        const fixture = buildRecycledIdFixture();
        const { store, manager } = setup(shape(fixture, {
          column: "done",
          mergeDetails: { commitSha: fixture.oldSha, mergeConfirmed: true },
        }), fixture.repo);

        await manager.recoverDoneTaskMergeMetadata();

        expect(updatesFor(store)).toEqual([]);
        manager.stop();
      });

      it("N5 a recycled Fusion-Task-Id trailer 190 days old is not a landing", async () => {
        const fixture = buildRecycledIdFixture({ oldCommitTrailer: true });
        const { manager, findLanded } = setup(shape(fixture), fixture.repo);

        expect(await findLanded(shape(fixture))).toBeNull();
        expect(await findLanded(shape(fixture), { preferEarliestOwnedCommit: true })).toBeNull();
        manager.stop();
      });

      it("classifyOwnedLandedEvidence never reports the old commit as owned", async () => {
        const fixture = buildRecycledIdFixture({ oldCommitTrailer: true });
        const task = shape(fixture);
        const live = await classifyOwnedLandedEvidence(fixture.repo, task, { mergeTargetBranch: "main" });
        expect(live.kind === "owned-commit" && live.commit.sha === fixture.oldSha).toBe(false);

        // Branch with zero unique commits (aheadCount 0).
        git(fixture.repo, ["worktree", "remove", "--force", fixture.worktree]);
        git(fixture.repo, ["branch", "-f", BRANCH, "main"]);
        const zeroAhead = await classifyOwnedLandedEvidence(fixture.repo, task, { mergeTargetBranch: "main" });
        expect(zeroAhead.kind === "owned-commit" && zeroAhead.commit.sha === fixture.oldSha).toBe(false);

        // Branch ref deleted.
        git(fixture.repo, ["branch", "-D", BRANCH]);
        const missing = await classifyOwnedLandedEvidence(fixture.repo, task, { mergeTargetBranch: "main" });
        expect(missing.kind === "owned-commit" && missing.commit.sha === fixture.oldSha).toBe(false);
      });
    });
  }

  it("N4 recoverDoneTaskMergeMetadata writes no record for the old commit and clears a stored one", async () => {
    const fixture = buildRecycledIdFixture();
    const noStored = setup(makeTask(fixture, { column: "done" }), fixture.repo);
    await noStored.manager.recoverDoneTaskMergeMetadata();
    expect(updatesFor(noStored.store).some((patch) => "mergeDetails" in patch)).toBe(false);
    noStored.manager.stop();

    for (const task of [makeTask(fixture, { column: "done" }), withoutBase(makeTask(fixture, { column: "done" }))]) {
      const stored = setup({ ...task, mergeDetails: { commitSha: fixture.oldSha } } as Task, fixture.repo);
      await stored.manager.recoverDoneTaskMergeMetadata();
      expect(updatesFor(stored.store)).toEqual([{ mergeDetails: undefined }]);
      stored.manager.stop();
    }
  });

  it("the already-merged detector does not attribute the old commit to an unmerged branch", async () => {
    const fixture = buildRecycledIdFixture();
    await expect(findAlreadyMergedTaskCommit({
      taskId: TASK_ID,
      lineageId: LINEAGE,
      repoDir: fixture.repo,
      baseBranch: "main",
      taskBranch: BRANCH,
      baseCommitSha: fixture.baseSha,
    })).resolves.toBeNull();
  });

  it("workspace tasks never reach findLandedTaskCommit", async () => {
    const fixture = buildRecycledIdFixture();
    const workspace = { workspaceWorktrees: { repo: { path: fixture.worktree } } } as unknown as Partial<Task>;
    for (const overrides of [
      { status: "failed", mergeRetries: 10 } as Partial<Task>,
      { status: "merging" } as Partial<Task>,
    ]) {
      const { manager } = setup(makeTask(fixture, { ...workspace, ...overrides }), fixture.repo);
      const spy = vi.spyOn(manager as never, "findLandedTaskCommit");
      await manager.recoverStuckMergeDeadlocks();
      await manager.recoverInterruptedMergingTasks();
      expect(spy).not.toHaveBeenCalled();
      manager.stop();
    }
  });
});

describe("landed-commit recovery still finds genuine landings", () => {
  function landOnMain(fixture: Fixture, atMs: number, messages: string[]): string {
    return commit(fixture.repo, "landed.ts", `export const landed = ${atMs};\n`, atMs, messages);
  }

  it("P1 a squash landing with trailers after the old commit finalizes the deadlock with the squash sha", async () => {
    const fixture = buildRecycledIdFixture();
    const squashSha = landOnMain(fixture, fixture.now - 10 * 60_000, [
      "Land the dashboard work",
      `Fusion-Task-Id: ${TASK_ID}\nFusion-Task-Lineage: ${LINEAGE}`,
    ]);
    for (const task of [makeTask(fixture), withoutBase(makeTask(fixture))]) {
      const { manager, findLanded } = setup(task, fixture.repo);
      expect((await findLanded(task))?.sha).toBe(squashSha);
      manager.stop();
    }

    const { store, manager } = setup(makeTask(fixture, { status: "failed", mergeRetries: 10 }), fixture.repo);
    await manager.recoverStuckMergeDeadlocks();
    expect(store.moveTask).toHaveBeenCalledWith(TASK_ID, "done", expect.anything());
    expect(updatesFor(store).find((patch) => patch.mergeDetails)?.mergeDetails?.commitSha).toBe(squashSha);
    manager.stop();
  });

  it("P2 a landing carrying only the lineage trailer is found", async () => {
    const fixture = buildRecycledIdFixture();
    const sha = landOnMain(fixture, fixture.now - 10 * 60_000, ["Land work", `Fusion-Task-Lineage: ${LINEAGE}`]);
    const { manager, findLanded } = setup(makeTask(fixture), fixture.repo);
    expect((await findLanded(makeTask(fixture)))?.sha).toBe(sha);
    expect((await findLanded(withoutBase(makeTask(fixture))))?.sha).toBe(sha);
    manager.stop();
  });

  it("P3 a trailered landing behind an advanced baseCommitSha is found by the full-HEAD re-scan", async () => {
    const fixture = buildRecycledIdFixture();
    const sha = landOnMain(fixture, fixture.now - 10 * 60_000, ["Land work", `Fusion-Task-Id: ${TASK_ID}`]);
    const advanced = commit(fixture.repo, "after.ts", "export const after = 1;\n", fixture.now - 5 * 60_000, ["chore: after landing"]);
    const task = makeTask(fixture, { baseCommitSha: advanced });
    const { manager, findLanded } = setup(task, fixture.repo);
    expect((await findLanded(task))?.sha).toBe(sha);
    manager.stop();
  });

  it("P4 a subject-only landing inside baseCommitSha..HEAD is found", async () => {
    const fixture = buildRecycledIdFixture();
    const sha = landOnMain(fixture, fixture.now - 10 * 60_000, [`feat(${TASK_ID}): landed work`]);
    const { manager, findLanded } = setup(makeTask(fixture), fixture.repo);
    expect((await findLanded(makeTask(fixture)))?.sha).toBe(sha);
    manager.stop();
  });

  it("P5 a recent subject-only landing outside the bounded range needs the task branch", async () => {
    const fixture = buildRecycledIdFixture({ withWorktree: false });
    git(fixture.repo, ["checkout", "-q", BRANCH]);
    git(fixture.repo, ["reset", "-q", "--hard", "main"]);
    const sha = commit(fixture.repo, "ff.ts", "export const ff = 1;\n", fixture.now - 10 * 60_000, [`feat(${TASK_ID}): fast-forwarded work`]);
    git(fixture.repo, ["checkout", "-q", "main"]);
    git(fixture.repo, ["merge", "-q", "--ff-only", BRANCH]);
    const task = withoutBase(makeTask(fixture));
    const { manager, findLanded } = setup(task, fixture.repo);
    expect((await findLanded(task))?.sha).toBe(sha);

    git(fixture.repo, ["branch", "-D", BRANCH]);
    expect(await findLanded(task)).toBeNull();
    manager.stop();
  });

  it("P6 the genuine landing wins over an old same-ID commit in either search order", async () => {
    const fixture = buildRecycledIdFixture({ oldCommitTrailer: true });
    const sha = landOnMain(fixture, fixture.now - 10 * 60_000, ["Land work", `Fusion-Task-Id: ${TASK_ID}`]);
    const task = withoutBase(makeTask(fixture, { lineageId: undefined }));
    const { manager, findLanded } = setup(task, fixture.repo);
    expect((await findLanded(task))?.sha).toBe(sha);
    expect((await findLanded(task, { preferEarliestOwnedCommit: true }))?.sha).toBe(sha);
    manager.stop();
  });

  it("P7 a trailered landing committed one hour before createdAt is inside the clock skew", async () => {
    const fixture = buildRecycledIdFixture();
    const sha = landOnMain(fixture, Date.parse(fixture.createdAt) - HOUR, ["Land work", `Fusion-Task-Id: ${TASK_ID}`]);
    const task = withoutBase(makeTask(fixture));
    const { manager, findLanded } = setup(task, fixture.repo);
    expect((await findLanded(task))?.sha).toBe(sha);
    manager.stop();
  });

  it("P8 a done task keeps an owned but unprovable stored commit", async () => {
    const fixture = buildRecycledIdFixture({ withWorktree: false });
    const sha = landOnMain(fixture, fixture.now - 10 * 60_000, [`feat(${TASK_ID}): landed work`]);
    git(fixture.repo, ["branch", "-D", BRANCH]);
    const task = withoutBase(makeTask(fixture, {
      column: "done",
      worktree: undefined,
      mergeDetails: { commitSha: sha, mergeConfirmed: false },
    }));
    const { store, manager } = setup(task, fixture.repo);

    await manager.recoverDoneTaskMergeMetadata();

    expect(updatesFor(store).some((patch) => "mergeDetails" in patch && patch.mergeDetails === undefined)).toBe(false);
    expect(logMessages(store).some((message) => message.startsWith("Done-task merge metadata kept"))).toBe(true);
    manager.stop();
  });

  it("classifyOwnedLandedEvidence reports a trailered cherry-picked landing as owned", async () => {
    const fixture = buildRecycledIdFixture({ oldCommitTrailer: true });
    git(fixture.repo, ["cherry-pick", fixture.branchSha]);
    const sha = git(fixture.repo, ["rev-parse", "HEAD"]);
    for (const task of [makeTask(fixture), withoutBase(makeTask(fixture))]) {
      const result = await classifyOwnedLandedEvidence(fixture.repo, task, { mergeTargetBranch: "main" });
      expect(result).toEqual(expect.objectContaining({ kind: "owned-commit", commit: expect.objectContaining({ sha }) }));
    }
  });
});
