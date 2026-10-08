import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileScopeViolationError, readMechanicalSquashFiles } from "../merge/merger-file-scope.js";
import { preflightAiMergeSquashFileScope, resolveRepoDeclaredScopeTransform } from "../merge/merger-ai-squash-gates.js";
import { extractEffectiveWriteScopeFromPrompt } from "@fusion/core";

const policy = vi.hoisted(() => vi.fn());
vi.mock("../merge/merge-trait.js", () => ({ resolveMergePolicy: policy }));

import { resolveAiMergeRoot, runAiMerge } from "../merge/merger-ai.js";

const dirs: string[] = [];
afterEach(() => {
  policy.mockReset();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf8" }).trim();
}

function createRepo(change: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "fusion-ai-squash-gates-"));
  dirs.push(dir);
  git(dir, "init -q -b main");
  git(dir, "config user.email test@example.com");
  git(dir, "config user.name Test");
  writeFileSync(join(dir, "base.txt"), "base\n");
  git(dir, "add -A && git commit -q -m base");
  git(dir, "checkout -q -b fusion/fn-9050");
  change(dir);
  git(dir, "add -A && git commit -q -m feature");
  git(dir, "checkout -q main");
  return dir;
}

function makeStore(scope: string[], overrides: Record<string, unknown> = {}) {
  const task: any = {
    /* FNXC:RequiredPreMergeSteps 2026-08-23-00:20: merge-mechanics fixture, not a review-gating one.
       The door refuses a card whose enabled optional pre-merge groups produced no result, and the
       built-in workflow enables Plan and Code Review by default, so an unspecified list failed the
       door before the behaviour under test ran. An explicit empty list states the intent. */
    enabledWorkflowSteps: [],
    id: "FN-9050", title: "squash gates", column: "in-review", branch: "fusion/fn-9050",
    comments: [], steeringComments: [], steps: [], log: [], ...overrides,
  };
  const store: any = {
    getTask: vi.fn(async () => task),
    getStaleReviewCallbackWaiverReceipts: vi.fn().mockResolvedValue([]),
    getProjectId: vi.fn().mockReturnValue("test-project"),
    getSettings: vi.fn(async () => ({ merger: { mode: "ai", maxReviewPasses: 0 } })),
    parseFileScopeFromPrompt: vi.fn(async () => scope),
    updateTask: vi.fn(async (_id: string, patch: object) => Object.assign(task, patch)),
    /* FNXC:MergerAiReview 2026-08-22-22:20: FN-159 reconciliation persists every candidate and verdict through the production atomic CAS seam, so this mutable store double must apply its callback patch to the same task returned by getTask. */
    updateTaskAtomic: vi.fn(async (_id: string, mutate: (current: typeof task) => Partial<typeof task> | undefined) => {
      const patch = mutate(task);
      if (patch) Object.assign(task, patch);
      return task;
    }),
    moveTask: vi.fn(async (_id: string, column: string) => Object.assign(task, { column })),
    /*
    FNXC:PostMergeFinalizationFixture 2026-09-23-11:20:
    FN-9370 finalization uses the durable conditional-move fence. Squash-gate tests must
    evaluate its live predicate, so their real merge path cannot bypass post-merge evidence.
    */
    moveTaskIf: vi.fn(async (_id: string, column: string, predicate: (live: typeof task) => boolean | Promise<boolean>, options?: unknown) => {
      if (!await predicate(task)) return { moved: false, task };
      return { moved: true, task: await store.moveTask(_id, column, options) };
    }),
    appendAgentLog: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    emit: vi.fn(),
    recordRunAuditEvent: vi.fn(async () => undefined),
    upsertTaskCommitAssociation: vi.fn(async () => undefined),
    accumulateTokenUsage: vi.fn(async () => undefined),
  };
  return { store, task };
}

function squashAgent(branch: string, mutate?: (cwd: string) => void) {
  return async (cwd: string): Promise<void> => {
    git(cwd, `merge --squash ${branch}`);
    mutate?.(cwd);
    git(cwd, "add -A && git commit -q -m squash");
  };
}

const approve = async () => "REVIEW_VERDICT: approve";

function setPolicy(mode: "strict" | "warn" | "off" = "strict"): void {
  policy.mockResolvedValue({ fileScope: mode, fileScopeRules: [] });
}

describe("resolveRepoDeclaredScopeTransform", () => {
  it("derives repo-local paths and keeps unprefixed scopes as a fallback", () => {
    const scoped = resolveRepoDeclaredScopeTransform({ repoRel: "apps/web", repoKeys: ["apps", "apps/web", "api"] });
    expect(scoped.transform(["./apps/web/src/**", "api/src/**"])).toEqual(["src/**"]);
    expect(scoped.describe(["./apps/web/src/**", "api/src/**"])).toBe("repo-subset");
    expect(scoped.transform(["src/**"])).toEqual(["src/**"]);
    expect(scoped.describe(["src/**"])).toBe("unprefixed-fallback");
  });

  it("identifies declarations owned solely by another repository", () => {
    const transform = resolveRepoDeclaredScopeTransform({ repoRel: "repo-b", repoKeys: ["repo-a", "repo-b"] });
    expect(transform.transform(["repo-a/src/**"])).toEqual([]);
    expect(transform.describe(["repo-a/src/**"])).toBe("foreign-repo-only");
  });
});

/*
FNXC:FileScopeInvariant 2026-10-08-08:58:
KB-058: the pre-review check reads the branch's mechanical squash without a clean room. These run with real git
(the invariant unit file mocks child_process), covering clean, conflicting, already-landed, and unknown-ref branches.
*/
describe("readMechanicalSquashFiles", () => {
  it("returns the files a clean branch squash touches", async () => {
    const dir = createRepo((root) => {
      mkdirSync(join(root, "allowed"), { recursive: true });
      writeFileSync(join(root, "allowed", "a.txt"), "a\n");
      writeFileSync(join(root, "outside.txt"), "o\n");
    });
    const files = await readMechanicalSquashFiles(dir, git(dir, "rev-parse main"), "fusion/fn-9050");
    expect(files?.sort()).toEqual(["allowed/a.txt", "outside.txt"]);
  });

  it("includes conflicted files when both sides edit the same file", async () => {
    const dir = createRepo((root) => writeFileSync(join(root, "base.txt"), "branch\n"));
    writeFileSync(join(dir, "base.txt"), "main\n");
    git(dir, "commit -q -am main-edit");
    const files = await readMechanicalSquashFiles(dir, git(dir, "rev-parse main"), "fusion/fn-9050");
    expect(files).toContain("base.txt");
  });

  it("returns an empty list when the branch change is already on the tip", async () => {
    const dir = createRepo((root) => writeFileSync(join(root, "outside.txt"), "o\n"));
    git(dir, "merge -q --no-edit fusion/fn-9050");
    await expect(readMechanicalSquashFiles(dir, git(dir, "rev-parse main"), "fusion/fn-9050")).resolves.toEqual([]);
  });

  it("returns null for an unknown ref so the caller fails open", async () => {
    const dir = createRepo((root) => writeFileSync(join(root, "outside.txt"), "o\n"));
    await expect(readMechanicalSquashFiles(dir, git(dir, "rev-parse main"), "fusion/does-not-exist")).resolves.toBeNull();
  });
});

describe("preflightAiMergeSquashFileScope", () => {
  function audit() {
    return { git: vi.fn(async () => undefined) } as any;
  }

  it("skips and logs when the squash file list is unavailable", async () => {
    setPolicy("strict");
    const { store, task } = makeStore(["allowed/**"]);
    const log = vi.fn(async () => undefined);
    await expect(preflightAiMergeSquashFileScope({
      store, task, taskId: "FN-9050", repoRootDir: "/unused", branch: "b", tipSha: "t", audit: audit(), log,
      squashFilesReader: async () => null,
    })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("AI merge: pre-review file-scope check skipped \u2014 squash file list unavailable; the post-review check decides");
    expect(store.parseFileScopeFromPrompt).not.toHaveBeenCalled();
  });

  it("fails open to the post-review check on a non-violation error", async () => {
    policy.mockRejectedValue(new Error("policy unavailable"));
    const { store, task } = makeStore(["allowed/**"]);
    const log = vi.fn(async () => undefined);
    await expect(preflightAiMergeSquashFileScope({
      store, task, taskId: "FN-9050", repoRootDir: "/unused", branch: "b", tipSha: "t", audit: audit(), log,
      squashFilesReader: async () => ["outside.txt"],
    })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("policy unavailable"));
  });

  it("refuses a strict violation and clears the reconciliation record", async () => {
    setPolicy("strict");
    const { store, task } = makeStore(["allowed/**"], { aiMergeReviewReconciliation: { candidateSha: "abc" } });
    await expect(preflightAiMergeSquashFileScope({
      store, task, taskId: "FN-9050", repoRootDir: "/unused", branch: "b", tipSha: "t", audit: audit(), log: vi.fn(async () => undefined),
      squashFilesReader: async () => ["outside.txt"],
    })).rejects.toBeInstanceOf(FileScopeViolationError);
    expect(task.aiMergeReviewReconciliation).toBeNull();
  });

  it("still surfaces the violation when clearing the reconciliation record fails", async () => {
    setPolicy("strict");
    const { store, task } = makeStore(["allowed/**"]);
    store.updateTask.mockRejectedValue(new Error("store down"));
    await expect(preflightAiMergeSquashFileScope({
      store, task, taskId: "FN-9050", repoRootDir: "/unused", branch: "b", tipSha: "t", audit: audit(), log: vi.fn(async () => undefined),
      squashFilesReader: async () => ["outside.txt"],
    })).rejects.toBeInstanceOf(FileScopeViolationError);
  });
});

describe("runAiMerge approved-squash gates", () => {
  /*
  FNXC:FileScopeInvariant 2026-10-08-05:09:
  Symptom (KB-008): an approved squash inside the declared File Scope was refused because an earlier bullet's "(only if ...)" qualifier removed every later bullet from the parsed scope.
  Reproduction: a strict real-git merge whose scope is parsed from a PROMPT of that shape by the production classifier. Assertion: the squash lands on main and no violation is recorded.
  */
  it("lands an approved squash covered by a bullet that follows a conditional bullet", async () => {
    setPolicy("strict");
    const prompt = [
      "## File Scope",
      "",
      "- `packages/engine/src/worktree/worktree-pool.ts` (only if the root cause is a probe defect)",
      "- `packages/dashboard/src/__tests__/task-reset-workspace-lifecycle.test.ts` (modified)",
      "- `packages/dashboard/src/__tests__/task-reset-lifecycle.test.ts` (check if affected)",
      "- `packages/engine/src/__tests__/reliability-interactions/_helpers.ts` (only if the fixture is proven stale)",
      "- `packages/core/src/**/*.ts` (limited to the failing test files and their product code)",
      "- `.changeset/kb-008.md` (only if a product behavior fix ships)",
      "",
      "## Steps",
    ].join("\n");
    const dir = createRepo((root) => {
      mkdirSync(join(root, "packages/core/src/process"), { recursive: true });
      writeFileSync(join(root, "packages/core/src/process/process-supervisor.ts"), "export const fixed = true;\n");
    });
    const before = git(dir, "rev-parse main");
    const { store } = makeStore(extractEffectiveWriteScopeFromPrompt(prompt));

    const result = await runAiMerge(store, dir, "FN-9050", { manual: true }, {
      mergeAgent: squashAgent("fusion/fn-9050"), reviewAgent: approve,
    });

    expect(result.merged).toBe(true);
    expect(git(dir, "rev-parse main")).not.toBe(before);
    expect(git(dir, "show --name-only --format= main")).toContain("packages/core/src/process/process-supervisor.ts");
    expect(store.recordRunAuditEvent.mock.calls.some(([event]: any[]) => event.mutationType === "merge:file-scope-violation")).toBe(false);
  });

  it("blocks a strict out-of-scope squash before main advances and records the violation", async () => {
    setPolicy();
    const dir = createRepo((root) => writeFileSync(join(root, "outside.txt"), "outside\n"));
    const before = git(dir, "rev-parse main");
    const { store } = makeStore(["allowed/**"]);

    await expect(runAiMerge(store, dir, "FN-9050", { manual: true }, {
      mergeAgent: squashAgent("fusion/fn-9050"), reviewAgent: approve,
    })).rejects.toBeInstanceOf(FileScopeViolationError);

    expect(git(dir, "rev-parse main")).toBe(before);
    expect(store.recordRunAuditEvent.mock.calls.some(([event]: any[]) => event.mutationType === "merge:file-scope-violation")).toBe(true);
  });

  it.each([
    ["warn", false, "merge:file-scope-violation"],
    ["off", false, "merge:file-scope-enforcement-disabled"],
    ["strict", true, "merge:ai-landed"],
  ] as const)("preserves %s and scopeOverride file-scope behavior", async (mode, scopeOverride, auditType) => {
    setPolicy(mode);
    const dir = createRepo((root) => writeFileSync(join(root, "outside.txt"), "outside\n"));
    const { store } = makeStore(["allowed/**"], scopeOverride ? { scopeOverride: true } : {});

    const result = await runAiMerge(store, dir, "FN-9050", { manual: true }, {
      mergeAgent: squashAgent("fusion/fn-9050"), reviewAgent: approve,
    });

    expect(result.merged).toBe(true);
    expect(store.recordRunAuditEvent.mock.calls.some(([event]: any[]) => event.mutationType === auditType)).toBe(true);
    if (scopeOverride) expect(store.appendAgentLog).toHaveBeenCalledWith("FN-9050", expect.stringContaining("scopeOverride"), "status", undefined, "merger");
  });

  /*
  FNXC:FileScopeInvariant 2026-10-07-18:10:
  A sibling of a declared file is not an overlap, and `custom` rules are enforced like a declared File Scope.
  Neither may advance main.
  */
  it.each([
    ["strict with a sibling of the declared file", { fileScope: "strict", fileScopeRules: [] }, ["allowed/a.txt"]],
    ["custom rules that miss the squash", { fileScope: "custom", fileScopeRules: ["elsewhere/**"] }, ["allowed/**"]],
  ] as const)("blocks %s before main advances", async (_label, resolvedPolicy, scope) => {
    policy.mockResolvedValue(resolvedPolicy);
    const dir = createRepo((root) => {
      mkdirSync(join(root, "allowed"), { recursive: true });
      writeFileSync(join(root, "allowed", "b.txt"), "sibling\n");
    });
    const before = git(dir, "rev-parse main");
    const { store } = makeStore([...scope]);

    await expect(runAiMerge(store, dir, "FN-9050", { manual: true }, {
      mergeAgent: squashAgent("fusion/fn-9050"), reviewAgent: approve,
    })).rejects.toBeInstanceOf(FileScopeViolationError);
    expect(git(dir, "rev-parse main")).toBe(before);
  });

  it("lands when custom rules cover the squash", async () => {
    policy.mockResolvedValue({ fileScope: "custom", fileScopeRules: ["allowed/**"] });
    const dir = createRepo((root) => {
      mkdirSync(join(root, "allowed"), { recursive: true });
      writeFileSync(join(root, "allowed", "b.txt"), "inside\n");
    });
    const { store } = makeStore(["unrelated/**"]);
    await expect(runAiMerge(store, dir, "FN-9050", { manual: true }, {
      mergeAgent: squashAgent("fusion/fn-9050"), reviewAgent: approve,
    })).resolves.toMatchObject({ merged: true });
  });

  it("resets a recovered strict scope violation so a retry does not select it again", async () => {
    setPolicy();
    const dir = createRepo((root) => writeFileSync(join(root, "outside.txt"), "outside\n"));
    const before = git(dir, "rev-parse main");
    const cleanRoomParent = resolveAiMergeRoot(dir);
    mkdirSync(cleanRoomParent, { recursive: true });
    const cleanRoom = mkdtempSync(join(cleanRoomParent, "fusion-ai-merge-fn-9050-"));
    git(dir, `worktree add --detach ${cleanRoom} ${before}`);
    git(cleanRoom, "merge --squash fusion/fn-9050");
    git(cleanRoom, "add -A && git commit -q -m squash -m 'Fusion-Task-Id: FN-9050'");
    const squashSha = git(cleanRoom, "rev-parse HEAD");
    const { store, task } = makeStore(["allowed/**"]);
    /*
    FNXC:AIMergeReviewReconciliation 2026-08-23-21:50:
    FN-090 (f714e45bda) made the DURABLE reconciliation record the sole authority for reviving a
    pre-existing clean room: recovery admits only a twice-confirmed candidate whose source and
    integration identities still match. Task-log prose is audit history and is deliberately no
    longer sufficient, so this fixture states the approval the way the product now records it —
    seeding the old log line instead meant recovery selected nothing and the merge agent ran.
    */
    task.aiMergeReviewReconciliation = {
      sourceSha: git(dir, "rev-parse --verify fusion/fn-9050"),
      integrationTipSha: before,
      candidateSha: squashSha,
      candidateTreeSha: git(cleanRoom, "rev-parse HEAD^{tree}"),
      findings: [],
      consecutiveCleanApprovals: 2,
      correctivePasses: 0,
    };

    await expect(runAiMerge(store, dir, "FN-9050", { manual: true }, {
      mergeAgent: async () => { throw new Error("recovery should not re-merge"); }, reviewAgent: approve,
    })).rejects.toBeInstanceOf(FileScopeViolationError);

    expect(git(cleanRoom, "rev-parse HEAD")).toBe(before);
    task.status = null;
    /*
    FNXC:FileScopeInvariant 2026-10-08-08:58:
    KB-058: the retry no longer reaches the merge agent at all. The out-of-scope branch is refused by the pre-review
    check before a clean room is built, so the rejected candidate is never re-selected and no merge session is spent.
    */
    const normalMerge = vi.fn(async () => { throw new Error("normal merge invoked"); });
    await expect(runAiMerge(store, dir, "FN-9050", { manual: true }, {
      mergeAgent: normalMerge, reviewAgent: approve,
    })).rejects.toBeInstanceOf(FileScopeViolationError);
    expect(normalMerge).not.toHaveBeenCalled();
    expect(task.aiMergeReviewReconciliation ?? null).toBeNull();
  });
});

/*
FNXC:FileScopeInvariant 2026-10-08-08:58:
Symptom (KB-008/KB-058): a genuinely out-of-scope squash ran full AI merge and review cycles before the post-review
check parked it. Reproduction: strict policy, branch adds only `outside.txt`, scope `allowed/**`, spy agents.
Assertion: the merge rejects with FileScopeViolationError while neither agent ran, no clean room was built, main is
unchanged, and exactly one violation row carries `scopeCheckPhase:"pre-review"`. Every waiver mode keeps its single row.
*/
describe("runAiMerge pre-review file-scope check", () => {
  function auditRows(store: any, type: string): any[] {
    return store.recordRunAuditEvent.mock.calls.map(([event]: any[]) => event).filter((event: any) => event.mutationType === type);
  }

  function spies(mutate?: (cwd: string) => void) {
    return {
      mergeAgent: vi.fn(squashAgent("fusion/fn-9050", mutate)),
      reviewAgent: vi.fn(approve),
    };
  }

  function inScopeRepo(): string {
    return createRepo((root) => {
      mkdirSync(join(root, "allowed"), { recursive: true });
      writeFileSync(join(root, "allowed", "a.txt"), "inside\n");
    });
  }

  it("refuses an out-of-scope squash before any merge agent, reviewer, or clean room", async () => {
    setPolicy("strict");
    const dir = createRepo((root) => writeFileSync(join(root, "outside.txt"), "outside\n"));
    const before = git(dir, "rev-parse main");
    const { store } = makeStore(["allowed/**"]);
    const agents = spies();

    await expect(runAiMerge(store, dir, "FN-9050", { manual: true }, agents)).rejects.toBeInstanceOf(FileScopeViolationError);

    expect(agents.mergeAgent).not.toHaveBeenCalled();
    expect(agents.reviewAgent).not.toHaveBeenCalled();
    expect(auditRows(store, "merge:ai-clean-room")).toHaveLength(0);
    expect(git(dir, "rev-parse main")).toBe(before);
    const violations = auditRows(store, "merge:file-scope-violation");
    expect(violations).toHaveLength(1);
    expect(violations[0].metadata.scopeCheckPhase).toBe("pre-review");
  });

  it("lands an in-scope strict squash through the agents", async () => {
    setPolicy("strict");
    const dir = inScopeRepo();
    const { store } = makeStore(["allowed/**"]);
    const agents = spies();
    await expect(runAiMerge(store, dir, "FN-9050", { manual: true }, agents)).resolves.toMatchObject({ merged: true });
    expect(agents.mergeAgent).toHaveBeenCalled();
    expect(agents.reviewAgent).toHaveBeenCalled();
    expect(auditRows(store, "merge:file-scope-violation")).toHaveLength(0);
  });

  it("lands a scopeOverride squash and logs the bypass exactly once", async () => {
    setPolicy("strict");
    const dir = createRepo((root) => writeFileSync(join(root, "outside.txt"), "outside\n"));
    const { store } = makeStore(["allowed/**"], { scopeOverride: true });
    const agents = spies();
    await expect(runAiMerge(store, dir, "FN-9050", { manual: true }, agents)).resolves.toMatchObject({ merged: true });
    expect(agents.mergeAgent).toHaveBeenCalled();
    const bypassLogs = store.appendAgentLog.mock.calls.filter(([, message]: any[]) => String(message).includes("bypassed via scopeOverride"));
    expect(bypassLogs).toHaveLength(1);
  });

  it("lands with an empty declared scope", async () => {
    setPolicy("strict");
    const dir = createRepo((root) => writeFileSync(join(root, "outside.txt"), "outside\n"));
    const { store } = makeStore([]);
    const agents = spies();
    await expect(runAiMerge(store, dir, "FN-9050", { manual: true }, agents)).resolves.toMatchObject({ merged: true });
    expect(agents.mergeAgent).toHaveBeenCalled();
  });

  it("keeps exactly one warning row under warn", async () => {
    setPolicy("warn");
    const dir = createRepo((root) => writeFileSync(join(root, "outside.txt"), "outside\n"));
    const { store } = makeStore(["allowed/**"]);
    await expect(runAiMerge(store, dir, "FN-9050", { manual: true }, spies())).resolves.toMatchObject({ merged: true });
    const rows = auditRows(store, "merge:file-scope-violation");
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata.warningOnly).toBe(true);
    expect(rows[0].metadata).not.toHaveProperty("scopeCheckPhase");
  });

  it("keeps exactly one enforcement-disabled row under off", async () => {
    setPolicy("off");
    const dir = createRepo((root) => writeFileSync(join(root, "outside.txt"), "outside\n"));
    const { store } = makeStore(["allowed/**"]);
    await expect(runAiMerge(store, dir, "FN-9050", { manual: true }, spies())).resolves.toMatchObject({ merged: true });
    expect(auditRows(store, "merge:file-scope-enforcement-disabled")).toHaveLength(1);
  });

  it("refuses custom rules that miss the branch before any agent runs, and lands when they cover it", async () => {
    policy.mockResolvedValue({ fileScope: "custom", fileScopeRules: ["elsewhere/**"] });
    const refused = inScopeRepo();
    const refusedAgents = spies();
    await expect(runAiMerge(makeStore(["allowed/**"]).store, refused, "FN-9050", { manual: true }, refusedAgents)).rejects.toBeInstanceOf(FileScopeViolationError);
    expect(refusedAgents.mergeAgent).not.toHaveBeenCalled();
    expect(refusedAgents.reviewAgent).not.toHaveBeenCalled();

    policy.mockResolvedValue({ fileScope: "custom", fileScopeRules: ["allowed/**"] });
    const covered = inScopeRepo();
    await expect(runAiMerge(makeStore(["unrelated/**"]).store, covered, "FN-9050", { manual: true }, spies())).resolves.toMatchObject({ merged: true });
  });

  it("keeps the post-review check as the invariant of record when the merge agent authors out-of-scope work", async () => {
    setPolicy("strict");
    const dir = inScopeRepo();
    const before = git(dir, "rev-parse main");
    const { store } = makeStore(["allowed/**"]);
    const mergeAgent = vi.fn(async (cwd: string) => {
      writeFileSync(join(cwd, "outside.txt"), "agent\n");
      git(cwd, "add -A && git commit -q -m squash");
    });
    const reviewAgent = vi.fn(approve);

    await expect(runAiMerge(store, dir, "FN-9050", { manual: true }, { mergeAgent, reviewAgent })).rejects.toBeInstanceOf(FileScopeViolationError);

    expect(reviewAgent).toHaveBeenCalled();
    expect(git(dir, "rev-parse main")).toBe(before);
    const rows = auditRows(store, "merge:file-scope-violation");
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).not.toHaveProperty("scopeCheckPhase");
  });

  it("refuses a seeded reconciliation candidate pre-review and clears the record", async () => {
    setPolicy("strict");
    const dir = createRepo((root) => writeFileSync(join(root, "outside.txt"), "outside\n"));
    const before = git(dir, "rev-parse main");
    const { store, task } = makeStore(["allowed/**"]);
    task.aiMergeReviewReconciliation = {
      sourceSha: git(dir, "rev-parse --verify fusion/fn-9050"),
      integrationTipSha: before,
      candidateSha: "0".repeat(40),
      candidateTreeSha: "0".repeat(40),
      findings: [],
      consecutiveCleanApprovals: 1,
      correctivePasses: 0,
    };
    const agents = spies();

    await expect(runAiMerge(store, dir, "FN-9050", { manual: true }, agents)).rejects.toBeInstanceOf(FileScopeViolationError);

    expect(agents.mergeAgent).not.toHaveBeenCalled();
    expect(agents.reviewAgent).not.toHaveBeenCalled();
    expect(task.aiMergeReviewReconciliation).toBeNull();
  });
});
