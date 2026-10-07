import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunCommandOptions, RunCommandResult } from "@fusion/core";

const runCommandAsyncMock = vi.hoisted(() => vi.fn<(command: string, options?: RunCommandOptions) => Promise<RunCommandResult>>());

vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  runCommandAsync: runCommandAsyncMock,
}));

const { executeSingleCommand } = await import("../automation-step-execution.js");
const { AUTOMATION_MAX_BUFFER, DEFAULT_AUTOMATION_TIMEOUT_MS } = await import("../automation-live-run.js");

function result(partial: Partial<RunCommandResult>): RunCommandResult {
  return { stdout: "", stderr: "", exitCode: 0, signal: null, bufferExceeded: false, timedOut: false, ...partial };
}

/*
FNXC:ProcessLifecycle 2026-10-07-18:00:
A manual automation command runs through the supervised runCommandAsync, whose timeout kills the whole command tree on every platform and bounds the wait.
*/
describe("executeSingleCommand", () => {
  afterEach(() => {
    runCommandAsyncMock.mockReset();
  });

  it("runs the command through the supervised runner with the step timeout and buffer cap", async () => {
    runCommandAsyncMock.mockResolvedValue(result({ stdout: "hello\n" }));

    const run = await executeSingleCommand("echo hello", 1_500, "2026-10-07T00:00:00.000Z");

    expect(runCommandAsyncMock).toHaveBeenCalledWith("echo hello", { timeoutMs: 1_500, maxBuffer: AUTOMATION_MAX_BUFFER });
    expect(run).toMatchObject({ success: true, output: "hello\n" });
  });

  it("uses the default automation timeout when the step sets none", async () => {
    runCommandAsyncMock.mockResolvedValue(result({}));

    await executeSingleCommand("echo hello", undefined, "2026-10-07T00:00:00.000Z");

    expect(runCommandAsyncMock).toHaveBeenCalledWith("echo hello", expect.objectContaining({ timeoutMs: DEFAULT_AUTOMATION_TIMEOUT_MS }));
  });

  it("reports a timed-out command as a timeout failure with its partial output", async () => {
    runCommandAsyncMock.mockResolvedValue(result({ stdout: "partial", exitCode: null, signal: "SIGTERM", timedOut: true }));

    const run = await executeSingleCommand("pnpm dev", 2_000, "2026-10-07T00:00:00.000Z");

    expect(run).toMatchObject({ success: false, output: "partial", error: "Command timed out after 2s" });
  });

  it("reports a non-zero exit with the command and its stderr", async () => {
    runCommandAsyncMock.mockResolvedValue(result({ stderr: "boom", exitCode: 1 }));

    const run = await executeSingleCommand("exit 1", 2_000, "2026-10-07T00:00:00.000Z");

    expect(run.success).toBe(false);
    expect(run.error).toBe("Command failed: exit 1\nboom");
  });

  it("reports a spawn error as a failure", async () => {
    runCommandAsyncMock.mockResolvedValue(result({ exitCode: null, spawnError: new Error("spawn ENOENT") }));

    const run = await executeSingleCommand("missing-binary", 2_000, "2026-10-07T00:00:00.000Z");

    expect(run).toMatchObject({ success: false, error: "spawn ENOENT" });
  });
});
