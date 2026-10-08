import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskStore } from "@fusion/core";
import { recordCommitAssociationFromHead } from "../merger.js";
import { installPathShim, realCommandPath, type PathShim } from "./_path-shim.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "fusion-merger-commit-assoc-"));
  git(repo, "git init -b main");
  git(repo, "git config user.email fusion@example.com");
  git(repo, "git config user.name Fusion");
  writeFileSync(join(repo, "file.txt"), "one\ntwo\n");
  git(repo, "git add file.txt");
  git(repo, "git commit -m 'initial commit'");
  writeFileSync(join(repo, "file.txt"), "one\ntwo\nthree\nfour\n");
  git(repo, "git add file.txt");
  git(repo, "git commit -m 'update file'");
  return repo;
}

function makeStore(): Pick<TaskStore, "upsertTaskCommitAssociation"> {
  return {
    upsertTaskCommitAssociation: vi.fn(async (association) => ({
      id: "assoc-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...association,
    })),
  } as Pick<TaskStore, "upsertTaskCommitAssociation">;
}

describeIfGit("recordCommitAssociationFromHead", () => {
  const cleanup: string[] = [];
  let gitShim: PathShim | undefined;

  afterEach(() => {
    gitShim?.restore();
    gitShim = undefined;
    while (cleanup.length > 0) {
      rmSync(cleanup.pop()!, { recursive: true, force: true });
    }
  });

  it("persists HEAD diff stats as additions and deletions", async () => {
    const repo = makeRepo();
    cleanup.push(repo);
    const store = makeStore();

    await recordCommitAssociationFromHead(store as TaskStore, repo, "FN-6704", "lineage-1");

    expect(store.upsertTaskCommitAssociation).toHaveBeenCalledWith(expect.objectContaining({
      taskLineageId: "lineage-1",
      taskIdSnapshot: "FN-6704",
      commitSubject: "update file",
      additions: 2,
      deletions: 0,
    }));
  });

  it("persists the association without stats when shortstat capture fails", async () => {
    const repo = makeRepo();
    cleanup.push(repo);
    // FNXC:TestInfraWindows 2026-10-08-05:48: the shim goes through _path-shim so the merger's POSIX-seam git call hits it on Windows too (was `command -v` + a `:`-joined PATH).
    const realGit = realCommandPath("git");
    gitShim = installPathShim({
      name: "git",
      kind: "sh",
      body: `if [ "$1" = "show" ] && [ "$2" = "--shortstat" ]; then
  echo shortstat failed >&2
  exit 42
fi
exec ${JSON.stringify(realGit)} "$@"`,
    });
    const store = makeStore();

    await recordCommitAssociationFromHead(store as TaskStore, repo, "FN-6704", "lineage-1");

    expect(store.upsertTaskCommitAssociation).toHaveBeenCalledWith(expect.objectContaining({
      taskLineageId: "lineage-1",
      taskIdSnapshot: "FN-6704",
      commitSubject: "update file",
      additions: undefined,
      deletions: undefined,
    }));
  });
});
