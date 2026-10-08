/*
FNXC:TestInfraWindows 2026-10-08-05:48:
Engine tests interpose fake commands (`git`, `pnpm`, `python3.11`) by prepending a temp dir to PATH.
The POSIX-only spelling of that trick (`:`-joined PATH, extensionless `#!/bin/sh` script, `command -v`) silently fails on Windows, so those files were excused from the Windows lane.
This helper is the one cross-platform way to install such a shim, and it must reach every execution path the product uses:
- native `exec` (cmd.exe on Windows) resolves commands through PATHEXT, so win32 also gets a `<name>.cmd` wrapper that runs the script through its interpreter;
- Fusion's POSIX seam (`execPosix`/`bindPosixShell`) runs Git Bash, which finds the extensionless shebang script.
Git for Windows' launcher `<root>\bin\bash.exe` always PREPENDS `/mingw64/bin:/usr/bin` to PATH, so a shim for a command Git ships (`git`) is shadowed under the seam.
On win32 the helper therefore points the seam's documented `FUSION_POSIX_SHELL` override at the launcher-free `<root>\usr\bin\bash.exe` (the same bash binary) for the shim's lifetime and resets the seam cache; `restore()` undoes both.
A shell-less `execFile` resolves only `.exe`/`.com` on Windows, so no script shim can intercept it; such tests need a module seam mock instead.
Off Windows the helper writes only the shebang script and joins PATH with `:`, matching the previous Linux behavior.
*/
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, win32 } from "node:path";
import { findPosixShell, resetPosixShellCache } from "@fusion/core";

const WINDOWS = process.platform === "win32";

export interface PathShimOptions {
  /** Command name as the product spells it (`git`, `pnpm`). */
  name: string;
  /** `sh` runs `body` as a POSIX shell script; `node` runs it as a CommonJS Node script. */
  kind: "sh" | "node";
  /** Script body without the shebang line. */
  body: string;
  /** Install into this directory instead of a fresh temp dir (several shims sharing one dir). */
  dir?: string;
}

export interface PathShim {
  /** Directory holding the shim; also the PATH entry prepended by `installPathShim`. */
  dir: string;
  /** Restores PATH (and the win32 POSIX-shell override) exactly, then deletes a helper-created temp dir. */
  restore(): void;
}

/** The env key spelling PATH on this process (`PATH` or Windows `Path`); worker env objects are case-sensitive. */
export function pathEnvKey(env: NodeJS.ProcessEnv = process.env): string {
  return Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
}

/** Git Bash for shim scripts on win32: the launcher-free `usr\bin\bash.exe` beside the seam's `bin\bash.exe`. */
function windowsShimBash(): string {
  const launcher = findPosixShell({ platform: "win32", env: process.env, fileExists: (path) => existsSync(path) });
  if (!launcher) throw new Error("installPathShim: Git Bash not found on win32 (install Git for Windows or set FUSION_POSIX_SHELL)");
  const plain = win32.join(win32.dirname(win32.dirname(launcher)), "usr", "bin", "bash.exe");
  return existsSync(plain) ? plain : launcher;
}

/** Writes `<name>` (shebang script) and, on win32, `<name>.cmd` into `dir`. */
export function writeShimFiles(dir: string, { name, kind, body }: Omit<PathShimOptions, "dir">): void {
  const shebang = kind === "node" ? "#!/usr/bin/env node" : "#!/bin/sh";
  const script = join(dir, name);
  writeFileSync(script, `${shebang}\n${body.endsWith("\n") ? body : `${body}\n`}`);
  chmodSync(script, 0o755);
  if (WINDOWS) {
    const interpreter = kind === "node" ? process.execPath : windowsShimBash();
    writeFileSync(join(dir, `${name}.cmd`), `@"${interpreter}" "%~dp0${name}" %*\r\n`);
  }
}

/**
 * Installs a fake command first on PATH for every execution path the product uses (native exec, POSIX seam).
 * Call `restore()` in `finally`/`afterEach`; it puts PATH back byte-for-byte or deletes a key that was absent.
 */
export function installPathShim(options: PathShimOptions): PathShim {
  const ownsDir = options.dir === undefined;
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), `fusion-path-shim-${options.name}-`));
  writeShimFiles(dir, options);

  // Worker env objects are case-sensitive and may carry both `PATH` and `Path`; prefix every existing spelling so whichever one a child process reads sees the shim, and never add a new spelling.
  const priorPaths = Object.entries(process.env).filter(([name]) => name.toUpperCase() === "PATH");
  if (priorPaths.length === 0) process.env.PATH = dir;
  for (const [name, value] of priorPaths) process.env[name] = value ? `${dir}${delimiter}${value}` : dir;

  const hadShellOverride = Object.prototype.hasOwnProperty.call(process.env, "FUSION_POSIX_SHELL");
  const priorShellOverride = process.env.FUSION_POSIX_SHELL;
  if (WINDOWS) {
    process.env.FUSION_POSIX_SHELL = windowsShimBash();
    resetPosixShellCache();
  }

  let restored = false;
  return {
    dir,
    restore() {
      if (restored) return;
      restored = true;
      if (priorPaths.length === 0) delete process.env.PATH;
      for (const [name, value] of priorPaths) process.env[name] = value;
      if (WINDOWS) {
        if (hadShellOverride) process.env.FUSION_POSIX_SHELL = priorShellOverride;
        else delete process.env.FUSION_POSIX_SHELL;
        resetPosixShellCache();
      }
      if (ownsDir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Absolute path of the real `name` binary, resolved before any shim is installed and without a shell.
 * Spelled with forward slashes so a shim script can embed it as `exec ${JSON.stringify(path)} "$@"` under Git Bash or /bin/sh.
 */
export function realCommandPath(name: string): string {
  const output = execFileSync(WINDOWS ? "where" : "which", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const found = WINDOWS ? lines.find((line) => /\.exe$/i.test(line)) ?? lines[0] : lines[0];
  if (!found) throw new Error(`realCommandPath: ${name} not found on PATH`);
  return WINDOWS ? found.replace(/\\/g, "/") : found;
}
