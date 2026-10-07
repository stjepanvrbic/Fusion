import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";

/*
FNXC:WindowsProcessLaunch 2026-10-07-18:02:
Runtime plugins spawn operator-installed CLIs (npm/pnpm `.cmd` shims, native `.exe`s) and Fusion's own staged bridge.
Node refuses `.cmd`/`.bat` without a shell (EINVAL since CVE-2024-27980) and resolves bare names to `.exe`/`.com` only, so a shell-free spawn of a shim fails while a `shell:true` probe reports the CLI available.
Every launch and its probe resolve through this one seam: shims are unwrapped to the native executable or `node <entry>` they invoke, so no batch file or command shell ever receives untrusted arguments, and "available" implies spawnable.
*/

/**
 * Non-secret variables Windows programs need to start: system DLL lookup (`SystemRoot`, `windir`), executable lookup (`PATHEXT`, `ComSpec`), the user profile (`USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA`) and temp space.
 * POSIX allow-lists (`HOME`, `TMPDIR`, `XDG_*`) have no Windows meaning, so an allow-listed env without these starves CLIs of their config and auth.
 */
export const WINDOWS_BASE_ENV_KEYS = [
  "SystemRoot",
  "windir",
  "ComSpec",
  "PATHEXT",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
] as const;

/** Extend an env allow-list with the platform's base startup keys (a no-op off Windows). */
export function withPlatformBaseEnvKeys(allowList: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== "win32") return [...allowList];
  return [...new Set([...allowList, ...WINDOWS_BASE_ENV_KEYS])];
}

/** A command that can be passed to `spawn` with `shell: false`. */
export interface ShellFreeLaunch {
  command: string;
  args: string[];
  /** The file the command resolved to: the native executable or the script node runs. */
  resolvedPath?: string;
}

export interface ShellFreeLaunchDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** The running Node binary; used to run script targets unless the host is Electron. */
  execPath?: string;
  isElectron?: boolean;
  isFile?: (path: string) => boolean;
  readFile?: (path: string) => string;
}

/** The command resolved to something only a shell could run (an unrecognized batch file or script). */
export class UnlaunchableCommandError extends Error {
  readonly code = "EUNLAUNCHABLE";
  readonly command: string;
  readonly resolvedPath: string;
  constructor(command: string, resolvedPath: string, reason: string) {
    super(`Cannot launch ${command} (${resolvedPath}) without a command shell: ${reason}`);
    this.name = "UnlaunchableCommandError";
    this.command = command;
    this.resolvedPath = resolvedPath;
  }
}

const SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const NATIVE_EXTENSIONS = new Set([".exe", ".com"]);
const BATCH_EXTENSIONS = new Set([".cmd", ".bat"]);
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
/** npm cmd-shim (`%dp0%`), pnpm and Fusion's bridge wrapper (`%~dp0`) all forward `%*` to one quoted, shim-relative target. */
const SHIM_TARGET = /"(?:%~dp0|%dp0%)([^"%]*)"\s+%\*/gi;

interface LaunchContext {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  execPath: string;
  isElectron: boolean;
  isFile: (path: string) => boolean;
  readFile: (path: string) => string;
}

function defaultIsFile(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

function pathExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATHEXT?.trim() || DEFAULT_PATHEXT;
  return raw.split(";").map((entry) => entry.trim().toLowerCase()).filter(Boolean)
    .map((entry) => (entry.startsWith(".") ? entry : `.${entry}`));
}

function hasDirectory(command: string): boolean {
  return /[\\/]/.test(command) || /^[A-Za-z]:/.test(command);
}

function windowsCandidates(base: string, env: NodeJS.ProcessEnv): string[] {
  const extensions = pathExtensions(env);
  const extension = win32.extname(base).toLowerCase();
  const exact = extension ? [base] : [];
  return extensions.includes(extension) ? exact : [...exact, ...extensions.map((ext) => `${base}${ext}`)];
}

/** where-style lookup: the first PATH directory holding a match wins, PATHEXT order breaks ties inside it. The cwd is never searched. */
function locateWindowsExecutable(command: string, ctx: LaunchContext): string | undefined {
  if (hasDirectory(command)) return windowsCandidates(command, ctx.env).find(ctx.isFile);
  const searchPath = ctx.env.PATH ?? ctx.env.Path ?? "";
  for (const rawDirectory of searchPath.split(";")) {
    const directory = rawDirectory.trim().replace(/^"(.*)"$/, "$1");
    if (!directory) continue;
    const match = windowsCandidates(win32.join(directory, command), ctx.env).find(ctx.isFile);
    if (match) return match;
  }
  return undefined;
}

function nodeRuntime(ctx: LaunchContext, besideShim?: string): string {
  if (besideShim) {
    const staged = win32.join(besideShim, "node.exe");
    if (ctx.isFile(staged)) return staged;
  }
  // Electron's execPath is not a Node CLI; fall back to the operator's node like the shim would.
  if (!ctx.isElectron) return ctx.execPath;
  if (ctx.platform !== "win32") return "node";
  return locateWindowsExecutable("node", ctx) ?? "node";
}

function launchShim(command: string, shimPath: string, args: readonly string[], ctx: LaunchContext): ShellFreeLaunch {
  let body: string;
  try {
    body = ctx.readFile(shimPath);
  } catch (error) {
    throw new UnlaunchableCommandError(command, shimPath, `the batch file could not be read (${(error as Error).message})`);
  }
  const shimDirectory = win32.dirname(shimPath);
  for (const match of body.matchAll(SHIM_TARGET)) {
    const target = win32.join(shimDirectory, match[1]);
    const extension = win32.extname(target).toLowerCase();
    if (!ctx.isFile(target)) {
      throw new UnlaunchableCommandError(command, shimPath, `its target ${target} does not exist`);
    }
    if (NATIVE_EXTENSIONS.has(extension)) return { command: target, args: [...args], resolvedPath: target };
    if (SCRIPT_EXTENSIONS.has(extension)) return { command: nodeRuntime(ctx, shimDirectory), args: [target, ...args], resolvedPath: target };
  }
  const npmLauncher = npmLauncherTarget(body, shimDirectory);
  if (npmLauncher) {
    if (!ctx.isFile(npmLauncher)) {
      throw new UnlaunchableCommandError(command, shimPath, `its target ${npmLauncher} does not exist`);
    }
    return { command: nodeRuntime(ctx, shimDirectory), args: [npmLauncher, ...args], resolvedPath: npmLauncher };
  }
  throw new UnlaunchableCommandError(command, shimPath, "it is not a recognized npm/pnpm shim; configure the native executable instead");
}

/*
FNXC:ProcessLifecycle 2026-10-07-18:00:
Node's own `npm.cmd`/`npx.cmd` launchers forward through variables, `"%NODE_EXE%" "%NPX_CLI_JS%" %*`, with `SET "NPX_CLI_JS=%~dp0\node_modules\npm\bin\npx-cli.js"`.
Unwrap that shape too, so `npx` runs shell-free on a stock Windows Node install. The launcher's optional prefix-npm override is not followed; the bundled CLI is used.
*/
const NPM_LAUNCHER_FORWARD = /"%NODE_EXE%"\s+"%([A-Za-z_][A-Za-z0-9_]*)%"\s+%\*/i;

function npmLauncherTarget(body: string, shimDirectory: string): string | undefined {
  const forward = NPM_LAUNCHER_FORWARD.exec(body);
  if (!forward) return undefined;
  const assignment = new RegExp(`SET\\s+"${forward[1]}=(?:%~dp0|%dp0%)([^"%]*)"`, "i").exec(body);
  if (!assignment) return undefined;
  const target = win32.join(shimDirectory, assignment[1]);
  return SCRIPT_EXTENSIONS.has(win32.extname(target).toLowerCase()) ? target : undefined;
}

/**
 * Resolve `command` to a launch that needs no shell on any platform.
 * Scripts run under node; on Windows bare names follow PATH/PATHEXT and batch shims are unwrapped to the executable or script they forward to.
 * An unresolvable command is returned unchanged so `spawn` reports ENOENT; a command only a shell could run throws `UnlaunchableCommandError`.
 */
export function resolveShellFreeLaunch(command: string, args: readonly string[], deps: ShellFreeLaunchDeps = {}): ShellFreeLaunch {
  const ctx: LaunchContext = {
    platform: deps.platform ?? process.platform,
    env: deps.env ?? process.env,
    execPath: deps.execPath ?? process.execPath,
    isElectron: deps.isElectron ?? Boolean(process.versions.electron),
    isFile: deps.isFile ?? defaultIsFile,
    readFile: deps.readFile ?? ((path) => readFileSync(path, "utf8")),
  };
  const pathApi = ctx.platform === "win32" ? win32 : posix;
  if (SCRIPT_EXTENSIONS.has(pathApi.extname(command).toLowerCase())) {
    return { command: nodeRuntime(ctx), args: [command, ...args], resolvedPath: command };
  }
  if (ctx.platform !== "win32") return { command, args: [...args] };

  const located = locateWindowsExecutable(command, ctx);
  if (!located) return { command, args: [...args] };
  const extension = win32.extname(located).toLowerCase();
  if (NATIVE_EXTENSIONS.has(extension)) return { command: located, args: [...args], resolvedPath: located };
  if (BATCH_EXTENSIONS.has(extension)) return launchShim(command, located, args, ctx);
  throw new UnlaunchableCommandError(command, located, `${extension || "extensionless"} files need an interpreter shell`);
}

const TREE_KILL_SYNC_TIMEOUT_MS = 5_000;

/*
FNXC:ProcessLifecycle 2026-10-07-18:00:
A killed supervised command must not leave descendants alive, and its caller's wait must stay bounded on every platform.
Windows has no process groups and `shell: true` makes cmd.exe the direct child, so `child.kill` reached only cmd.exe while the real command kept running and held the stdout/stderr pipes, which kept `close` from ever firing.
On win32 the tree is killed with `taskkill /T /F` (console processes ignore the non-forced close request, and Node's own win32 kill is already forced), and only while the root is still alive, because a dead root's pid can be reused by an unrelated process.
*/
export interface ProcessTreeKillLauncher {
  spawn: typeof spawn;
  spawnSync: typeof spawnSync;
}

// Resolved at call time so a partial `node:child_process` test mock cannot break this module at import.
let treeKillLauncher: ProcessTreeKillLauncher | null = null;

function currentTreeKillLauncher(): ProcessTreeKillLauncher {
  return treeKillLauncher ?? { spawn, spawnSync };
}

function taskkillExecutable(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  return systemRoot ? win32.join(systemRoot, "System32", "taskkill.exe") : "taskkill";
}

function windowsTreeKillArgs(pids: readonly number[]): string[] {
  return [...pids.flatMap((pid) => ["/PID", String(pid)]), "/T", "/F"];
}

export interface KillProcessTreeOptions {
  /** Block until the tree kill completes. Only for synchronous contexts such as `process.on("exit")`. */
  sync?: boolean;
  /** Called when the platform tree kill could not be launched or reported failure. */
  onTreeKillFailed?: () => void;
  /** Called exactly once after the tree kill finished, whatever its outcome (synchronously on POSIX and with `sync`). */
  onSettled?: () => void;
  /** Platform override for tests. */
  platform?: NodeJS.Platform;
  /** Launcher override for the async `taskkill` (tests and plugin seams). */
  spawnImpl?: (command: string, args: string[], options: { shell: false; windowsHide: true; stdio: "ignore" }) => ChildProcess;
}

/**
 * Terminate `pid` and every process it started.
 *
 * POSIX signals the process group `-pid` (the caller must have spawned the root `detached`) and falls
 * back to the single pid. Windows runs `taskkill /PID <pid> /T /F`. The call never throws.
 */
/*
FNXC:ProcessLifecycle 2026-10-07-18:00:
This is the ONE process-tree termination implementation in core; `killProcessTree(child)` below and the process supervisor both delegate to it. Do not add a second taskkill path.
It lives here, not in the supervisor, because this file is copied verbatim into the published CLI bundle and must import Node built-ins only.
*/
export function killProcessTreeByPid(
  pid: number,
  signal: NodeJS.Signals = "SIGTERM",
  options: KillProcessTreeOptions = {},
): void {
  if ((options.platform ?? process.platform) !== "win32") {
    try {
      process.kill(-pid, signal);
    } catch {
      // Not a group leader, or the group is already gone.
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    }
    options.onSettled?.();
    return;
  }
  killWindowsProcessTrees([pid], options);
}

/** @internal Batch tree kill for the supervisor's parent-exit handler. */
export function killWindowsProcessTrees(pids: readonly number[], options: KillProcessTreeOptions = {}): void {
  let settled = false;
  const settle = (failed: boolean) => {
    if (settled) return;
    settled = true;
    if (failed) options.onTreeKillFailed?.();
    options.onSettled?.();
  };
  if (pids.length === 0) {
    settle(false);
    return;
  }
  const args = windowsTreeKillArgs(pids);
  if (options.sync) {
    try {
      const result = currentTreeKillLauncher().spawnSync(taskkillExecutable(), args, {
        stdio: "ignore",
        windowsHide: true,
        timeout: TREE_KILL_SYNC_TIMEOUT_MS,
      });
      settle(Boolean(result.error) || result.status !== 0);
    } catch {
      settle(true);
    }
    return;
  }
  try {
    const launch = options.spawnImpl ?? currentTreeKillLauncher().spawn;
    const killer = launch(taskkillExecutable(), args, { shell: false, stdio: "ignore", windowsHide: true });
    killer.once("error", () => settle(true));
    killer.once("exit", (code) => settle(code !== 0));
    killer.unref?.();
  } catch {
    settle(true);
  }
}

/** Replace the launcher that runs `taskkill`, so tests can observe win32 tree kills on any host. */
export function __setProcessTreeKillLauncherForTests(launcher: ProcessTreeKillLauncher | null): void {
  treeKillLauncher = launcher;
}

export interface KillProcessTreeDeps {
  platform?: NodeJS.Platform;
  spawnImpl?: (command: string, args: string[], options: { shell: false; windowsHide: true; stdio: "ignore" }) => ChildProcess;
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode != null || child.signalCode != null;
}

function directKill(child: ChildProcess): void {
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
}

/**
 * Force-terminate a child and, on Windows, every process it started.
 * `child.kill` on Windows ends only the direct child, so an agent's own subprocesses (the real CLI behind a bridge, MCP servers) would outlive the session.
 * `taskkill /T` must run before the root dies because it walks the tree from the root's PID.
 *
 * FNXC:ProcessLifecycle 2026-10-07-18:00:
 * A thin child-process wrapper over core's single tree kill (`killProcessTreeByPid`, above); it adds the already-exited no-op and keeps a direct SIGKILL off Windows.
 */
export function killProcessTree(child: ChildProcess, deps: KillProcessTreeDeps = {}): void {
  // `killed` means a signal was already delivered; repeat teardown (dispose, then exit-time sweep) is a no-op.
  if (child.killed || hasExited(child)) return;
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32" || typeof child.pid !== "number") {
    directKill(child);
    return;
  }
  killProcessTreeByPid(child.pid, "SIGKILL", {
    platform,
    spawnImpl: deps.spawnImpl,
    onTreeKillFailed: () => {
      if (!hasExited(child)) directKill(child);
    },
  });
}
