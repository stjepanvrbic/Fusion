/*
FNXC:TestInfraWindows 2026-10-08-10:05:
The GitHub Windows runner's temp directory resolves to an 8.3 short alias (`C:\Users\RUNNER~1\...`).
JavaScript `fs.realpathSync` keeps that alias, while git and native realpath (`realpathSync.native`, `fs.promises.realpath`) expand it to `C:\Users\runneradmin\...`.
Tests that built expected paths from the short spelling failed only on the runner (KB-066); a local census under a user name with no 8.3 alias cannot see this.
Engine tests must therefore create temp fixtures and canonicalize temp-derived expected paths through this helper.
It is an independent oracle built on Node's native realpath and deliberately does not import the production canonicalizer (see FNXC:WorktreePathTests in worktree-paths.test.ts).
On Linux and macOS it is plain native symlink resolution (`/var` → `/private/var`).
*/
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

/** The spelling `git worktree list --porcelain` prints for a native path (forward slashes on Windows). */
export function gitPorcelainPath(path: string): string {
  return path.replace(/\\/g, "/");
}
