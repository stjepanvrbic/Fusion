import { execFileSync } from "node:child_process";

/*
FNXC:WindowsShell 2026-10-07-18:03:
Source scanners must list the same files on every platform. A shell-string `git ls-files '<glob>'` through execSync runs cmd.exe on Windows, which keeps the single quotes, so git matched nothing and each scanner failed closed with "file list is EMPTY".
Pass pathspecs as argv so git, not a shell, interprets the globs. Tracked plus untracked non-ignored files are listed, so a new file counts before it is committed; a path listed by both --cached and --others appears once.
*/

/**
 * @param {readonly string[]} pathspecs git pathspec globs
 * @param {{ cwd?: string, exec?: typeof execFileSync }} [options]
 * @returns {string[]} repo-relative, forward-slash paths in git order, deduplicated
 */
export function listGitSourceFiles(pathspecs, { cwd = process.cwd(), exec = execFileSync } = {}) {
  const output = exec("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...pathspecs], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(output.split("\0").map((file) => file.trim()).filter(Boolean))];
}
