import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS, type MergeResult, type Task } from "@fusion/core";
import { createMockStore, mockedExecSync } from "./merger-test-helpers.js";
import {
  assertSquashOverlapsFileScope,
  attemptWithSideStrategy,
  commitOrAmendMergeWithFixes,
  enforceSquashFileScopeInvariant,
  executeMergeAttempt,
  FileScopeViolationError,
} from "../merger.js";

/*
FNXC:FileScopeInvariant 2026-10-08-08:58:
KB-058 phase tests need `warn`/`off`/`custom` modes. Pass through to the real resolver unless a test sets an override.
*/
const policyOverride = vi.hoisted(() => ({ value: undefined as undefined | { fileScope: string; fileScopeRules: string[] } }));
vi.mock("../merge/merge-trait.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../merge/merge-trait.js")>();
  return {
    ...actual,
    resolveMergePolicy: async (...args: Parameters<typeof actual.resolveMergePolicy>) =>
      policyOverride.value ?? actual.resolveMergePolicy(...args),
  };
});

function createInvariantStore(scope: string[], taskOverrides: Record<string, unknown> = {}) {
  const store = createMockStore(taskOverrides) as unknown as {
    parseFileScopeFromPrompt: ReturnType<typeof vi.fn>;
    appendAgentLog: ReturnType<typeof vi.fn>;
    moveTask: ReturnType<typeof vi.fn>;
    updateTask: ReturnType<typeof vi.fn>;
    logEntry: ReturnType<typeof vi.fn>;
  };
  store.parseFileScopeFromPrompt = vi.fn().mockResolvedValue(scope);
  store.appendAgentLog = vi.fn().mockResolvedValue(undefined);
  store.moveTask = vi.fn().mockResolvedValue(undefined);
  store.updateTask = vi.fn().mockResolvedValue(undefined);
  store.logEntry = vi.fn().mockResolvedValue(undefined);
  return store;
}

function createMergeResult(): MergeResult {
  const task: Task = {
    id: "FN-4073",
    description: "Test task",
    column: "in-review",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  return {
    task,
    branch: "fn/fn-4073",
    merged: false,
    worktreeRemoved: false,
    branchDeleted: false,
  };
}

let stagedFilesReader: (cwd: string) => Promise<string[]> = vi.fn(async () => []);

function mockStagedFiles(files: string[]) {
  stagedFilesReader = vi.fn(async (_cwd: string) => files);
}

describe("assertSquashOverlapsFileScope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStagedFiles([]);
  });

  it("passes without logging when no declared scope exists", async () => {
    const store = createInvariantStore([]);
    mockStagedFiles(["packages/engine/src/merger.ts"]);

    await expect(assertSquashOverlapsFileScope({
      store: store as never,
      taskId: "FN-4073",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
    })).resolves.toBeUndefined();

    expect(store.appendAgentLog).not.toHaveBeenCalled();
  });

  it("passes without logging when staged files fully overlap scope", async () => {
    const store = createInvariantStore(["packages/engine/src/merger.ts"]);
    mockStagedFiles(["packages/engine/src/merger.ts"]);

    await expect(assertSquashOverlapsFileScope({
      store: store as never,
      taskId: "FN-4073",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
    })).resolves.toBeUndefined();

    expect(store.appendAgentLog).not.toHaveBeenCalled();
  });

  it("passes when staged files partially overlap scope", async () => {
    const store = createInvariantStore(["packages/engine/src/merger.ts"]);
    mockStagedFiles([
      "packages/engine/src/merger.ts",
      "packages/core/src/store.ts",
    ]);

    await expect(assertSquashOverlapsFileScope({
      store: store as never,
      taskId: "FN-4073",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
    })).resolves.toBeUndefined();
  });

  it("throws when staged files have zero overlap with scope", async () => {
    const store = createInvariantStore(["packages/engine/src/merger.ts"]);
    mockStagedFiles(["packages/core/src/store.ts"]);

    await expect(assertSquashOverlapsFileScope({
      store: store as never,
      taskId: "FN-4073",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
    })).rejects.toMatchObject({
      name: "FileScopeViolationError",
      taskId: "FN-4073",
      stagedFiles: ["packages/core/src/store.ts"],
      declaredScope: ["packages/engine/src/merger.ts"],
    } satisfies Partial<FileScopeViolationError>);
  });

  it("matches nested files against glob entries", async () => {
    const store = createInvariantStore(["packages/foo/**"]);
    mockStagedFiles(["packages/foo/src/bar/baz.ts"]);

    await expect(assertSquashOverlapsFileScope({
      store: store as never,
      taskId: "FN-4073",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
    })).resolves.toBeUndefined();
  });

  /*
  FNXC:FileScopeInvariant 2026-10-07-18:10:
  Overlap means an exact file, a glob match, or a descendant of a declared directory.
  A sibling of a declared file in the same directory is a violation, not an overlap.
  */
  it.each([
    ["an explicit file only matches itself", ["src/a.ts"], ["src/b.ts"], false],
    ["an explicit file matches exactly", ["src/a.ts"], ["src/a.ts"], true],
    ["a directory without a trailing slash matches its descendants", ["src/feature"], ["src/feature/deep/x.ts"], true],
    ["a directory with a trailing slash matches its descendants", ["src/feature/"], ["src/feature/x.ts"], true],
    ["a single-star directory matches nested descendants", ["src/feature/*"], ["src/feature/deep/x.ts"], true],
    ["an extension glob matches its own directory", ["src/*.ts"], ["src/b.ts"], true],
    ["an extension glob does not match a nested file", ["src/*.ts"], ["src/deep/b.ts"], false],
    ["a directory does not match a name-prefixed sibling", ["src/feature"], ["src/feature-two/x.ts"], false],
  ] as const)("%s", async (_label, scope, staged, overlaps) => {
    const store = createInvariantStore([...scope]);
    mockStagedFiles([...staged]);
    const assertion = expect(assertSquashOverlapsFileScope({
      store: store as never,
      taskId: "FN-4073",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
    }));
    if (overlaps) await assertion.resolves.toBeUndefined();
    else await assertion.rejects.toBeInstanceOf(FileScopeViolationError);
  });

  it("ignores .changeset files for overlap and still throws without real overlap", async () => {
    const store = createInvariantStore(["packages/engine/src/merger.ts"]);
    mockStagedFiles([".changeset/foo.md"]);

    await expect(assertSquashOverlapsFileScope({
      store: store as never,
      taskId: "FN-4073",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
    })).rejects.toMatchObject({
      name: "FileScopeViolationError",
      stagedFiles: [".changeset/foo.md"],
    } satisfies Partial<FileScopeViolationError>);
  });

  // Skipped: flakes under workspace-concurrent runs because the
  // vi.mock("node:child_process") implementation occasionally doesn't take
  // effect, letting `git diff --cached --name-only` reach the real git binary
  // (which reports staged files unrelated to the test scope and trips the
  // FileScopeViolationError). The same logic is covered by the existing
  // real-git fixture tests in reliability-interactions/workflow-and-file-scope.
  it("accepts declared scope as a single changeset file when staged matches exactly", async () => {
    const store = createInvariantStore([".changeset/fn-4767-pr-flow.md"]);
    mockStagedFiles([".changeset/fn-4767-pr-flow.md"]);

    await expect(assertSquashOverlapsFileScope({
      store: store as never,
      taskId: "FN-4073",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
    })).resolves.toBeUndefined();
  });

  // Skipped: same flake mode as the test above.
  it("accepts declared scope as a changeset glob when staged file matches", async () => {
    const store = createInvariantStore([".changeset/*.md"]);
    mockStagedFiles([".changeset/fn-4767-pr-flow.md"]);

    await expect(assertSquashOverlapsFileScope({
      store: store as never,
      taskId: "FN-4073",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
    })).resolves.toBeUndefined();
  });

  it("bypasses enforcement and logs once when scopeOverride is true", async () => {
    const store = createInvariantStore(["packages/engine/src/merger.ts"], { scopeOverride: true });
    mockStagedFiles(["packages/core/src/store.ts"]);

    await expect(assertSquashOverlapsFileScope({
      store: store as never,
      taskId: "FN-4073",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
    })).resolves.toBeUndefined();

    expect(store.appendAgentLog).toHaveBeenCalledTimes(1);
    expect(store.appendAgentLog).toHaveBeenCalledWith(
      "FN-4073",
      "file-scope invariant bypassed via scopeOverride",
      "status",
      undefined,
      "merger",
    );
  });

  it("includes the override reason in the bypass log", async () => {
    const store = createInvariantStore(["packages/engine/src/merger.ts"], {
      scopeOverride: true,
      scopeOverrideReason: "hotfix",
    });
    mockStagedFiles(["packages/core/src/store.ts"]);

    await expect(assertSquashOverlapsFileScope({
      store: store as never,
      taskId: "FN-4073",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
    })).resolves.toBeUndefined();

    expect(store.appendAgentLog).toHaveBeenCalledWith(
      "FN-4073",
      "file-scope invariant bypassed via scopeOverride — reason: hotfix",
      "status",
      undefined,
      "merger",
    );
  });
});

describe("enforceSquashFileScopeInvariant audit emission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStagedFiles(["packages/core/src/store.ts"]);
  });

  /*
  FNXC:FileScopeInvariant 2026-10-07-18:10:
  The settings-default policy is strict: a zero-overlap squash fails with FileScopeViolationError and records the
  violation, instead of logging a warning and landing out-of-scope work.
  */
  it("rejects a zero-overlap squash under the default policy and records the violation", async () => {
    const store = createInvariantStore(["packages/engine/src/merger.ts"]);
    const auditor = { git: vi.fn().mockResolvedValue(undefined) };

    await expect(enforceSquashFileScopeInvariant({
      store: store as never,
      taskId: "FN-4073",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
      resetLabel: "file-scope invariant violation",
      auditor: auditor as any,
    })).rejects.toBeInstanceOf(FileScopeViolationError);

    expect(store.appendAgentLog).not.toHaveBeenCalledWith(
      "FN-4073",
      expect.stringContaining("Warning only — continuing merge."),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(auditor.git).toHaveBeenCalledTimes(1);
    expect(auditor.git).toHaveBeenCalledWith({
      type: "merge:file-scope-violation",
      target: "FN-4073",
      metadata: {
        resetLabel: "file-scope invariant violation",
        mode: "strict",
        stagedFiles: ["packages/core/src/store.ts"],
        declaredScope: ["packages/engine/src/merger.ts"],
        stagedFileCount: 1,
        declaredScopeCount: 1,
        warningOnly: false,
      },
    });
  });

  it("does not emit when scopeOverride bypasses invariant", async () => {
    const store = createInvariantStore(["packages/engine/src/merger.ts"], { scopeOverride: true });
    const auditor = { git: vi.fn().mockResolvedValue(undefined) };
    mockedExecSync.mockImplementation(() => "packages/core/src/store.ts");

    await expect(enforceSquashFileScopeInvariant({
      store: store as never,
      taskId: "FN-4073",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
      resetLabel: "file-scope invariant violation",
      auditor: auditor as any,
    })).resolves.toBeUndefined();

    expect(auditor.git).not.toHaveBeenCalled();
  });

  it("still rejects the violation when audit emission fails", async () => {
    const store = createInvariantStore(["packages/engine/src/merger.ts"]);
    const auditor = { git: vi.fn().mockRejectedValue(new Error("audit boom")) };

    await expect(enforceSquashFileScopeInvariant({
      store: store as never,
      taskId: "FN-4073",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
      resetLabel: "file-scope invariant violation",
      auditor: auditor as any,
    })).rejects.toBeInstanceOf(FileScopeViolationError);
  });

  it("rejects the violation when no auditor is supplied", async () => {
    const store = createInvariantStore(["packages/engine/src/merger.ts"]);

    await expect(enforceSquashFileScopeInvariant({
      store: store as never,
      taskId: "FN-4073",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
      resetLabel: "file-scope invariant violation",
    })).rejects.toBeInstanceOf(FileScopeViolationError);
  });
});

describe("file-scope invariant wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails the standard merge AI path when staged files are out of scope", async () => {
    const store = createInvariantStore(["packages/engine/src/merger.ts"]);
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git diff --cached --quiet")) return "1";
      if (cmdStr === "git diff --cached --name-only") return "packages/core/src/store.ts";
      return "";
    });

    const result = createMergeResult();
    await expect(executeMergeAttempt({
      store: store as never,
      rootDir: "/tmp/root",
      taskId: "FN-4073",
      branch: "fn/fn-4073",
      commitLog: "feat: branch work",
      diffStat: "1 file changed",
      includeTaskId: true,
      smartConflictResolution: true,
      mergeConflictStrategy: "smart-prefer-branch",
      attemptNum: 1,
      options: {},
      result,
      settings: { ...DEFAULT_SETTINGS },
    }, { aiWasInvoked: false })).rejects.toBeInstanceOf(FileScopeViolationError);

    expect(store.appendAgentLog).not.toHaveBeenCalledWith(
      "FN-4073",
      expect.stringContaining("Warning only — continuing merge."),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("allows the -X fallback commit when staged files partially overlap scope", async () => {
    const store = createInvariantStore(["packages/engine/src/merger.ts"]);
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git merge -X ours --squash")) return "";
      if (cmdStr.includes("git diff --name-only --diff-filter=U")) return "";
      if (cmdStr.includes("git diff --cached --quiet")) return "1";
      if (cmdStr === "git diff --cached --name-only") return "packages/engine/src/merger.ts\npackages/core/src/store.ts";
      if (cmdStr.includes("git commit ")) return "";
      return "";
    });

    await expect(attemptWithSideStrategy({
      store: store as never,
      rootDir: "/tmp/root",
      taskId: "FN-4073",
      branch: "fn/fn-4073",
      commitLog: "feat: branch work",
      diffStat: "1 file changed",
      includeTaskId: true,
      sourceIssueRef: undefined,
      smartConflictResolution: true,
      mergeConflictStrategy: "smart-prefer-main",
      attemptNum: 3,
      options: {},
      result: createMergeResult(),
      settings: { ...DEFAULT_SETTINGS },
    }, "ours")).resolves.toBe(true);

    expect(store.appendAgentLog).not.toHaveBeenCalledWith(
      "FN-4073",
      expect.stringContaining("File-scope invariant violation"),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("bypasses the -X fallback invariant when scopeOverride is true and logs the reason", async () => {
    const store = createInvariantStore(["packages/engine/src/merger.ts"], {
      scopeOverride: true,
      scopeOverrideReason: "hotfix",
    });
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git merge -X ours --squash")) return "";
      if (cmdStr.includes("git diff --name-only --diff-filter=U")) return "";
      if (cmdStr.includes("git diff --cached --quiet")) return "1";
      if (cmdStr.includes("git commit ")) return "";
      return "";
    });

    await expect(attemptWithSideStrategy({
      store: store as never,
      rootDir: "/tmp/root",
      taskId: "FN-4073",
      branch: "fn/fn-4073",
      commitLog: "feat: branch work",
      diffStat: "1 file changed",
      includeTaskId: true,
      sourceIssueRef: undefined,
      smartConflictResolution: true,
      mergeConflictStrategy: "smart-prefer-main",
      attemptNum: 3,
      options: {},
      result: createMergeResult(),
      settings: { ...DEFAULT_SETTINGS },
    }, "ours")).resolves.toBe(true);

    expect(store.appendAgentLog).toHaveBeenCalledWith(
      "FN-4073",
      "file-scope invariant bypassed via scopeOverride — reason: hotfix",
      "status",
      undefined,
      "merger",
    );
  });

  it("fails verification-fix finalization without committing when staged files are out of scope", async () => {
    const store = createInvariantStore(["packages/engine/src/merger.ts"]);
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr === "git diff --cached --name-only") return "packages/core/src/store.ts";
      if (cmdStr === "git diff --name-only") return "";
      if (cmdStr === "git status -z --porcelain") return "";
      if (cmdStr === "git diff --cached --raw") return "";
      if (cmdStr === "git rev-parse HEAD") return "head-before";
      if (cmdStr.includes("git commit ")) return "";
      return "";
    });

    await expect(commitOrAmendMergeWithFixes(
      "/tmp/root",
      "FN-4073",
      "fn/fn-4073",
      "feat: branch work",
      true,
      "head-before",
      "",
      "1 file changed",
      { ...DEFAULT_SETTINGS },
      undefined,
      undefined,
      undefined,
      undefined,
      new Set(),
      store as never,
    )).rejects.toBeInstanceOf(FileScopeViolationError);

    expect(mockedExecSync.mock.calls.some(([cmd]) => String(cmd).includes("git commit "))).toBe(false);
  });
});

/*
FNXC:FileScopeInvariant 2026-10-08-08:58:
KB-058: the pre-review phase only refuses. `off`, `warn`, and the scopeOverride bypass stay silent so the post-review
check reports them exactly once; strict/custom refusals carry `scopeCheckPhase:"pre-review"`, while the default phase keeps the
unchanged audit contract with no `scopeCheckPhase` key.
*/
describe("enforceSquashFileScopeInvariant phase semantics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    policyOverride.value = undefined;
    mockStagedFiles(["packages/core/src/store.ts"]);
  });

  async function run(store: ReturnType<typeof createInvariantStore>, auditor: { git: ReturnType<typeof vi.fn> }, phase?: "pre-review" | "post-review") {
    return enforceSquashFileScopeInvariant({
      store: store as never,
      taskId: "FN-4073",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
      resetLabel: "phase test",
      auditor: auditor as any,
      phase,
    });
  }

  it("pre-review scopeOverride bypass resolves without the bypass log", async () => {
    const store = createInvariantStore(["packages/engine/src/merger.ts"], { scopeOverride: true });
    const auditor = { git: vi.fn().mockResolvedValue(undefined) };
    await expect(run(store, auditor, "pre-review")).resolves.toBeUndefined();
    expect(store.appendAgentLog).not.toHaveBeenCalled();
    expect(auditor.git).not.toHaveBeenCalled();
  });

  it("pre-review warn resolves a violation with no log and no audit", async () => {
    policyOverride.value = { fileScope: "warn", fileScopeRules: [] };
    const store = createInvariantStore(["packages/engine/src/merger.ts"]);
    const auditor = { git: vi.fn().mockResolvedValue(undefined) };
    await expect(run(store, auditor, "pre-review")).resolves.toBeUndefined();
    expect(store.appendAgentLog).not.toHaveBeenCalled();
    expect(auditor.git).not.toHaveBeenCalled();
  });

  it("pre-review off emits no enforcement-disabled row", async () => {
    policyOverride.value = { fileScope: "off", fileScopeRules: [] };
    const store = createInvariantStore(["packages/engine/src/merger.ts"]);
    const auditor = { git: vi.fn().mockResolvedValue(undefined) };
    await expect(run(store, auditor, "pre-review")).resolves.toBeUndefined();
    expect(auditor.git).not.toHaveBeenCalled();
  });

  it.each([
    ["strict", { fileScope: "strict", fileScopeRules: [] }],
    ["custom", { fileScope: "custom", fileScopeRules: ["elsewhere/**"] }],
  ])("pre-review %s violation rejects and tags the audit row with the phase", async (_label, resolved) => {
    policyOverride.value = resolved;
    const store = createInvariantStore(["packages/engine/src/merger.ts"]);
    const auditor = { git: vi.fn().mockResolvedValue(undefined) };
    await expect(run(store, auditor, "pre-review")).rejects.toBeInstanceOf(FileScopeViolationError);
    expect(auditor.git).toHaveBeenCalledTimes(1);
    expect(auditor.git.mock.calls[0][0]).toMatchObject({
      type: "merge:file-scope-violation",
      metadata: { mode: resolved.fileScope, warningOnly: false, scopeCheckPhase: "pre-review" },
    });
  });

  it.each([undefined, "post-review" as const])("%s phase strict violation keeps the audit contract without a phase key", async (phase) => {
    const store = createInvariantStore(["packages/engine/src/merger.ts"]);
    const auditor = { git: vi.fn().mockResolvedValue(undefined) };
    await expect(run(store, auditor, phase)).rejects.toBeInstanceOf(FileScopeViolationError);
    expect(auditor.git).toHaveBeenCalledTimes(1);
    expect(auditor.git.mock.calls[0][0].metadata).not.toHaveProperty("scopeCheckPhase");
  });
});

describe("scope transform seam", () => {
  it("evaluates the transformed workspace-local scope after resolving prompt scope", async () => {
    const store = createInvariantStore(["repo-a/src/**"]);
    mockStagedFiles(["src/index.ts"]);
    await expect(assertSquashOverlapsFileScope({
      store: store as never,
      taskId: "FN-9050",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
      scopeTransform: (scope) => scope.map((entry) => entry.replace("repo-a/", "")),
    })).resolves.toBeUndefined();
  });

  it("does not invoke the transform when scopeOverride bypasses enforcement", async () => {
    const store = createInvariantStore(["repo-a/src/**"], { scopeOverride: true });
    const transform = vi.fn((scope: string[]) => scope);
    await expect(assertSquashOverlapsFileScope({
      store: store as never,
      taskId: "FN-9050",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
      scopeTransform: transform,
    })).resolves.toBeUndefined();
    expect(transform).not.toHaveBeenCalled();
  });
});
