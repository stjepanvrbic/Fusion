/*
FNXC:WorktreeReclaim 2026-10-07-23:34:
Ownership of a reap candidate is proven by path identity, so a project root spelled through an alias (a junction or symlink, an 8.3 short name on Windows) still owns its linked worktrees.
A raw string comparison failed that proof and fell back to two git probes; when one failed first the other was abandoned while it still held the project root as its working directory, and Windows then refused to delete the root.
*/
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isReclaimableWorktreeCandidate } from "../worktree/worktree-paths.js";

const tracked: string[] = [];

afterEach(() => {
  for (const dir of tracked.splice(0).reverse()) rmSync(dir, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "fusion-reclaim-identity-"));
  tracked.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "pipe" });
  return root;
}

describe("isReclaimableWorktreeCandidate path identity", () => {
  it("proves a linked worktree belongs to a project root named through an alias", async () => {
    const root = project();
    const entry = join(root, ".worktrees", "fn-1");
    mkdirSync(entry, { recursive: true });
    writeFileSync(join(entry, ".git"), "gitdir: ../../.git/worktrees/fn-1\n");
    const alias = `${root}-alias`;
    symlinkSync(root, alias, "junction");
    tracked.push(alias);

    for (const rootDir of [root, alias, ...(process.platform === "win32" ? [root.toUpperCase()] : [])]) {
      await expect(isReclaimableWorktreeCandidate(entry, { rootDir })).resolves.toBe(true);
      await expect(isReclaimableWorktreeCandidate(join(alias, ".worktrees", "fn-1"), { rootDir })).resolves.toBe(true);
    }
  });

  it("leaves no git probe running against the project root once it refuses a candidate", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const root = project();
      const entry = join(root, ".worktrees", "fn-foreign");
      mkdirSync(entry, { recursive: true });
      writeFileSync(join(entry, ".git"), `gitdir: ${join(tmpdir(), "fusion-reclaim-missing-admin", "fn-foreign")}\n`);

      await expect(isReclaimableWorktreeCandidate(entry, { rootDir: root })).resolves.toBe(false);
      rmSync(root, { recursive: true });
    }
  });
});
