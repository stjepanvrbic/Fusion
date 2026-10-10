/* Vendored ACP client from fusion-plugin-acp-runtime — see ./VENDORED.md (FNXC:ClaudeAcp 2026-07-11-16:00). */
/*
FNXC:AcpFilesystem 2026-10-10-18:15:
ACP agents are instructed to stay in their worktree, not path-restricted: a project can span several repositories and directories, so a read or write outside the session directory is allowed.
Only secret-bearing files (`.env*`, private keys, credential stores) and git internals (`.git/**`) are refused, wherever they live.
The deny-list is checked against the symlink-resolved path, and again after open, so a symlink or a component swapped between check and open cannot reach a denied file.
*/

import { constants as fsConstants } from "node:fs";
import { open, realpath, lstat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";

/** Typed refusal. `code` lets callers map to the right JSON-RPC error. */
export type PathDeniedErrorCode = "denied_secret" | "denied_git" | "invalid_path";

export class PathDeniedError extends Error {
  readonly code: PathDeniedErrorCode;
  constructor(code: PathDeniedErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "PathDeniedError";
  }
}

/** Secret-bearing basenames/patterns that must never be read or written. */
const SECRET_BASENAME_PATTERNS: RegExp[] = [
  /^\.env($|\..*$)/i, // .env, .env.local, .env.production, ...
  /\.pem$/i,
  /\.key$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^id_.+$/i, // id_rsa, id_ed25519, id_rsa.pub, ...
  /^credentials$/i,
  /^\.git-credentials$/i, // git stored plaintext credentials
  /\.p12$/i, // PKCS#12 keystore
  /\.pfx$/i, // PKCS#12 keystore (Windows)
  /\.(keystore|jks)$/i, // Java keystore
  /^\.dockercfg$/i, // legacy docker registry auth
  /^\.pgpass$/i, // PostgreSQL password file
  /^\.htpasswd$/i, // Apache basic-auth credentials
];

/** Is `resolved` a secret file by basename? */
export function isSecretPath(resolved: string): boolean {
  const base = path.basename(resolved);
  return SECRET_BASENAME_PATTERNS.some((re) => re.test(base));
}

/**
 * Is `resolved` inside a `.git/` directory? Writing there yields code execution
 * (`.git/hooks/pre-commit`) or token theft (`.git/config`).
 */
export function isGitInternal(resolved: string): boolean {
  return resolved.split(path.sep).includes(".git");
}

function assertNotDenied(resolved: string): void {
  if (isSecretPath(resolved)) {
    throw new PathDeniedError("denied_secret", `secret-pattern file denied: ${resolved}`);
  }
  if (isGitInternal(resolved)) {
    throw new PathDeniedError("denied_git", `git-internal path denied: ${resolved}`);
  }
}

/**
 * Resolve `requestedPath` (relative to `cwd`, or absolute) to its real absolute
 * path, or throw `PathDeniedError` when it names a secret file or git internals.
 *
 * - Existing target: realpath of the target (follows all symlinks).
 * - New file: realpath of the parent dir plus the final component, which must
 *   not be a dangling symlink, because its eventual target is unknown.
 */
export async function resolveAllowedPath(requestedPath: string, cwd: string): Promise<string> {
  if (typeof requestedPath !== "string" || requestedPath.length === 0) {
    throw new PathDeniedError("invalid_path", "empty or non-string path");
  }
  if (requestedPath.includes("\0")) {
    throw new PathDeniedError("invalid_path", "path contains a NUL byte");
  }

  const absRequested = path.resolve(cwd, requestedPath);
  let resolved: string;
  try {
    resolved = await realpath(absRequested);
  } catch {
    const parent = path.dirname(absRequested);
    let realParent: string;
    try {
      realParent = await realpath(parent);
    } catch {
      throw new PathDeniedError("invalid_path", `parent directory does not resolve: ${parent}`);
    }
    resolved = path.join(realParent, path.basename(absRequested));
    const finalComponent = await lstat(resolved).catch(() => undefined);
    if (finalComponent?.isSymbolicLink()) {
      throw new PathDeniedError("invalid_path", `final component is a dangling symlink: ${resolved}`);
    }
  }

  assertNotDenied(resolved);
  return resolved;
}

/**
 * Open a path returned by `resolveAllowedPath`. `O_NOFOLLOW` refuses a final
 * component swapped for a symlink where the platform supports it; the path is
 * then resolved again and checked against the deny-list, closing the handle on
 * a mismatch. Callers must not pass `O_TRUNC`: truncate only after this returns.
 */
export async function openAllowedPath(
  safePath: string,
  flags: number,
  mode?: number,
): Promise<FileHandle> {
  const handle = await open(safePath, flags | fsConstants.O_NOFOLLOW, mode);
  try {
    assertNotDenied(await realpath(safePath));
    return handle;
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw err;
  }
}
