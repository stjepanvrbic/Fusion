/**
 * FNXC:TestInfraWindows 2026-10-08-07:11:
 * Shared fake `pg_dump`/`pg_restore` for backup tests that must run on Linux and Windows.
 * The production client runs shell-free `execFile`, which on Windows starts only `.exe`/`.com` files: an extensionless `#!/bin/sh` shim fails with ENOENT and a `.cmd` with EINVAL.
 * Fakes are therefore Node.js scripts.
 * On POSIX the helper writes an executable extensionless `#!/usr/bin/env node` file and returns no `clientExec`, so the real production `execFile` path still launches it.
 * On Windows it writes `<name>.mjs` and returns a `clientExec` that runs `process.execPath <script> ...args` through the existing `PgBackupOptions.clientExec` seam, passing env/timeout/maxBuffer through unchanged.
 */
import { execFile } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PgClientExec } from "../postgres/pg-backup.js";

const execFileAsync = promisify(execFile);

/**
 * Prelude available to every fake script, independent of CommonJS/ESM loading:
 * `fs`, `path`, and `argv` (the client arguments, without node and script path).
 */
const PRELUDE = [
  'const fs = process.getBuiltinModule("node:fs");',
  'const path = process.getBuiltinModule("node:path");',
  "const argv = process.argv.slice(2);",
  "/** Sorted `KEY=value` lines for every libpq `PG*` variable, like `env | grep ^PG | sort`. */",
  "const pgEnvLines = () => Object.keys(process.env).filter((key) => key.startsWith(\"PG\")).sort().map((key) => `${key}=${process.env[key]}`);",
  "/** The value following `flag` in argv, or undefined. */",
  "const argAfter = (flag) => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : undefined; };",
  "",
].join("\n");

export interface FakePgClientOptions {
  /** Directory the fake is written into. */
  readonly dir: string;
  /** Base file name, for example `pg_dump`. Windows appends `.mjs`. */
  readonly name: string;
  /** Node.js source. It may use `fs`, `path`, `argv`, `pgEnvLines()`, `argAfter(flag)`, and `process`. */
  readonly script: string;
}

export interface FakePgClient {
  /** Path to pass as `pgDumpPath`/`pgRestorePath`. */
  readonly path: string;
  /**
   * Launcher to pass as `clientExec`; `undefined` on POSIX so the production default runs.
   * Every fake's launcher is interchangeable, so a dump/restore pair may share either one.
   */
  readonly clientExec: PgClientExec | undefined;
}

/** Launches a Node-script fake client on Windows, where `execFile` cannot start the script itself. */
export const nodeScriptClientExec: PgClientExec = (file, args, options) =>
  execFileAsync(process.execPath, [file, ...args], options);

/** Write a Windows- and POSIX-runnable fake PostgreSQL client. */
export function writeFakePgClient({ dir, name, script }: FakePgClientOptions): FakePgClient {
  const body = `${PRELUDE}${script}\n`;
  if (process.platform === "win32") {
    const path = join(dir, `${name}.mjs`);
    writeFileSync(path, body, "utf8");
    return { path, clientExec: nodeScriptClientExec };
  }
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}`, "utf8");
  chmodSync(path, 0o755);
  return { path, clientExec: undefined };
}
