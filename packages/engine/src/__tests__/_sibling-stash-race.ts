import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { execFileSync } from "node:child_process";

/*
FNXC:WorktreeStashIsolation 2026-10-08-08:29:
Shared real-git harness reproducing the KB-008 incident: a sibling worktree of the same repository pushes a stash entry WHILE Fusion's own stash round-trip is in flight.
A one-shot `post-merge` hook in the shared hooks directory fires inside Fusion's `git merge --ff-only` / `git pull --ff-only`, i.e. after Fusion's push and before its restore, so the foreign entry becomes the newest in the shared list exactly when a position-based pop would take it.
*/

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString("utf-8").trim();
}

const posix = (p: string): string => p.replace(/\\/g, "/");

export interface SiblingStashRace {
  sibling: string;
  /** SHA of the foreign entry, readable after the hook fired. */
  foreignSha(): string | undefined;
  /** Whether the one-shot hook has fired. */
  fired(): boolean;
}

/**
 * Add a sibling worktree of `repoDir` holding a dirty `foreign.txt` and arm a
 * one-shot `post-merge` hook that stashes it (label `foreign-session`).
 */
export function armSiblingStashRace(repoDir: string, scratchDir: string): SiblingStashRace {
  const sibling = join(scratchDir, "sibling-wt");
  git(repoDir, ["worktree", "add", "-q", "-b", `sibling-${Date.now()}`, sibling]);
  writeFileSync(join(sibling, "foreign.txt"), "foreign session work\n");

  const marker = join(scratchDir, "sibling-stash-armed");
  writeFileSync(marker, "armed\n");
  const commonDir = git(repoDir, ["rev-parse", "--git-common-dir"]);
  const hooksDir = join(isAbsolute(commonDir) ? commonDir : join(repoDir, commonDir), "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const hook = join(hooksDir, "post-merge");
  writeFileSync(
    hook,
    [
      "#!/bin/sh",
      "unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX",
      `if [ -f "${posix(marker)}" ]; then`,
      `  rm -f "${posix(marker)}"`,
      `  git -C "${posix(sibling)}" stash push --include-untracked -m foreign-session >/dev/null 2>&1`,
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(hook, 0o755);

  return {
    sibling,
    fired: () => !existsSync(marker),
    foreignSha: () => stashEntries(repoDir).find((e) => e.subject.endsWith(": foreign-session"))?.sha,
  };
}

export function stashEntries(cwd: string): Array<{ sha: string; subject: string }> {
  return git(cwd, ["stash", "list", "--format=%H%x09%gs"])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, ...rest] = line.split("\t");
      return { sha: sha!, subject: rest.join("\t") };
    });
}
