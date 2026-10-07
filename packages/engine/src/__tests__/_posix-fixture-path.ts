/*
FNXC:TestInfraWindows 2026-10-07-15:42:
Many engine tests spell fixture paths as POSIX literals (`/project/.worktrees/fn-001`) and key fs/git mocks on them, while the product resolves those paths with node:path before touching the mocks.
On win32 that yields `C:\project\...` or `\project\...`, so every mock lookup missed and ~45 tests failed only on Windows.
These two translations let a fixture keep ONE POSIX spelling: mocks compare in the POSIX namespace, and assertions expect the platform's native spelling.
Both are the identity off Windows, so Linux CI behavior is unchanged.
*/
import { resolve } from "node:path";

const WINDOWS = process.platform === "win32";

/** POSIX spelling of a path the product derived from a POSIX fixture literal (drive prefix dropped, separators forward). */
export function posixFixturePath(path: unknown): string {
  const text = String(path);
  return WINDOWS ? text.replace(/^[A-Za-z]:(?=[\\/])/, "").replace(/\\/g, "/") : text;
}

/** Native absolute spelling of a POSIX fixture literal, as `path.resolve` produces it on this platform. */
export function nativeFixturePath(posixPath: string): string {
  return WINDOWS && posixPath.startsWith("/") ? resolve(posixPath) : posixPath;
}
