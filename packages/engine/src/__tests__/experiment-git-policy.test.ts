import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import type {
  ExperimentRunRecordPayload,
  ExperimentSession,
  ExperimentSessionRecord,
} from "@fusion/core";

import { defaultGitOps, type GitOps } from "../experiment/git-ops.js";
import {
  commitKept,
  ExperimentRevertConflictError,
  revertDiscarded,
} from "../experiment/git-policy.js";

const baseSession: ExperimentSession = {
  id: "EXP-001",
  projectId: "proj",
  name: "session",
  metric: { name: "accuracy", direction: "maximize" },
  status: "active",
  currentSegment: 1,
  maxIterations: 10,
  tags: [],
  bestRunId: undefined,
  keptRunIds: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const baseRunRecord: ExperimentSessionRecord = {
  id: "EXPR-001",
  sessionId: "EXP-001",
  segment: 1,
  seq: 1,
  type: "run",
  payload: { status: "keep", primaryMetric: 0.91, secondaryMetrics: [] },
  createdAt: new Date().toISOString(),
};

const baseRunPayload: ExperimentRunRecordPayload = {
  status: "keep",
  primaryMetric: 0.91,
  secondaryMetrics: [],
};

function createGitMock(): GitOps {
  return {
    head: vi.fn(),
    add: vi.fn(),
    commit: vi.fn(),
    resetHard: vi.fn(),
    stashSave: vi.fn(),
    stashRestore: vi.fn(),
    statusPorcelain: vi.fn(),
    mergeBase: vi.fn(),
    branchExists: vi.fn(),
    createBranch: vi.fn(),
    cherryPick: vi.fn(),
    checkout: vi.fn(),
    currentBranch: vi.fn(),
    deleteBranch: vi.fn(),
  };
}

describe("git policy", () => {
  it("commitKept stages and commits with default message", async () => {
    const git = createGitMock();
    vi.mocked(git.commit).mockResolvedValue("abc123");

    const result = await commitKept({
      session: baseSession,
      runRecord: baseRunRecord,
      runPayload: baseRunPayload,
      git,
    });

    expect(git.add).toHaveBeenCalledWith(["-A"]);
    expect(git.commit).toHaveBeenCalledWith(
      "experiment(EXP-001): keep EXPR-001 — accuracy=0.91",
    );
    expect(result).toEqual({ commit: "abc123" });
  });

  it("revertDiscarded without preserved paths only resets", async () => {
    const git = createGitMock();
    vi.mocked(git.statusPorcelain).mockResolvedValue(" M src/file.ts");

    const result = await revertDiscarded({
      session: baseSession,
      git,
      baselineCommit: "base-sha",
    });

    expect(git.stashSave).not.toHaveBeenCalled();
    expect(git.resetHard).toHaveBeenCalledWith("base-sha");
    expect(result).toEqual({ revertedTo: "base-sha", preservedPaths: [] });
  });

  it("revertDiscarded with preserved path saves then restores by SHA handle", async () => {
    const git = createGitMock();
    vi.mocked(git.statusPorcelain).mockResolvedValue(
      " M autoresearch.jsonl\n M src/file.ts",
    );
    const handle = { sha: "a".repeat(40), label: "experiment-preserve-EXP-001:1-abcd" };
    vi.mocked(git.stashSave).mockResolvedValue(handle);

    await revertDiscarded({
      session: baseSession,
      git,
      baselineCommit: "base-sha",
    });

    expect(git.add).toHaveBeenCalledWith(["autoresearch.jsonl"]);
    expect(git.stashSave).toHaveBeenCalledOnce();
    expect(vi.mocked(git.stashSave).mock.calls[0]![0]).toMatch(/^experiment-preserve-EXP-001:/);
    expect(git.resetHard).toHaveBeenCalledWith("base-sha");
    expect(git.stashRestore).toHaveBeenCalledWith(handle);
  });

  it("rethrow stash restore conflicts as ExperimentRevertConflictError", async () => {
    const git = createGitMock();
    vi.mocked(git.statusPorcelain).mockResolvedValue(" M autoresearch.md");
    vi.mocked(git.stashSave).mockResolvedValue({ sha: "b".repeat(40), label: "experiment-preserve-EXP-001:2-ef01" });
    vi.mocked(git.stashRestore).mockRejectedValue(new Error("conflict"));

    await expect(
      revertDiscarded({
        session: baseSession,
        git,
        baselineCommit: "base-sha",
      }),
    ).rejects.toBeInstanceOf(ExperimentRevertConflictError);
  });

  it("does not preserve similarly-named non-matching files", async () => {
    const git = createGitMock();
    vi.mocked(git.statusPorcelain).mockResolvedValue(" M autoresearch.jsonl.bak");

    const result = await revertDiscarded({
      session: baseSession,
      git,
      baselineCommit: "base-sha",
    });

    expect(git.add).not.toHaveBeenCalled();
    expect(result.preservedPaths).toEqual([]);
  });
});

/*
FNXC:WorktreeStashIsolation 2026-10-08-08:29:
KB-008 regression for the experiment revert: a sibling worktree of the same repository pushes a stash between revertDiscarded's save and restore.
The former positional `stash@{N}` pop restored the sibling's entry here.
*/
describe("revertDiscarded with defaultGitOps (real git, shared stash list)", () => {
  function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, stdio: "pipe" }).toString("utf-8").trim();
  }

  it("restores only its own preserved artifacts when a sibling pushes a stash mid-revert", async () => {
    const root = mkdtempSync(join(process.env.FUSION_TEST_WORKER_ROOT ?? tmpdir(), "experiment-stash-"));
    try {
      const primary = join(root, "primary");
      const sibling = join(root, "sibling");
      execFileSync("git", ["init", "-b", "main", primary], { stdio: "pipe" });
      git(primary, ["config", "user.email", "test@example.com"]);
      git(primary, ["config", "user.name", "Test"]);
      writeFileSync(join(primary, "autoresearch.md"), "notes v1\n");
      writeFileSync(join(primary, "src.txt"), "code v1\n");
      git(primary, ["add", "-A"]);
      git(primary, ["commit", "-m", "base"]);
      const baseline = git(primary, ["rev-parse", "HEAD"]);
      git(primary, ["worktree", "add", "-b", "sib", sibling]);
      writeFileSync(join(primary, "autoresearch.md"), "notes v2\n");

      const real = defaultGitOps(primary);
      let foreignSha = "";
      const ops: GitOps = {
        ...real,
        async resetHard(ref: string) {
          await real.resetHard(ref);
          // Interleave: the sibling stashes after our save, before our restore.
          writeFileSync(join(sibling, "foreign.txt"), "foreign work\n");
          git(sibling, ["stash", "push", "--include-untracked", "-m", "foreign-session"]);
          foreignSha = git(sibling, ["rev-parse", "refs/stash"]);
        },
      };

      const result = await revertDiscarded({ session: baseSession, git: ops, baselineCommit: baseline });

      expect(result.preservedPaths).toEqual(["autoresearch.md"]);
      expect(readFileSync(join(primary, "autoresearch.md"), "utf-8")).toBe("notes v2\n");
      expect(existsSync(join(primary, "foreign.txt"))).toBe(false);
      expect(git(primary, ["stash", "list", "--format=%H"]).split("\n").filter(Boolean)).toEqual([foreignSha]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
