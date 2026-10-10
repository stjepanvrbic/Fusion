/*
FNXC:SystemPanelFnBinary 2026-07-15-09:54:
System panel operators need to (1) build the standalone `fn` binary from a Fusion
source checkout and install it as the default PATH binary, and (2) switch back to
the published global npm install. These helpers encode the install layout and
process steps used by POST /system/fn-binary/link-local and
POST /system/fn-binary/use-global so the route can stream every step into the
shared System job log viewer.
*/

import { spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix as posixPath, resolve, win32 as win32Path } from "node:path";
import {
  FN_INSTALL_NPM,
  FN_NPM_PACKAGE,
  resolveShellFreeLaunch,
  type ShellFreeLaunchDeps,
} from "@fusion/core";

/** Hard cap on build/install child processes (full workspace + bun compile is long). */
export const FN_BINARY_JOB_MAX_MS = 30 * 60_000;
/** Hard cap on `npm install -g` alone. */
export const FN_BINARY_NPM_MAX_MS = 180_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export type FnBinaryLogStream = "stdout" | "stderr" | "system";
export type FnBinaryLogFn = (stream: FnBinaryLogStream, text: string) => void;

/**
 * How PATH shims in `binDir` reach the installed binary.
 * `symlink`: POSIX symlinks. `cmd`: Windows batch shims (`fn.cmd`/`fusion.cmd`).
 */
export type FnBinaryShimStyle = "symlink" | "cmd";

export interface FnBinaryLocalPaths {
  /** `~/.local/share/fusion` — binary + client + runtime co-located here. */
  installDir: string;
  /** `~/.local/bin` — earlier than Homebrew on typical macOS PATH. */
  binDir: string;
  binaryPath: string;
  fnShimPath: string;
  fusionShimPath: string;
  /** Shim flavor for this layout (`cmd` on win32). */
  shimStyle: FnBinaryShimStyle;
  /** Platform whose path rules (separator, case sensitivity) govern containment checks. */
  platform: NodeJS.Platform;
}

/**
 * Resolve the local install layout for `platform`.
 *
 * FNXC:SystemPanelFnBinary 2026-10-08-19:30:
 * KB-097: the layout is platform-aware.
 * Windows only executes files with an executable extension, so the binary is installed as `fn.exe`.
 * Symlinks need the SeCreateSymbolicLink privilege that non-admin Windows users lack, so Windows PATH entries are `fn.cmd`/`fusion.cmd` batch shims (plain files) forwarding to the binary.
 * The binary stays in `installDir` (never copied into `binDir`) because the compiled server resolves `client/` and `runtime/` next to `process.execPath`.
 * `platform` selects the layout only; paths are joined with the host `node:path` so either layout can be exercised against a real temp dir on any host.
 */
export function resolveFnBinaryLocalPaths(
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): FnBinaryLocalPaths {
  const installDir = join(home, ".local", "share", "fusion");
  const binDir = join(home, ".local", "bin");
  const isWindows = platform === "win32";
  return {
    installDir,
    binDir,
    binaryPath: join(installDir, fnBinaryFileName(platform)),
    fnShimPath: join(binDir, isWindows ? "fn.cmd" : "fn"),
    fusionShimPath: join(binDir, isWindows ? "fusion.cmd" : "fusion"),
    shimStyle: isWindows ? "cmd" : "symlink",
    platform,
  };
}

/**
 * Body of a Windows batch shim forwarding every argument to `binaryPath`.
 *
 * FNXC:SystemPanelFnBinary 2026-10-08-19:30:
 * KB-097: the quoted `"%~dp0<rel>" %*` form matches the shim pattern `resolveShellFreeLaunch` (@fusion/core) unwraps, so Fusion can launch the installed `fn` without cmd.exe.
 * The target is shim-relative so the install keeps working if the home directory is moved; CRLF endings are what cmd.exe expects.
 * The relative path is computed with win32 rules because the shim is a Windows artifact; this also keeps the body identical when the layout is exercised on a POSIX host.
 */
export function renderFnCmdShim(binDir: string, binaryPath: string): string {
  const rel = win32Path.relative(binDir, binaryPath).replace(/\//g, "\\");
  return `@echo off\r\n"%~dp0${rel}" %*\r\n`;
}

/** Same shape as `SHIM_TARGET` in @fusion/core's windows-launch: a quoted shim-relative target forwarding `%*`. */
const CMD_SHIM_TARGET = /"(?:%~dp0|%dp0%)([^"%]*)"\s+%\*/i;
/** Upper bound on bytes read from a candidate `.cmd` shim during removal. */
const CMD_SHIM_READ_LIMIT = 4096;

/**
 * True when `child` is `parent` or lies inside it, using `platform` path rules.
 *
 * FNXC:SystemPanelFnBinary 2026-10-08-19:30:
 * KB-097: the old `startsWith(installDir + "/")` check never matched Windows backslash paths, so switching back to the global fn left local shims behind.
 * win32 rules are backslash- and case-insensitive; a sibling prefix such as `fusion-other` is never inside.
 */
export function isPathInsideOrEqual(
  parent: string,
  child: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const api = platform === "win32" ? win32Path : posixPath;
  const rel = api.relative(api.resolve(parent), api.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !api.isAbsolute(rel));
}

export interface ChildRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  command: string;
}

/**
 * Run a command, streaming line-oriented output through `onLog`. Never throws
 * for non-zero exits — caller inspects exitCode.
 *
 * FNXC:SystemPanelFnBinary 2026-10-08-19:30:
 * KB-097: every child launches shell-free (`shell: false`) on every platform.
 * `resolveShellFreeLaunch` (@fusion/core) unwraps Windows `.cmd` shims (npm/pnpm/bun) to the native executable or `node <entry>` they forward to, so cmd.exe never receives (and never re-splits) arguments such as `a&echo injected`.
 * A command only a shell could run resolves to a failed result without spawning, matching the spawn `error` contract.
 * `launchDeps` is a test seam forwarded to `resolveShellFreeLaunch`.
 */
export function runStreamingCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    onLog: FnBinaryLogFn;
    launchDeps?: ShellFreeLaunchDeps;
  },
): Promise<ChildRunResult> {
  const startedAt = Date.now();
  const commandLabel = [command, ...args].join(" ");
  options.onLog("system", `$ ${commandLabel}`);
  const env = options.env ?? process.env;

  let launch: { command: string; args: string[] };
  try {
    launch = resolveShellFreeLaunch(command, args, { env, ...options.launchDeps });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    options.onLog("stderr", message);
    return Promise.resolve({
      exitCode: null,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: message,
      command: commandLabel,
    });
  }

  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let partialOut = "";
    let partialErr = "";

    const flushLines = (target: "stdout" | "stderr", chunk: string): void => {
      const bucket = target === "stdout" ? partialOut : partialErr;
      const combined = bucket + chunk;
      const parts = combined.split(/\r?\n/);
      const nextPartial = parts.pop() ?? "";
      if (target === "stdout") partialOut = nextPartial;
      else partialErr = nextPartial;
      for (const line of parts) {
        options.onLog(target, line);
        if (target === "stdout") {
          if (stdout.length < MAX_OUTPUT_BYTES) {
            stdout += `${line}\n`.slice(0, MAX_OUTPUT_BYTES - stdout.length);
          }
        } else if (stderr.length < MAX_OUTPUT_BYTES) {
          stderr += `${line}\n`.slice(0, MAX_OUTPUT_BYTES - stderr.length);
        }
      }
    };

    const child = spawn(launch.command, launch.args, {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === "win32" && typeof child.pid === "number") {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => {});
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        // Best-effort kill only.
      }
    }, options.timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => flushLines("stdout", chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => flushLines("stderr", chunk.toString("utf8")));

    child.on("error", (err) => {
      clearTimeout(timer);
      options.onLog("stderr", err.message);
      resolvePromise({
        exitCode: null,
        signal: null,
        timedOut,
        stdout,
        stderr: stderr || err.message,
        command: commandLabel,
      });
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (partialOut) {
        options.onLog("stdout", partialOut);
        partialOut = "";
      }
      if (partialErr) {
        options.onLog("stderr", partialErr);
        partialErr = "";
      }
      if (timedOut) {
        options.onLog("system", `Command timed out after ${Math.round(options.timeoutMs / 1000)}s`);
      }
      options.onLog(
        "system",
        `Exit ${exitCode ?? signal ?? "unknown"} (${Date.now() - startedAt}ms)`,
      );
      resolvePromise({
        exitCode,
        signal,
        timedOut,
        stdout,
        stderr,
        command: commandLabel,
      });
    });
  });
}

/** Prefer an explicit path, then common bun install locations, then PATH. */
export function resolveBunExecutable(): string {
  if (process.env.BUN_INSTALL) {
    const candidate = join(process.env.BUN_INSTALL, "bin", process.platform === "win32" ? "bun.exe" : "bun");
    if (existsSync(candidate)) return candidate;
  }
  const homeBun = join(homedir(), ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
  if (existsSync(homeBun)) return homeBun;
  return "bun";
}

/**
 * File name of the Bun-compiled standalone binary in `packages/cli/dist`.
 *
 * FNXC:SystemPanelFnBinary 2026-10-08-17:49:
 * KB-087: Bun emits `fn.exe` on Windows and `fn` elsewhere. Exported so tests build fixtures with the exact name the installer reads and cannot drift from it.
 */
export function fnBinaryFileName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "fn.exe" : "fn";
}

/**
 * Copy the built standalone binary + co-located client/runtime assets into
 * `~/.local/share/fusion` and point the `~/.local/bin` PATH shims at it.
 *
 * FNXC:SystemPanelFnBinary 2026-10-08-19:30:
 * KB-097: on the `cmd` layout (Windows) shims are written as batch files and `symlinkSync` is never called, so a non-admin Windows user can install without the symlink privilege.
 * Any prior file or symlink at a shim path is replaced, so re-installing leaves exactly one shim per name.
 */
export function installLocalFnBinary(
  distDir: string,
  onLog: FnBinaryLogFn,
  paths: FnBinaryLocalPaths = resolveFnBinaryLocalPaths(),
): void {
  const srcBinary = join(distDir, fnBinaryFileName());
  const srcClient = join(distDir, "client");
  const srcRuntime = join(distDir, "runtime");

  if (!existsSync(srcBinary)) {
    throw new Error(`Built binary missing at ${srcBinary}. Did the Bun compile step fail?`);
  }
  if (!existsSync(srcClient)) {
    throw new Error(`Dashboard client assets missing at ${srcClient}.`);
  }

  mkdirSync(paths.installDir, { recursive: true });
  mkdirSync(paths.binDir, { recursive: true });

  onLog("system", `Installing binary → ${paths.binaryPath}`);
  cpSync(srcBinary, paths.binaryPath);
  try {
    chmodSync(paths.binaryPath, 0o755);
  } catch {
    // Windows / restricted FS — ignore.
  }

  onLog("system", `Installing client assets → ${join(paths.installDir, "client")}`);
  rmSync(join(paths.installDir, "client"), { recursive: true, force: true });
  cpSync(srcClient, join(paths.installDir, "client"), { recursive: true });

  if (existsSync(srcRuntime)) {
    onLog("system", `Installing runtime assets → ${join(paths.installDir, "runtime")}`);
    rmSync(join(paths.installDir, "runtime"), { recursive: true, force: true });
    cpSync(srcRuntime, join(paths.installDir, "runtime"), { recursive: true });
  }

  for (const shim of [paths.fnShimPath, paths.fusionShimPath]) {
    try {
      if (existsSync(shim) || isSymlink(shim)) {
        unlinkSync(shim);
      }
    } catch {
      // Replace below; a missing prior shim is fine.
    }
    if (paths.shimStyle === "cmd") {
      onLog("system", `Write shim ${shim} → ${paths.binaryPath}`);
      writeFileSync(shim, renderFnCmdShim(paths.binDir, paths.binaryPath));
    } else {
      onLog("system", `Link ${shim} → ${paths.binaryPath}`);
      symlinkSync(paths.binaryPath, shim);
    }
  }

  const shimKind = paths.shimStyle === "cmd" ? "batch shims" : "symlinks";
  onLog(
    "system",
    `Default fn is now ${paths.fnShimPath} (${shimKind} → ${paths.binaryPath}; PATH should prefer ~/.local/bin).`,
  );
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Target of a `"%~dp0<rel>" %*` batch shim, resolved against the shim's directory, or undefined when the body is not that shape.
 * Backslash segments are re-joined with the host path API so the result is a real filesystem path on every host.
 */
function readCmdShimTarget(shim: string): string | undefined {
  const body = readFileSync(shim).subarray(0, CMD_SHIM_READ_LIMIT).toString("utf8");
  const match = CMD_SHIM_TARGET.exec(body);
  if (!match) return undefined;
  const segments = match[1].split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) return undefined;
  return resolve(dirname(shim), ...segments);
}

/**
 * Remove PATH shims that point at our local install so a later entry (Homebrew
 * npm global, etc.) becomes the default again.
 *
 * FNXC:SystemPanelFnBinary 2026-10-08-19:30:
 * KB-097: containment uses `isPathInsideOrEqual` with Windows path rules whenever the layout or host is Windows, because the old `installDir + "/"` prefix never matched backslash paths.
 * `.cmd` shims are removed only when their `"%~dp0<rel>" %*` target lies inside `installDir`; unreadable or unrecognized files are left in place and logged.
 * On the `cmd` layout, legacy extensionless `fn`/`fusion` entries from a pre-KB-097 (admin) install are removed only when they are symlinks into `installDir`.
 */
export function removeLocalFnShims(
  onLog: FnBinaryLogFn,
  paths: FnBinaryLocalPaths = resolveFnBinaryLocalPaths(),
): { removed: string[] } {
  const removed: string[] = [];
  const installReal = resolve(paths.binaryPath);
  const containmentPlatform: NodeJS.Platform =
    paths.platform === "win32" || process.platform === "win32" ? "win32" : paths.platform;
  const insideInstall = (target: string): boolean =>
    isPathInsideOrEqual(paths.installDir, target, containmentPlatform);

  for (const shim of [paths.fnShimPath, paths.fusionShimPath]) {
    try {
      if (!existsSync(shim) && !isSymlink(shim)) {
        onLog("system", `No shim at ${shim}`);
        continue;
      }
      if (isSymlink(shim)) {
        const target = resolve(dirname(shim), readlinkSync(shim));
        if (insideInstall(target)) {
          unlinkSync(shim);
          removed.push(shim);
          onLog("system", `Removed local shim ${shim}`);
          continue;
        }
        onLog("system", `Leaving ${shim} (points at ${target}, not the local Fusion install)`);
        continue;
      }
      if (paths.shimStyle === "cmd") {
        let target: string | undefined;
        try {
          target = readCmdShimTarget(shim);
        } catch (err) {
          onLog("system", `Leaving ${shim} (unreadable: ${err instanceof Error ? err.message : String(err)})`);
          continue;
        }
        if (target === undefined) {
          onLog("system", `Leaving ${shim} (not a recognized Fusion batch shim)`);
          continue;
        }
        if (insideInstall(target)) {
          unlinkSync(shim);
          removed.push(shim);
          onLog("system", `Removed local shim ${shim}`);
        } else {
          onLog("system", `Leaving ${shim} (points at ${target}, not the local Fusion install)`);
        }
        continue;
      }
      // Non-symlink binary in ~/.local/bin — only remove if identical path under installDir.
      if (resolve(shim) === installReal) {
        unlinkSync(shim);
        removed.push(shim);
        onLog("system", `Removed ${shim}`);
      } else {
        onLog("system", `Leaving ${shim} (not a local Fusion install shim)`);
      }
    } catch (err) {
      onLog("stderr", `Failed to inspect/remove ${shim}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (paths.shimStyle === "cmd") {
    for (const legacy of [join(paths.binDir, "fn"), join(paths.binDir, "fusion")]) {
      try {
        if (!isSymlink(legacy)) continue;
        const target = resolve(dirname(legacy), readlinkSync(legacy));
        if (insideInstall(target)) {
          unlinkSync(legacy);
          removed.push(legacy);
          onLog("system", `Removed legacy local shim ${legacy}`);
        } else {
          onLog("system", `Leaving ${legacy} (points at ${target}, not the local Fusion install)`);
        }
      } catch (err) {
        onLog("stderr", `Failed to inspect/remove ${legacy}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return { removed };
}

/**
 * Full link-local pipeline: workspace full build → bun compile → install under
 * ~/.local. Requires a Fusion source checkout root.
 */
export async function runLinkLocalFnBinary(
  sourceRoot: string,
  onLog: FnBinaryLogFn,
): Promise<{ success: boolean; error?: string }> {
  const buildScript = join(sourceRoot, "scripts", "build-workspace.mjs");
  const cliBuild = join(sourceRoot, "packages", "cli", "build.ts");
  const distDir = join(sourceRoot, "packages", "cli", "dist");

  if (!existsSync(buildScript)) {
    return { success: false, error: `Build script missing: ${buildScript}` };
  }
  if (!existsSync(cliBuild)) {
    return { success: false, error: `CLI build entry missing: ${cliBuild}` };
  }

  onLog("system", "Step 1/3 — full workspace package build…");
  const build = await runStreamingCommand(process.execPath, [buildScript, "--full"], {
    cwd: sourceRoot,
    timeoutMs: FN_BINARY_JOB_MAX_MS,
    onLog,
    env: { ...process.env, FUSION_SKIP_STARTUP_UPDATE_PREFLIGHT: "1", FORCE_COLOR: "0" },
  });
  if (build.timedOut || build.exitCode !== 0) {
    return {
      success: false,
      error: `Workspace build failed (exit ${build.exitCode ?? build.signal ?? "timeout"})`,
    };
  }

  onLog("system", "Step 2/3 — compile standalone fn binary with Bun…");
  const bun = resolveBunExecutable();
  const compile = await runStreamingCommand(bun, ["run", cliBuild], {
    cwd: sourceRoot,
    timeoutMs: FN_BINARY_JOB_MAX_MS,
    onLog,
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  if (compile.timedOut || compile.exitCode !== 0) {
    return {
      success: false,
      error: `Bun compile failed (exit ${compile.exitCode ?? compile.signal ?? "timeout"}). Is bun installed?`,
    };
  }

  onLog("system", "Step 3/3 — install as default local fn…");
  try {
    installLocalFnBinary(distDir, onLog);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  onLog("system", "Local fn binary is ready. Open a new shell if `which fn` still points at npm.");
  return { success: true };
}

/**
 * Remove local-build PATH shims, then reinstall the published package globally
 * so PATH falls back to the npm global binary.
 */
export async function runUseGlobalFnBinary(
  onLog: FnBinaryLogFn,
): Promise<{ success: boolean; error?: string; permissionsHint?: string }> {
  onLog("system", "Step 1/2 — remove local-build shims from ~/.local/bin…");
  removeLocalFnShims(onLog);

  onLog("system", `Step 2/2 — ${FN_INSTALL_NPM}…`);
  const install = await runStreamingCommand("npm", ["install", "-g", FN_NPM_PACKAGE], {
    timeoutMs: FN_BINARY_NPM_MAX_MS,
    onLog,
  });

  if (install.timedOut || install.exitCode !== 0) {
    const combined = `${install.stdout}\n${install.stderr}`;
    const eaccesHit = /EACCES|permission denied|Operation not permitted/i.test(combined);
    return {
      success: false,
      error: `npm install failed (exit ${install.exitCode ?? install.signal ?? "timeout"})`,
      permissionsHint: eaccesHit
        ? "npm reported a permissions error. On macOS/Linux this usually means npm's global prefix needs `sudo` or a fix to your npm prefix (https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally)."
        : undefined,
    };
  }

  onLog("system", "Global npm fn install complete. Verify with `which fn` / `fn --version`.");
  return { success: true };
}
