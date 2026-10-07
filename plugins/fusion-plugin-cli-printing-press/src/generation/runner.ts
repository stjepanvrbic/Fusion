import { resolveShellFreeLaunch, superviseSpawn } from "@fusion/core";
import { redact } from "./redact.js";
import type { GeneratedCliArtifact, RunResult } from "./types.js";

export interface RunGeneratedCliInput {
  artifact: GeneratedCliArtifact;
  endpointId: string;
  params: Record<string, string | number | boolean>;
  credentials?: Record<string, string>;
  timeoutMs?: number;
  cwd?: string;
}

/** Per-stream output cap; excess output is dropped rather than buffered without bound. */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

function toFlagName(key: string): string {
  return key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

function createArgs(endpointId: string, params: Record<string, string | number | boolean>): string[] {
  const args: string[] = ["--endpoint", endpointId];
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "boolean") {
      if (value) args.push(`--${toFlagName(key)}`);
      continue;
    }
    args.push(`--${toFlagName(key)}`, String(value));
  }
  return args;
}

/**
 * Run a generated CLI against one endpoint. Credentials are passed only via env vars: CLIPP_CRED_<UPPER_SNAKE_KEY>.
 *
 * FNXC:CliPrintingPress 2026-10-07-18:02:
 * Endpoint parameters are data. They arrive from the HTTP run route and the agent tool, so they are passed as a separate argv array to node through a supervised, shell-free spawn.
 * The former `exec` of a JSON-quoted command string let `$(...)` run on POSIX and `%VAR%`, quotes and `&` be interpreted by cmd.exe on Windows.
 */
export async function runGeneratedCli({ artifact, endpointId, params, credentials, timeoutMs = 30_000, cwd }: RunGeneratedCliInput): Promise<RunResult> {
  const args = createArgs(endpointId, params);
  const argv = [artifact.binPath, ...args];
  const secrets = Object.values(credentials ?? {});

  const credEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(credentials ?? {})) {
    credEnv[`CLIPP_CRED_${key.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`] = value;
  }

  const start = Date.now();
  const finish = (stdout: string, stderr: string, exitCode: number | null, timedOut: boolean): RunResult => ({
    stdout: redact(stdout, secrets),
    stderr: redact(stderr, secrets),
    exitCode,
    durationMs: Date.now() - start,
    timedOut,
    argv: argv.map((part) => redact(part, secrets)),
  });

  let supervised: ReturnType<typeof superviseSpawn>;
  try {
    // The generated artifact is a `.mjs` entry, which the shared launcher runs with node.
    const launch = resolveShellFreeLaunch(artifact.binPath, args);
    supervised = superviseSpawn(launch.command, launch.args, {
      cwd,
      env: { ...process.env, ...credEnv },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
  } catch (error) {
    return finish("", error instanceof Error ? error.message : String(error), null, false);
  }

  const { child } = supervised;
  return new Promise<RunResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const append = (current: string, chunk: Buffer): string => (current.length >= MAX_OUTPUT_BYTES ? current : current + chunk.toString("utf8"));
    const settle = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      supervised.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once("error", (error: Error) => settle(finish(stdout, stderr || error.message, null, false)));
    child.once("close", (code: number | null) => {
      if (timedOut) settle(finish(stdout, stderr || "Command timed out", null, true));
      else settle(finish(stdout, stderr, code, false));
    });
  });
}
