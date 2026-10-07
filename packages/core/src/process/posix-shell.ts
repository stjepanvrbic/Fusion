import { exec } from "node:child_process";
import { statSync } from "node:fs";
import { win32 } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "./logger.js";

/*
FNXC:PosixShell 2026-10-07-15:58:
Node's `exec` runs command strings through cmd.exe on Windows, but every command string Fusion generates itself is POSIX shell syntax: single-quoted args (`quoteShellArg`), `2>/dev/null`, `|| true`, `$(...)`, `| while read`, and `^{commit}` (cmd eats `^`).
Under cmd these fail silently (git sees `'main'` with literal quotes), so rebase refresh, branch evidence, and revert/conflict probes misbehave on Windows.
Fusion already requires Git, and Git for Windows ships Git Bash, so on win32 Fusion-generated command strings run under that bash; elsewhere Node's default `/bin/sh` is kept untouched.
Operator-configured commands (testCommand, buildCommand, workflow scripts) are NOT routed here: they are written for the operator's native shell.
Resolution is filesystem-only (no shell-out): `FUSION_POSIX_SHELL`, then the Git install that owns the `git.exe` on PATH (the same git these commands invoke), then standard install roots.
`C:\Windows\System32\bash.exe` is the WSL launcher, which runs in a different filesystem namespace, so it is never chosen.
If no bash is found, one warning is logged and commands fall back to Node's default shell rather than throwing.
*/

const log = createLogger("posix-shell");

export interface PosixShellHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  fileExists(path: string): boolean;
}

const defaultHost: PosixShellHost = {
  platform: process.platform,
  env: process.env,
  /* statSync, not existsSync: tests commonly stub existsSync to `true`, which would otherwise select a nonexistent bash. */
  fileExists: (path) => {
    try {
      return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
    } catch {
      return false;
    }
  },
};

/** MSYS-launched processes may see upper-cased env names (`PROGRAMFILES`, `PATH`); Windows env names are case-insensitive. */
function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct) return direct;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lower && value) return value;
  }
  return undefined;
}

function isWslLauncher(path: string): boolean {
  return /\\windows\\(system32|sysnative)\\bash\.exe$/i.test(win32.normalize(path));
}

/** Git install roots implied by PATH entries holding git.exe: `<root>\cmd`, `<root>\bin`, `<root>\mingw64\bin`, `<root>\usr\bin`. */
function gitRootsFromPath(host: PosixShellHost): string[] {
  const roots: string[] = [];
  for (const rawEntry of (readEnv(host.env, "PATH") ?? "").split(";")) {
    const entry = rawEntry.trim().replace(/^"|"$/g, "");
    if (!entry || !host.fileExists(win32.join(entry, "git.exe"))) continue;
    const dir = win32.normalize(entry).replace(/\\+$/, "");
    const leaf = win32.basename(dir).toLowerCase();
    const parent = win32.dirname(dir);
    const parentLeaf = win32.basename(parent).toLowerCase();
    if (leaf === "bin" && (parentLeaf === "mingw64" || parentLeaf === "mingw32" || parentLeaf === "clangarm64" || parentLeaf === "usr")) {
      roots.push(win32.dirname(parent));
    } else if (leaf === "cmd" || leaf === "bin") {
      roots.push(parent);
    }
  }
  return roots;
}

function standardGitRoots(host: PosixShellHost): string[] {
  const roots: string[] = [];
  for (const name of ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]) {
    const base = readEnv(host.env, name);
    if (base) roots.push(win32.join(base, "Git"));
  }
  const localAppData = readEnv(host.env, "LOCALAPPDATA");
  if (localAppData) roots.push(win32.join(localAppData, "Programs", "Git"));
  return roots;
}

/** Pure resolution against an injected host; `undefined` means "use Node's default shell". */
export function findPosixShell(host: PosixShellHost): string | undefined {
  if (host.platform !== "win32") return undefined;
  const override = readEnv(host.env, "FUSION_POSIX_SHELL")?.trim();
  if (override && !isWslLauncher(override) && host.fileExists(override)) return override;
  for (const root of [...gitRootsFromPath(host), ...standardGitRoots(host)]) {
    const candidate = win32.join(root, "bin", "bash.exe");
    if (!isWslLauncher(candidate) && host.fileExists(candidate)) return candidate;
  }
  return undefined;
}

let cached: { shell: string | undefined } | undefined;

/** Cached, lazily resolved shell for Fusion-generated POSIX command strings. `undefined` off Windows (Node uses `/bin/sh`). */
export function resolvePosixShell(): string | undefined {
  if (cached) return cached.shell;
  const shell = findPosixShell(defaultHost);
  if (defaultHost.platform === "win32" && !shell) {
    log.warn("Git Bash not found (set FUSION_POSIX_SHELL to bash.exe); POSIX command strings will run under cmd.exe and may fail");
  }
  cached = { shell };
  return shell;
}

/** Test seam: forget the cached resolution. */
export function resetPosixShellCache(): void {
  cached = undefined;
}

/**
 * Sets `shell` to the POSIX shell on Windows when the caller did not choose one.
 * Off Windows (or when no bash is found) the options object is returned unchanged.
 */
export function withPosixShell<T extends object>(options: T): T;
export function withPosixShell<T extends object>(options: T | undefined): T | undefined;
export function withPosixShell<T extends object>(options: T | undefined): T | undefined {
  if ((options as { shell?: unknown } | undefined)?.shell !== undefined) return options;
  const shell = resolvePosixShell();
  if (!shell) return options;
  return { ...(options ?? ({} as T)), shell };
}

/**
 * Wraps an exec-shaped function `(command, options?, ...rest)` so every call runs under the POSIX shell.
 * Keeps the module-local `exec` import in callers, so `vi.mock("node:child_process")` keeps intercepting.
 */
export function bindPosixShell<F extends (command: string, ...args: never[]) => unknown>(fn: F): F {
  const call = fn as unknown as (command: string, ...rest: unknown[]) => unknown;
  const bound = (command: string, ...args: unknown[]) => {
    if (!resolvePosixShell()) return call(command, ...args);
    if (args.length === 0 || args[0] === undefined || args[0] === null) {
      return call(command, withPosixShell({}), ...args.slice(1));
    }
    if (typeof args[0] === "function") return call(command, withPosixShell({}), ...args);
    return call(command, withPosixShell(args[0] as object), ...args.slice(1));
  };
  return bound as unknown as F;
}

let promisifiedExec: typeof import("node:child_process").exec.__promisify__ | undefined;

/**
 * `promisify(exec)` that runs Fusion-generated POSIX command strings under the POSIX shell.
 * `exec` is bound on first call so importing core never touches a test's partial `node:child_process` mock.
 */
export const execPosix: typeof import("node:child_process").exec.__promisify__ = bindPosixShell(
  ((command: string, ...args: unknown[]) => {
    promisifiedExec ??= promisify(exec);
    return (promisifiedExec as (command: string, ...rest: unknown[]) => unknown)(command, ...args);
  }) as typeof import("node:child_process").exec.__promisify__,
);
