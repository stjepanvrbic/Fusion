import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";

/*
FNXC:ProcessLifecycle 2026-10-07-18:00:
A CLI launch must succeed for every supported install method on each OS.
Windows CreateProcess (spawn without a shell, and node-pty/ConPTY) resolves a bare name to `.exe`/`.com` only, so npm, pnpm and corepack installs, which ship `.cmd` shims, fail with ENOENT or EINVAL.
Resolve the name through PATH and PATHEXT; run a resolved batch shim through `cmd.exe /d /s /c` with each argument escaped so it reaches the target unchanged. Never add `shell: true` to an argument array instead: cmd.exe would re-parse the arguments.
*/

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
// cmd.exe metacharacters, escaped with a caret (same set as cross-spawn, which this mirrors).
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

export interface WindowsCommandOptions {
  /** Environment whose PATH and PATHEXT drive resolution. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Platform override for tests. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** File probe override for tests. */
  isFile?: (path: string) => boolean;
  /** Batch-file reader override for tests. */
  readText?: (path: string) => string;
}

export interface PreparedCommand {
  command: string;
  args: string[];
  /** True when `args` is a pre-escaped cmd.exe command line (pass `windowsVerbatimArguments: true`). */
  windowsVerbatimArguments: boolean;
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (env[key] !== undefined) return env[key];
  const lower = key.toLowerCase();
  for (const [name, value] of Object.entries(env)) {
    if (name.toLowerCase() === lower) return value;
  }
  return undefined;
}

function defaultIsFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a command the way cmd.exe would: a name with a directory is checked as given, a bare name is
 * searched on PATH, and a name without a PATHEXT extension tries each extension in order.
 * Returns null when nothing matches.
 */
export function resolveWindowsExecutable(command: string, options: WindowsCommandOptions = {}): string | null {
  const env = options.env ?? process.env;
  const isFile = options.isFile ?? defaultIsFile;
  const extensions = (envValue(env, "PATHEXT") ?? DEFAULT_PATHEXT)
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  const hasKnownExtension = extensions.includes(extname(command).toLowerCase());
  const candidates = hasKnownExtension ? [command] : extensions.map((ext) => `${command}${ext}`);
  const hasDirectory = isAbsolute(command) || /[\\/]/.test(command);
  const directories = hasDirectory
    ? [""]
    : (envValue(env, "PATH") ?? "").split(";").map((dir) => dir.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);

  for (const directory of directories) {
    for (const candidate of candidates) {
      const fullPath = directory ? join(directory, candidate) : candidate;
      if (isFile(fullPath)) return fullPath;
    }
  }
  return null;
}

function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META_CHARS, "^$1");
}

function escapeCmdArgument(arg: string, doubleEscape: boolean): string {
  // Quote for the MSVCRT argv parser of the eventual program, then caret-escape for cmd.exe.
  let escaped = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, "$1$1");
  escaped = `"${escaped}"`.replace(CMD_META_CHARS, "^$1");
  return doubleEscape ? escaped.replace(CMD_META_CHARS, "^$1") : escaped;
}

/**
 * Turn `command` + `args` into something `spawn` (without a shell) or node-pty can launch on this
 * platform. Off Windows, and for an unresolvable name, the input is returned unchanged so the
 * caller still sees the platform's own ENOENT.
 */
export function prepareNativeCommand(
  command: string,
  args: readonly string[],
  options: WindowsCommandOptions = {},
): PreparedCommand {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { command, args: [...args], windowsVerbatimArguments: false };
  }
  const resolved = resolveWindowsExecutable(command, options);
  if (!resolved) {
    return { command, args: [...args], windowsVerbatimArguments: false };
  }
  const extension = extname(resolved).toLowerCase();
  if (extension !== ".cmd" && extension !== ".bat") {
    return { command: resolved, args: [...args], windowsVerbatimArguments: false };
  }

  // A shim that forwards `%*` re-parses its arguments once more, so they need a second escape level.
  let forwardsArguments = false;
  try {
    forwardsArguments = (options.readText ?? ((path) => readFileSync(path, "utf8")))(resolved).includes("%*");
  } catch {
    forwardsArguments = false;
  }
  const line = [escapeCmdCommand(resolved), ...args.map((arg) => escapeCmdArgument(arg, forwardsArguments))].join(" ");
  const env = options.env ?? process.env;
  return {
    command: envValue(env, "ComSpec") ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}
