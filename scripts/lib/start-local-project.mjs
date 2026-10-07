import { existsSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/*
FNXC:ProcessLifecycle 2026-10-07-18:00:
`pnpm local` must start on Windows for every pnpm install method.
`spawnSync("pnpm.cmd")` without a shell fails with EINVAL, and adding `shell: true` to an argument array lets cmd.exe re-parse the arguments.
Prefer pnpm's own entry (`npm_execpath`) run through `process.execPath`; otherwise resolve pnpm through PATH and PATHEXT and launch a `.cmd` shim through `cmd.exe /d /s /c` with escaped arguments.
The escaping mirrors packages/core/src/process/windows-command.ts, which this plain script cannot import.
*/
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

function defaultIsFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function envValue(env, key) {
  if (env[key] !== undefined) return env[key];
  const lower = key.toLowerCase();
  const match = Object.keys(env).find((name) => name.toLowerCase() === lower);
  return match === undefined ? undefined : env[match];
}

function resolveOnWindowsPath(command, env, isFile) {
  const extensions = (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim().toLowerCase()).filter(Boolean);
  for (const dir of (envValue(env, "PATH") ?? "").split(";").map((entry) => entry.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = join(dir, `${command}${ext}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Decide how to launch pnpm without a shell: `{ kind: "node" | "native" | "cmd-shim", command, prefixArgs }`.
 */
export function resolvePnpmLauncher({ platform = process.platform, env = process.env, execPath = process.execPath, isFile = defaultIsFile } = {}) {
  const execpath = env.npm_execpath;
  if (execpath && /pnpm/i.test(basename(execpath)) && isFile(execpath)) {
    if (/\.[cm]?js$/i.test(execpath)) return { kind: "node", command: execPath, prefixArgs: [execpath] };
    return { kind: "native", command: execpath, prefixArgs: [] };
  }
  if (platform !== "win32") return { kind: "native", command: "pnpm", prefixArgs: [] };
  const resolved = resolveOnWindowsPath("pnpm", env, isFile);
  if (!resolved) return { kind: "native", command: "pnpm", prefixArgs: [] };
  const ext = extname(resolved).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") return { kind: "cmd-shim", command: resolved, prefixArgs: [] };
  return { kind: "native", command: resolved, prefixArgs: [] };
}

function escapeCmdArgument(arg) {
  let escaped = String(arg).replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, "$1$1");
  escaped = `"${escaped}"`.replace(CMD_META_CHARS, "^$1");
  // pnpm's shims forward `%*`, which re-parses the line once more.
  return escaped.replace(CMD_META_CHARS, "^$1");
}

/** Build the `spawnSync(command, args, { windowsVerbatimArguments })` call for one pnpm invocation. */
export function pnpmSpawnSpec(launcher, args, env = process.env) {
  if (launcher.kind !== "cmd-shim") {
    return { command: launcher.command, args: [...launcher.prefixArgs, ...args], windowsVerbatimArguments: false };
  }
  const line = [launcher.command.replace(CMD_META_CHARS, "^$1"), ...args.map(escapeCmdArgument)].join(" ");
  return { command: envValue(env, "ComSpec") ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}

/**
 * FNXC:LocalStartupPostgresMigration 2026-07-14-22:25:
 * Local startup recognizes both the PostgreSQL-era identity marker and a valid legacy SQLite database. Legacy input must pass the canonical read-only SQLite probe so malformed paths do not suppress initialization; an intentional zero-byte bootstrap file remains valid migration input.
 */
export function hasLocalProjectMigrationInput(rootDir) {
  return existsSync(resolve(rootDir, ".fusion/project.json"))
    || isValidLegacySqliteInput(resolve(rootDir, ".fusion/fusion.db"));
}

function isValidLegacySqliteInput(dbPath) {
  if (!existsSync(dbPath)) return false;

  try {
    const stats = statSync(dbPath);
    if (!stats.isFile()) return false;
    if (stats.size === 0) return true;
  } catch {
    return false;
  }

  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.prepare("PRAGMA schema_version").get();
    return true;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}
