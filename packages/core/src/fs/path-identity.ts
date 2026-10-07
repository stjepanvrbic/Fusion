import {realpathSync} from "node:fs";
import path from "node:path";

/**
 * FNXC:PathIdentity 2026-10-07-17:58:
 * Two spellings of one directory must be one identity on every platform.
 * Windows volumes are case-insensitive, accept `\\?\` extended-length and `\\.\` device spellings, and resolve junctions, so comparing `path.resolve` strings lets one checkout hold two reservations, defeats root-removal guards, and registers one project twice.
 * Use `isSamePath` / `isPathInside` for every path equality or containment decision and `pathIdentityKey` wherever a path becomes a map or lock key; never compare raw path strings.
 *
 * API:
 * - `normalizeAbsolutePath(p)`: lexical only. Absolute, separators normalized, Windows namespace prefix stripped, spelling preserved. Use for display and for records that other code compares lexically.
 * - `canonicalizePath(p)`: filesystem real path of the nearest existing ancestor (`realpathSync.native`, so on-disk case and junction/symlink targets), with the missing suffix re-joined. Absent paths keep a stable identity.
 * - `pathIdentityKey(p)`: `canonicalizePath` folded to lower case on win32. A comparison key, never a path to open.
 * - `isSamePath(a, b)` and `isPathInside(root, candidate, {allowEqual})`: comparisons over identity keys.
 *
 * `platform` selects win32 or POSIX semantics. The filesystem is consulted only when it matches the host, so win32 identity is testable on Linux as pure string semantics.
 * POSIX keys are case-sensitive: macOS volumes may be case-sensitive, and folding would merge distinct directories there.
 */
export interface PathIdentityOptions {
  platform?: NodeJS.Platform;
}

function pathModuleFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * Strip the Win32 `\\?\` / `\\.\` namespace prefix from a drive or UNC path: `\\?\C:\x` becomes `C:\x` and `\\?\UNC\srv\share\x` becomes `\\srv\share\x`.
 * Device paths that are not drive or UNC spellings, such as `\\.\pipe\name`, are returned unchanged.
 */
export function stripWin32NamespacePrefix(input: string): string {
  const unc = /^[\\/]{2}[?.][\\/]UNC[\\/](.*)$/i.exec(input);
  if (unc) return `\\\\${unc[1]}`;
  const drive = /^[\\/]{2}[?.][\\/]([A-Za-z]:(?:[\\/].*)?)$/.exec(input);
  if (drive) return drive[1]!;
  return input;
}

/** Lexical absolute form: resolved, namespace prefix stripped on win32, spelling and case preserved. */
export function normalizeAbsolutePath(input: string, options: PathIdentityOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const stripped = platform === "win32" ? stripWin32NamespacePrefix(input) : input;
  return pathModuleFor(platform).resolve(stripped);
}

/**
 * Real path of `input`. Missing trailing components are re-joined onto the real path of the nearest existing ancestor.
 * An unreadable ancestor (EACCES, ELOOP) keeps the lexical form rather than throwing, because identity is used inside guards that must not crash.
 */
export function canonicalizePath(input: string, options: PathIdentityOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const absolute = normalizeAbsolutePath(input, {platform});
  if (platform !== process.platform) return absolute;
  const pathModule = pathModuleFor(platform);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = realpathSync.native(current);
      const base = platform === "win32" ? stripWin32NamespacePrefix(real) : real;
      return missing.length === 0 ? base : pathModule.join(base, ...missing.reverse());
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return absolute;
      const parent = pathModule.dirname(current);
      if (parent === current) return absolute;
      missing.push(pathModule.basename(current));
      current = parent;
    }
  }
}

/** Comparison key for one physical directory. Never open or display it: on win32 it is lower-cased. */
export function pathIdentityKey(input: string, options: PathIdentityOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const canonical = canonicalizePath(input, {platform});
  // path.win32.relative folds with toLowerCase too, so containment and equality agree.
  return platform === "win32" ? canonical.toLowerCase() : canonical;
}

/** True when both spellings name the same directory. */
export function isSamePath(a: string, b: string, options: PathIdentityOptions = {}): boolean {
  return pathIdentityKey(a, options) === pathIdentityKey(b, options);
}

/** True when `candidate` is strictly below `root`, or equal to it when `allowEqual` is set. */
export function isPathInside(root: string, candidate: string, options: PathIdentityOptions & {allowEqual?: boolean} = {}): boolean {
  const platform = options.platform ?? process.platform;
  const pathModule = pathModuleFor(platform);
  const rootKey = pathIdentityKey(root, {platform});
  const candidateKey = pathIdentityKey(candidate, {platform});
  if (rootKey === candidateKey) return options.allowEqual === true;
  const relative = pathModule.relative(rootKey, candidateKey);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${pathModule.sep}`)
    && !pathModule.isAbsolute(relative);
}
