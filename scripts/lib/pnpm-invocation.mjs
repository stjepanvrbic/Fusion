import path from "node:path";

/*
FNXC:WindowsPnpmLaunch 2026-10-07-18:03:
Every script runner that launches pnpm must start it on every platform with the same argv, cwd, env and exit status.
On Windows `pnpm` is a `.cmd` shim, which spawn/spawnSync cannot execute without a shell (ENOENT), so `pnpm test`, verify:fast, the shard runner, the locked runner and the artifact bootstrap could not start there.
Resolve once here: run pnpm's JS entry through node when npm_execpath names it, run a standalone pnpm.exe directly, and only otherwise go through cmd.exe with each argument quoted.
Other platforms and non-pnpm commands are returned unchanged.
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

/**
 * Resolve how to spawn `command args` without a shell.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv, execPath?: string }} [options]
 * @returns {{ command: string, args: string[], windowsVerbatimArguments: boolean }}
 */
export function resolveCommandInvocation(command, args, { platform = process.platform, env = process.env, execPath = process.execPath } = {}) {
  if (command !== "pnpm" || platform !== "win32") return { command, args, windowsVerbatimArguments: false };

  const cli = env?.npm_execpath;
  if (typeof cli === "string" && cli) {
    const base = path.win32.basename(cli).toLowerCase();
    if (/^pnpm\.(c|m)?js$/.test(base)) return { command: execPath, args: [cli, ...args], windowsVerbatimArguments: false };
    if (base === "pnpm.exe") return { command: cli, args, windowsVerbatimArguments: false };
  }

  const line = ["pnpm", ...args].map(quoteCmdArg).join(" ");
  return { command: env?.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
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
