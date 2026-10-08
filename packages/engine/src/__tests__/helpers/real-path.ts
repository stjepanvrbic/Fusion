/*
FNXC:TestInfraWindows 2026-10-08-10:05:
The GitHub Windows runner's temp directory resolves to an 8.3 short alias (`C:\Users\RUNNER~1\...`).
JavaScript `fs.realpathSync` keeps that alias, while git and native realpath (`realpathSync.native`, `fs.promises.realpath`) expand it to `C:\Users\runneradmin\...`.
Tests that built expected paths from the short spelling failed only on the runner (KB-066); a local census under a user name with no 8.3 alias cannot see this.
Engine tests must therefore create temp fixtures and canonicalize temp-derived expected paths through this helper.
It is an independent oracle built on Node's native realpath and deliberately does not import the production canonicalizer (see FNXC:WorktreePathTests in worktree-paths.test.ts).
On Linux and macOS it is plain native symlink resolution (`/var` → `/private/var`).
*/
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** Strip the win32 `\\?\` / `\\.\` namespace prefix from a drive path; UNC namespace forms are left alone. */
function stripWin32Namespace(path: string): string {
  return path.replace(/^\\\\[?.]\\(?=[A-Za-z]:)/, "");
}

/**
 * Native canonical spelling of `path`: `realpathSync.native` on the nearest existing ancestor, with any
 * missing trailing components re-joined. Expands 8.3 aliases on Windows and is idempotent.
 */
export function nativeRealPath(path: string): string {
  let existing = resolve(path);
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return resolve(path);
    missing.unshift(basename(existing));
    existing = parent;
  }
  const canonical = stripWin32Namespace(realpathSync.native(existing));
  return missing.length === 0 ? canonical : join(canonical, ...missing);
}

/** `mkdtempSync(join(tmpdir(), prefix))`, returned in native canonical (long-name) form. */
export function realTempDir(prefix: string): string {
  return nativeRealPath(mkdtempSync(join(tmpdir(), prefix)));
}

/*
FNXC:TestInfraWindows 2026-10-08-16:08:
KB-082 regression tests must hand production code an operator path spelled with an 8.3 short alias (for example `RUNNER~1`) and prove it is the same directory as its long spelling.
The volume may have 8dot3 name generation disabled, in which case the alias equals the long path; tests must stay correct then, so callers branch on `hasDistinctShortAlias` instead of assuming an alias exists.
*/
/** The 8.3 short spelling Windows reports for an existing `path`; `path` unchanged on other platforms or when no alias exists. */
export function win32ShortAlias(path: string): string {
  if (process.platform !== "win32") return path;
  return execFileSync("cmd.exe", ["/d", "/c", `for %I in ("${path}") do @echo %~sI`], {
    encoding: "utf8",
    windowsVerbatimArguments: true,
  }).trim();
}

/** True when the host volume generates an 8.3 alias for `path` that differs from its spelling. */
export function hasDistinctShortAlias(path: string): boolean {
  return win32ShortAlias(path) !== path;
}

/** The spelling `git worktree list --porcelain` prints for a native path (forward slashes on Windows). */
export function gitPorcelainPath(path: string): string {
  return path.replace(/\\/g, "/");
}
