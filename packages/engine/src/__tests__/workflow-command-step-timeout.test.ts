/*
FNXC:WorkflowScriptTimeout 2026-10-11-09:13:
A script workflow step and a raw CLI workflow node stop their command after a fixed 120 seconds.
The workflow "Step timeout" budgets AI-session steps only, so raising or lowering it must not move the command bound.

Surface enumeration (engine only, no UI):
- Script step with the Step timeout above the default, below it, and absent.
- Raw CLI workflow node.
- An expired bound surfaces as a failed step whose error says the command timed out.
*/
import { describe, expect, it, vi } from "vitest";
import type { RunCommandResult, Settings, Task, TaskDetail, WorkflowStep } from "@fusion/core";
import { runRawCliCommand } from "../executor/run-raw-cli-command.js";
import {
  executeScriptWorkflowStep,
  type RunConfiguredCommandFn,
  type ScriptWorkflowStepDeps,
} from "../executor/workflow-script-step.js";

const COMMAND_BOUND_MS = 120_000;

const completed: RunCommandResult = {
  stdout: "",
  stderr: "",
  exitCode: 0,
  signal: null,
  bufferExceeded: false,
  timedOut: false,
};

function createDeps(result: RunCommandResult = completed) {
  const runConfiguredCommand = vi.fn<RunConfiguredCommandFn>(async () => result);
  const deps: ScriptWorkflowStepDeps = {
    store: { logEntry: vi.fn(async () => undefined) } as unknown as ScriptWorkflowStepDeps["store"],
    getRunContextFor: () => undefined,
    registerConfiguredCommandController: () => undefined,
    unregisterConfiguredCommandController: () => undefined,
    runConfiguredCommand,
  };
  return { deps, runConfiguredCommand };
}

const task = { id: "KB-900" } as Task;
const lintStep = { id: "lint", name: "Lint", mode: "script", scriptName: "lint" } as WorkflowStep;
const worktreePath = "worktree";

function scriptSettings(workflowStepTimeoutMs?: number): Settings {
  const settings: Partial<Settings> = {
    scripts: { lint: "echo ok" },
    ...(workflowStepTimeoutMs !== undefined && { workflowStepTimeoutMs }),
  };
  return settings as Settings;
}

describe("workflow command step bound", () => {
  it.each([
    ["above the default", 2_700_000],
    ["below the default", 300_000],
    ["absent", undefined],
  ])("bounds a script step at 120 seconds when the Step timeout is %s", async (_label, workflowStepTimeoutMs) => {
    const { deps, runConfiguredCommand } = createDeps();

    const outcome = await executeScriptWorkflowStep(deps, task, lintStep, worktreePath, scriptSettings(workflowStepTimeoutMs));

    expect(outcome.success).toBe(true);
    expect(runConfiguredCommand).toHaveBeenCalledTimes(1);
    const [command, cwd, timeoutMs] = runConfiguredCommand.mock.calls[0];
    expect(command).toBe("echo ok");
    expect(cwd).toBe(worktreePath);
    expect(timeoutMs).toBe(COMMAND_BOUND_MS);
  });

  it("bounds a raw CLI workflow node at 120 seconds", async () => {
    const { deps, runConfiguredCommand } = createDeps();

    const outcome = await runRawCliCommand(deps, task as TaskDetail, "label", "echo ok", worktreePath);

    expect(outcome.success).toBe(true);
    expect(runConfiguredCommand).toHaveBeenCalledTimes(1);
    expect(runConfiguredCommand.mock.calls[0][2]).toBe(COMMAND_BOUND_MS);
  });

  it("reports an expired bound as a failed script step", async () => {
    const { deps } = createDeps({ ...completed, exitCode: null, timedOut: true });

    const outcome = await executeScriptWorkflowStep(deps, task, lintStep, worktreePath, scriptSettings(2_700_000));

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("Timed out");
  });

  it("reports an expired bound as a failed raw CLI workflow node", async () => {
    const { deps } = createDeps({ ...completed, exitCode: null, timedOut: true });

    const outcome = await runRawCliCommand(deps, task as TaskDetail, "label", "echo ok", worktreePath);

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("Timed out");
  });
});
