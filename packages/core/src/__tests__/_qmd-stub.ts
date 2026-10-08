/**
 * FNXC:ProjectMemory 2026-10-08-12:42:
 * KB-072: shared fake `qmd` for the FN-7706/FN-7707 unref symptom suites, runnable on every platform.
 * POSIX keeps the original extensionless bash stubs.
 * win32 gets an npm cmd-shim `qmd.cmd` forwarding to a CommonJS `cli.js`, the shape an `npm install -g` produces; the core default executor reaches it shell-free through `resolveShellFreeLaunch` (as `node <cli.js>`).
 * Every stub appends its argv to an invocation log, so a test can prove the stub (not a real or absent qmd) ran.
 * Long-sleeping stubs leave their working directory first: they outlive the test by design, and Windows cannot delete a live process's cwd.
 */
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { expect, vi } from "vitest";

export type QmdStubMode = "refresh" | "search";

/** Invocation log the stub appends its argv to, proving the stub (not a real or absent qmd) was reached. */
export function invocationLogPath(stubDir: string): string {
  return join(stubDir, "invocations.log");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** npm cmd-shim body forwarding to `node_modules\@tobilu\qmd\dist\cli.js` beside the shim. */
const NPM_QMD_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  "IF EXIST \"%dp0%\\node.exe\" (",
  "  SET \"_prog=%dp0%\\node.exe\"",
  ") ELSE (",
  "  SET \"_prog=node\"",
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@tobilu\\qmd\\dist\\cli.js\" %*",
  "",
].join("\r\n");

function posixStub(stubDir: string, mode: QmdStubMode): string {
  const log = `echo "$*" >> ${shellQuote(invocationLogPath(stubDir))}`;
  if (mode === "refresh") {
    // Resolves instantly for "collection add"; sleeps well past the exit bound for "update"/"embed".
    return ["#!/usr/bin/env bash", log, 'case "$1" in', "  update|embed)", "    cd / && sleep 8", "    ;;", "esac", "exit 0", ""].join("\n");
  }
  // "search" ignores SIGTERM and sleeps past searchWithQmd's 4s timeout kill; everything else exits at once.
  return [
    "#!/usr/bin/env bash",
    log,
    "trap '' TERM",
    'case "$1" in',
    "  search)",
    "    cd / && sleep 8",
    "    echo '[]'",
    "    ;;",
    "  *)",
    "    exit 0",
    "    ;;",
    "esac",
    "",
  ].join("\n");
}

/**
 * Node entry the win32 shim forwards to.
 * On win32 kill is TerminateProcess, so the search stub's SIGTERM handler is moot; the invariant (the caller exits before the child) is unchanged.
 */
function windowsCliScript(stubDir: string, mode: QmdStubMode): string {
  const slowCommands = mode === "refresh" ? ["update", "embed"] : ["search"];
  return [
    '"use strict";',
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    "process.chdir(path.parse(process.cwd()).root);",
    "const argv = process.argv.slice(2);",
    `fs.appendFileSync(${JSON.stringify(invocationLogPath(stubDir))}, argv.join(" ") + "\\n");`,
    `if (${JSON.stringify(slowCommands)}.includes(argv[0])) {`,
    '  process.on("SIGTERM", () => {});',
    "  setTimeout(() => {",
    mode === "search" ? '    process.stdout.write("[]");' : "",
    "    process.exit(0);",
    "  }, 8000);",
    "} else {",
    "  process.exit(0);",
    "}",
    "",
  ].join("\n");
}

function holdPreloadPath(stubDir: string): string {
  return join(stubDir, "hold-until-slow-call.cjs");
}

/**
 * FNXC:ProjectMemory 2026-10-08-12:50:
 * libuv assigns every non-detached Windows child to a kill-on-close job object, so the qmd stub dies the moment the fixture exits.
 * A correctly unref'd fixture exits before the stub's node runtime even boots, so the stub could never log and the proof would be vacuous.
 * This preload (fixture process only, never the stub) keeps the fixture's loop alive until the stub logs its slow call (`update` for refresh; `search` plus the concurrent background refresh's final `embed` for search), capped at 4 s.
 * After that, only the sleeping stub child could hold the fixture open, which is exactly what the elapsed bound measures.
 * Waiting for the search fixture's refresh chain also ensures no stub is still booting with the project root as its cwd when the fixture exits (a child mid-spawn can escape the job and would block temp-dir cleanup).
 */
function holdPreloadScript(stubDir: string, mode: QmdStubMode): string {
  return [
    '"use strict";',
    'const fs = require("node:fs");',
    'const isFixture = process.argv.some((arg) => arg.endsWith("qmd-refresh-fixture.mjs") || arg.endsWith("qmd-search-fixture.mjs"));',
    "if (isFixture) {",
    `  const logPath = ${JSON.stringify(invocationLogPath(stubDir))};`,
    `  const markers = ${JSON.stringify(mode === "refresh" ? ["update"] : ["search", "embed"])};`,
    "  const deadline = Date.now() + 4000;",
    "  const seen = () => {",
    "    if (!fs.existsSync(logPath)) return false;",
    "    const commands = fs.readFileSync(logPath, \"utf8\").split(String.fromCharCode(10)).map((line) => line.trim().split(\" \")[0]);",
    "    return markers.every((marker) => commands.includes(marker));",
    "  };",
    "  const timer = setInterval(() => { if (Date.now() > deadline || seen()) clearInterval(timer); }, 20);",
    "}",
    "",
  ].join("\n");
}

/** Write the platform-appropriate fake `qmd` into `stubDir` (which must be put first on PATH). */
export function writeQmdStub(stubDir: string, mode: QmdStubMode): void {
  if (process.platform !== "win32") {
    const stubPath = join(stubDir, "qmd");
    writeFileSync(stubPath, posixStub(stubDir, mode), "utf8");
    chmodSync(stubPath, 0o755);
    return;
  }
  const packageDir = join(stubDir, "node_modules", "@tobilu", "qmd");
  mkdirSync(join(packageDir, "dist"), { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ type: "commonjs" }), "utf8");
  writeFileSync(join(packageDir, "dist", "cli.js"), windowsCliScript(stubDir, mode), "utf8");
  writeFileSync(join(stubDir, "qmd.cmd"), NPM_QMD_SHIM, "utf8");
  writeFileSync(holdPreloadPath(stubDir), holdPreloadScript(stubDir, mode), "utf8");
}

/**
 * The symptom proof is only meaningful when the stub is the qmd that ran.
 * Waits for the stub's first call (`collection add`); later calls race the fixture's prompt exit by design, so they are not required.
 */
export async function expectStubInvoked(stubDir: string): Promise<void> {
  const logPath = invocationLogPath(stubDir);
  await vi.waitFor(() => {
    expect(existsSync(logPath) ? readFileSync(logPath, "utf8") : "").toContain("collection add");
  }, { timeout: 5_000, interval: 50 });
}

/**
 * Child env with `stubDir` first on PATH and background qmd refresh enabled.
 * Windows env blocks can carry several case-spellings of PATH; drop them all and set one, so the stub wins over any real qmd on the host.
 */
export function fixtureEnv(stubDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  let originalPath = "";
  for (const key of Object.keys(env)) {
    if (/^path$/i.test(key)) {
      originalPath ||= env[key] ?? "";
      delete env[key];
    }
  }
  env.PATH = `${stubDir}${delimiter}${originalPath}`;
  env.FUSION_ENABLE_QMD_REFRESH_IN_TESTS = "1";
  const preload = holdPreloadPath(stubDir);
  if (existsSync(preload)) {
    // NODE_OPTIONS treats backslashes inside quotes as escapes; Windows accepts forward slashes.
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --require "${preload.replace(/\\/g, "/")}"`.trim();
  }
  return env;
}
