import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/*
FNXC:WindowsEntryGuard 2026-10-07-18:03:
A script run as `node scripts/x.mjs` must execute its CLI body on every platform; a guard that silently no-ops exits 0 and reads as a passing check.
The old `import.meta.url === \`file://${process.argv[1]}\`` form never matched on Windows (`file:///C:/...` vs `file://C:\...`), so the static gate, artifact bootstrap and gate-bundle builder ran nothing there.
Compare file URLs built with pathToFileURL, case-folded on win32, and fall back to realpath so a symlinked or differently-cased argv still counts as the entry point.
*/

/**
 * Whether the module at `moduleUrl` is the process entry point.
 *
 * @param {string} moduleUrl `import.meta.url` of the calling module.
 * @param {{ argv1?: string, platform?: NodeJS.Platform, realpath?: (p: string) => string }} [options]
 *   Injectable for tests; defaults to the running process.
 * @returns {boolean}
 */
export function isEntryPoint(moduleUrl, { argv1 = process.argv[1], platform = process.platform, realpath = realpathSync.native } = {}) {
  if (typeof argv1 !== "string" || argv1 === "" || typeof moduleUrl !== "string") return false;
  const windows = platform === "win32";
  const pathApi = windows ? path.win32 : path.posix;
  const fold = (value) => (windows ? value.toLowerCase() : value);

  const entryPath = pathApi.resolve(argv1);
  if (fold(pathToFileURL(entryPath, { windows }).href) === fold(moduleUrl)) return true;

  try {
    return fold(realpath(entryPath)) === fold(realpath(fileURLToPath(moduleUrl, { windows })));
  } catch {
    return false;
  }
}
