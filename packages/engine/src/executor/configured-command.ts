/**
 * FNXC:CodeOrganization 2026-08-03-07:45:
 * Configured command output formatting + sandbox backend selection peeled from executor.ts.
 */
import type { RunCommandResult } from "@fusion/core";
import type { RunAuditor } from "../util/run-audit.js";
import { resolveSandboxBackend, type SandboxBackend } from "../sandbox/index.js";

const WORKFLOW_SCRIPT_OUTPUT_MAX_CHARS = 4_000;

/**
 * Wall-clock bound (ms) for the command of a script workflow step or a raw CLI workflow node.
 *
 * FNXC:WorkflowScriptTimeout 2026-10-11-09:13:
 * Script and raw CLI workflow steps are bounded by this fixed value and deliberately not by the workflow "Step timeout" (`workflowStepTimeoutMs`).
 * That setting is an AI-session budget: on expiry the session is aborted and retried once with the fallback model, which a shell command does not have.
 * Operators raise it for slow reviewers (45 minutes is in use), so coupling would silently let a hung script hold a task that long.
 * A workflow-wide script timeout is the wrong granularity, because one workflow can run a 10-second lint and a 20-minute test suite.
 * If a script needs a different bound, add a per-node `config.timeoutMs` validated in the workflow IR, with this value as its default so existing workflows do not change.
 */
export const WORKFLOW_COMMAND_STEP_TIMEOUT_MS = 120_000;

export function truncateWorkflowScriptOutput(output: string): string {
  if (output.length <= WORKFLOW_SCRIPT_OUTPUT_MAX_CHARS) return output;
  return `... output truncated to last ${WORKFLOW_SCRIPT_OUTPUT_MAX_CHARS} characters ...\n${output.slice(-WORKFLOW_SCRIPT_OUTPUT_MAX_CHARS)}`;
}

export function configuredCommandErrorMessage(result: RunCommandResult): string {
  if (result.spawnError) return result.spawnError.message;
  const parts: string[] = [];
  if (result.timedOut) parts.push("Timed out");
  if (result.exitCode !== null) parts.push(`Exit code: ${result.exitCode}`);
  if (result.signal) parts.push(`Signal: ${result.signal}`);
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (stdout) parts.push(`stdout: ${truncateWorkflowScriptOutput(stdout)}`);
  if (stderr) parts.push(`stderr: ${truncateWorkflowScriptOutput(stderr)}`);
  return parts.length ? parts.join("\n") : "Command failed";
}

export function getConfiguredCommandSandboxBackend(auditor?: RunAuditor): SandboxBackend {
  return resolveSandboxBackend({ auditor });
}

/**
 * FNXC:CodeOrganization 2026-08-03-16:00:
 * Shared sandbox-backed command runner used by runImplementation and test hooks.
 * Lives with configured-command peels so U4 free functions do not re-open executor.ts locals.
 */
export async function runConfiguredCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  extraEnv?: NodeJS.ProcessEnv,
  auditor?: RunAuditor,
  signal?: AbortSignal,
): Promise<RunCommandResult> {
  const backend = getConfiguredCommandSandboxBackend(auditor);
  const result = await backend.run(command, {
    cwd,
    timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    encoding: "utf-8",
    ...(extraEnv !== undefined && { env: extraEnv }),
    ...(signal !== undefined && { signal }),
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    signal: result.signal,
    bufferExceeded: result.bufferExceeded,
    timedOut: result.timedOut,
    spawnError: result.spawnError,
  };
}

/*
FNXC:CodeOrganization 2026-08-04-06:25:
Test-only wrapper re-exported from executor.ts so sandbox wiring tests import a stable
facade path without holding the helper body on TaskExecutor's module surface.
*/
export async function __runConfiguredCommandForTests(
  command: string,
  cwd: string,
  timeoutMs: number,
  extraEnv?: NodeJS.ProcessEnv,
  auditor?: RunAuditor,
  signal?: AbortSignal,
): Promise<RunCommandResult> {
  return runConfiguredCommand(command, cwd, timeoutMs, extraEnv, auditor, signal);
}
