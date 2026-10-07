import { statSync } from "node:fs";
import path from "node:path";

/*
FNXC:WindowsPnpmLaunch 2026-10-07-18:03:
Every script runner that launches pnpm must start it on every platform with the same argv, cwd, env and exit status.
On Windows `pnpm` is a `.cmd` shim, which spawn/spawnSync cannot execute without a shell (ENOENT), so `pnpm test`, verify:fast, the shard runner, the locked runner and the artifact bootstrap could not start there.
Resolve once here: run pnpm's JS entry through node when npm_execpath names it, run a standalone pnpm.exe directly, and only otherwise go through cmd.exe with each argument quoted.
Other platforms and non-pnpm commands are returned unchanged.

FNXC:WindowsPnpmLaunch 2026-10-07-19:30:
The release script also launches npm and gh, which are `.cmd` shims on Windows, and reported the resulting ENOENT as an npm login problem.
For any other command on Windows, search PATH with PATHEXT the way cmd.exe would; a `.cmd`/`.bat` hit runs through cmd.exe by its full path, while an executable hit or no hit leaves the command unchanged so spawn reports its own error.
*/

const SAFE_CMD_ARG = /^[A-Za-z0-9_@+=:,./\\-]+$/;

/**
 * Quote one argument for a `cmd.exe /d /s /c "..."` command line.
 * `%` cannot be escaped inside cmd quotes, so pnpm arguments must not rely on a literal `%`.
 *
 * @param {string} arg
 * @returns {string}
 */
export function quoteCmdArg(arg) {
  const value = String(arg);
  if (value !== "" && SAFE_CMD_ARG.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

function readEnv(env, name) {
  if (!env) return undefined;
  if (typeof env[name] === "string") return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key ? env[key] : undefined;
}

function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Find `command` on a Windows PATH, trying each PATHEXT extension per directory in PATH order.
 *
 * @param {string} command
 * @param {NodeJS.ProcessEnv | undefined} env
 * @returns {string | null}
 */
function findOnWindowsPath(command, env) {
  if (/[\\/]/.test(command) || path.win32.extname(command)) return null;
  const dirs = (readEnv(env, "PATH") ?? "").split(";").map((dir) => dir.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
  const extensions = (readEnv(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim()).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, command + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function viaCmd(env, line) {
  return { command: readEnv(env, "COMSPEC") || "cmd.exe", args: ["/d", "/s", "/c", `"${line.map(quoteCmdArg).join(" ")}"`], windowsVerbatimArguments: true };
}

/**
 * Resolve how to spawn `command args` without a shell.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv, execPath?: string }} [options]
 * @returns {{ command: string, args: string[], windowsVerbatimArguments: boolean }}
 */
export function resolveCommandInvocation(command, args, { platform = process.platform, env = process.env, execPath = process.execPath } = {}) {
  if (platform !== "win32") return { command, args, windowsVerbatimArguments: false };
  if (command !== "pnpm") {
    const resolved = findOnWindowsPath(command, env);
    if (resolved && /\.(cmd|bat)$/i.test(resolved)) return viaCmd(env, [resolved, ...args]);
    return { command, args, windowsVerbatimArguments: false };
  }

  const cli = env?.npm_execpath;
  if (typeof cli === "string" && cli) {
    const base = path.win32.basename(cli).toLowerCase();
    if (/^pnpm\.(c|m)?js$/.test(base)) return { command: execPath, args: [cli, ...args], windowsVerbatimArguments: false };
    if (base === "pnpm.exe") return { command: cli, args, windowsVerbatimArguments: false };
  }

  return viaCmd(env, ["pnpm", ...args]);
}

/**
 * Describe a spawnSync result's failure, including a launch error that left status null.
 *
 * @param {{ status: number | null, signal?: string | null, error?: Error }} result
 * @returns {string}
 */
export function describeSpawnFailure(result) {
  if (result?.error) return `spawn error: ${result.error.message}`;
  if (result?.signal) return `signal ${result.signal}`;
  return `exit code ${result?.status ?? 1}`;
}
