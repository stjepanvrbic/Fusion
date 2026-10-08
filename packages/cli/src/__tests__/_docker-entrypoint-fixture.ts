import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { resolvePosixShell } from "@fusion/core";

/*
FNXC:DockerSourceUpdate 2026-10-08-15:05:
Shared fixture for the docker entrypoint behavioral suites (KB-061).
The entrypoint is a POSIX script, so it is launched through `resolvePosixShell()`: Git Bash on win32 (never the WSL `System32\bash.exe` launcher, and never a bare `sh` that may be missing from PATH), and `sh` everywhere else.
*/

const execFileAsync = promisify(execFile);

const workspaceRoot = resolve(import.meta.dirname, "../../../..");
export const entrypoint = resolve(workspaceRoot, "scripts", "docker-entrypoint.sh");

/** POSIX shell used to run the entrypoint: resolved Git Bash on win32, `sh` elsewhere. */
export const entrypointShell = resolvePosixShell() ?? "sh";

const roots: string[] = [];

export function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "fusion-entrypoint-"));
  roots.push(root);
  return root;
}

/** Remove every root created by makeRoot; call from afterEach once child processes have exited. */
export function removeRoots(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

/** Install a stub CLI at <root>/packages/cli/dist/bin.js. */
export function installStubCli(root: string, body: string): void {
  const dir = join(root, "packages", "cli", "dist");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bin.js"), body);
}

/** Stub that appends one JSON record per launch and exits with the code for that run index. */
export const RECORDING_STUB = `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const file = process.env.STUB_RECORD_FILE;
const previous = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
const runIndex = previous.length === 0 ? 0 : previous.split("\\n").length;
appendFileSync(file, JSON.stringify({
  runIndex,
  argv: process.argv.slice(2),
  supervisedFlag: process.env.FUSION_RESTART_SUPERVISED,
  supervisorPid: process.env.FUSION_SUPERVISOR_PID,
  realPpid: process.ppid,
}) + "\\n");
const codes = JSON.parse(process.env.STUB_EXIT_CODES);
process.exit(codes[Math.min(runIndex, codes.length - 1)]);
`;

export interface StubRun {
  runIndex: number;
  argv: string[];
  supervisedFlag?: string;
  supervisorPid?: string;
  realPpid: number;
}

export async function runEntrypoint(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(entrypointShell, [entrypoint, ...args], {
      env: { ...process.env, ...env },
      timeout: 30_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

export function readRuns(file: string): StubRun[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as StubRun);
}

/** Poll for a file the stub writes when it is ready; keeps the signal test free of fixed sleeps. */
export async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${path}`);
}
