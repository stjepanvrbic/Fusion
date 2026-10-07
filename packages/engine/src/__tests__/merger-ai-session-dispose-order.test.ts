/*
FNXC:AiMerge 2026-10-07-15:11:
The AI-merge clean room is removed in runAiMerge's finally. The merge agent's session used to be
disposed without awaiting, so cleanup raced the agent's still-exiting child processes (Windows:
"Directory not empty" on every AI merge). The merge must wait for disposal before cleanup, stay
bounded when disposal hangs, and keep its landed outcome independent of cleanup failures.
*/
import { afterAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const order = vi.hoisted(() => ({ events: [] as string[], failCleanup: false }));
const createResolvedAgentSessionMock = vi.hoisted(() => vi.fn());

vi.mock("../agents/agent-session-helpers.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../agents/agent-session-helpers.js")>(),
  createResolvedAgentSession: createResolvedAgentSessionMock,
}));
vi.mock("../pi.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../pi.js")>(),
  promptWithFallback: vi.fn(async (session: { prompt: (prompt: string) => Promise<void> }, prompt: string) => {
    await session.prompt(prompt);
  }),
}));
vi.mock("../merge/merger-ai-worktree.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../merge/merger-ai-worktree.js")>();
  return {
    ...actual,
    cleanupAiMergeWorktree: vi.fn(async (input: Parameters<typeof actual.cleanupAiMergeWorktree>[0]) => {
      order.events.push("cleanup");
      if (order.failCleanup) throw new Error("cleanup audit sink exploded");
      return actual.cleanupAiMergeWorktree(input);
    }),
  };
});

import { __test__, runAiMerge } from "../merge/merger-ai.js";
import { AGENT_SESSION_DISPOSE_TIMEOUT_MS } from "../agents/dispose-agent-session.js";
import { withBranchWriteProvenance } from "./branch-write-provenance-store-stub.js";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.t" };
const tracked: string[] = [];

afterAll(() => {
  for (const dir of tracked) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", env: GIT_ENV, stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function repoWithTaskBranch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fusion-ai-merge-dispose-")));
  tracked.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "base.txt"), "base\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  git(dir, ["checkout", "-q", "-b", "fusion/fn-1"]);
  writeFileSync(join(dir, "feature.txt"), "feature\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "feat: work"]);
  git(dir, ["checkout", "-q", "main"]);
  return dir;
}

function makeStore() {
  const task: any = {
    id: "FN-1", column: "in-review", status: null, branch: "fusion/fn-1", worktree: null, title: "t", steps: [],
    enabledWorkflowSteps: [], baseBranch: undefined,
  };
  const store: any = {
    getTask: vi.fn(async () => task),
    getStaleReviewCallbackWaiverReceipts: vi.fn().mockResolvedValue([]),
    getProjectId: vi.fn().mockReturnValue("test-project"),
    getSettings: vi.fn(async () => ({ merger: { mode: "ai", maxReviewPasses: 1 } })),
    updateTask: vi.fn(withBranchWriteProvenance(async (_id: string, patch: Record<string, unknown>) => { Object.assign(task, patch); return task; })),
    updateTaskAtomic: vi.fn(async (_id: string, updater: (current: typeof task) => Record<string, unknown> | undefined) => {
      const patch = await updater(task);
      if (patch) Object.assign(task, patch);
      return task;
    }),
    moveTask: vi.fn(async (_id: string, column: string) => { task.column = column; return task; }),
    moveTaskIf: vi.fn(async (_id: string, column: string, predicate: (live: typeof task) => boolean | Promise<boolean>) => {
      if (!await predicate(task)) return { moved: false, task };
      task.column = column;
      return { moved: true, task };
    }),
    emit: vi.fn(),
    logEntry: vi.fn(async () => undefined),
    appendAgentLog: vi.fn(async () => undefined),
    emitUsageEvent: vi.fn().mockResolvedValue(undefined),
    getBranchGroup: vi.fn(() => null),
    listTasksByBranchGroup: vi.fn(async () => [task]),
    recordRunAuditEvent: vi.fn(),
  };
  return store;
}

function mergeSession(dispose: () => unknown) {
  return {
    async prompt() {
      const cwd = createResolvedAgentSessionMock.mock.calls.at(-1)?.[0]?.cwd as string;
      git(cwd, ["merge", "--squash", "fusion/fn-1"]);
      git(cwd, ["commit", "-q", "-m", "squash: feature"]);
      order.events.push("prompted");
    },
    dispose,
    getSessionStats: vi.fn(() => ({ tokens: { input: 1, output: 1 } })),
  };
}

describe("AI merge agent sessions are disposed before the agent call returns", () => {
  const audit = { git: vi.fn(async () => undefined), database: vi.fn(async () => undefined), filesystem: vi.fn(async () => undefined), sandbox: vi.fn(async () => undefined) } as never;

  function deferredDispose() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const dispose = vi.fn(() => gate.then(() => { order.events.push("disposed"); }));
    return { dispose, release };
  }

  async function flushTurns(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  }

  it.each(["merge", "review"] as const)("the %s agent waits for an asynchronous dispose", async (kind) => {
    order.events = [];
    const { dispose, release } = deferredDispose();
    createResolvedAgentSessionMock.mockImplementation(async (opts: { onText?: (delta: string) => void }) => ({
      session: {
        async prompt() { opts.onText?.("REVIEW_VERDICT: approve"); order.events.push("prompted"); },
        dispose,
        getSessionStats: vi.fn(() => ({ tokens: { input: 1, output: 1 } })),
      },
    }));
    const store = makeStore();
    const agent = kind === "merge"
      ? __test__.makeMutatingAgent(store, {} as never, "FN-1", {}, audit, "system")
      : __test__.makeReviewAgent(store, {} as never, "FN-1", {}, audit);
    let returned = false;
    const call = (agent as (cwd: string, prompt: string) => Promise<unknown>)(process.cwd(), "go").then((value) => { returned = true; return value; });

    await flushTurns();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(returned).toBe(false);
    release();
    await call;
    expect(order.events).toEqual(["prompted", "disposed"]);
  });

  it("returns after the bound when dispose never settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      createResolvedAgentSessionMock.mockImplementation(async () => ({
        session: { async prompt() {}, dispose: () => new Promise<void>(() => undefined), getSessionStats: vi.fn(() => ({ tokens: { input: 1, output: 1 } })) },
      }));
      let returned = false;
      const call = __test__.makeMutatingAgent(makeStore(), {} as never, "FN-1", {}, audit, "system")(process.cwd(), "go")
        .then(() => { returned = true; });
      await vi.advanceTimersByTimeAsync(AGENT_SESSION_DISPOSE_TIMEOUT_MS - 1);
      expect(returned).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await call;
      expect(returned).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AI merge clean-room cleanup cannot change a landed outcome", () => {
  it("keeps a landed merge when clean-room cleanup throws", async () => {
    order.events = [];
    order.failCleanup = true;
    const dir = repoWithTaskBranch();
    createResolvedAgentSessionMock.mockImplementation(async () => ({ session: mergeSession(vi.fn()) }));

    const result = await runAiMerge(makeStore(), dir, "FN-1", { manual: true }, {
      reviewAgent: async () => "REVIEW_VERDICT: approve",
    });

    order.failCleanup = false;
    expect(result).toMatchObject({ merged: true });
    expect(order.events).toContain("cleanup");
    expect(git(dir, ["show", "main:feature.txt"])).toBe("feature");
  });
});
