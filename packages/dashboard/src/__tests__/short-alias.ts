/*
FNXC:TestInfraWindows 2026-10-11-01:06:
Dashboard path guards (registered-worktree git routes, the terminal/worktree allowlist, Task Reset) must accept an operator or store path spelled with a Windows 8.3 alias (`C:\Users\RUNNER~1\...`) as the same directory as git's long spelling.
Regression tests hand production code that short spelling via KB-082's engine helper instead of a second alias implementation.
A volume with 8dot3 generation disabled, and every non-Windows host, has no distinct alias: the test still runs with the long spelling and logs one annotation instead of skipping.
*/
import { hasDistinctShortAlias, nativeRealPath, win32ShortAlias } from "../../../engine/src/__tests__/helpers/real-path.js";

export { nativeRealPath, win32ShortAlias };

/** 8.3 short spelling of the existing `path` (long spelling when the host has no distinct alias, with one `console.info` annotation). */
export function shortAliasForTest(path: string, label: string): string {
  const longPath = nativeRealPath(path);
  if (!hasDistinctShortAlias(longPath)) {
    console.info(`[short-alias] ${label}: no distinct 8.3 alias for ${longPath} on this host; asserting with the long spelling`);
    return longPath;
  }
  return win32ShortAlias(longPath);
}
