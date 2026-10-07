import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { runGrokCommand } from "../cli-spawn.js";

function mockPlatform(platform: NodeJS.Platform) {
  return vi.spyOn(process, "platform", "get").mockReturnValue(platform);
}

function createMockChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  vi.mocked(spawn).mockReturnValue(child as never);
  return child;
}

describe("runGrokCommand", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    // An empty PATH keeps launch resolution hermetic on hosts with a real grok installed.
    vi.stubEnv("PATH", "");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("never hands a Windows Grok invocation to a shell", async () => {
    mockPlatform("win32");
    const child = createMockChild();

    const resultPromise = runGrokCommand("grok", ["--version"], 1000);

    expect(spawn).toHaveBeenCalledWith("grok", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });

    child.stdout.write("grok 1.0.0\n");
    child.stderr.write("diagnostic\n");
    child.emit("close", 0);

    await expect(resultPromise).resolves.toEqual({
      code: 0,
      stdout: "grok 1.0.0\n",
      stderr: "diagnostic\n",
    });
  });

  it("keeps non-Windows Grok invocations on direct spawn", async () => {
    mockPlatform("darwin");
    const child = createMockChild();

    const resultPromise = runGrokCommand("grok", ["--version"], 1000);

    expect(spawn).toHaveBeenCalledWith("grok", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });

    child.emit("close", 0);
    await expect(resultPromise).resolves.toMatchObject({ code: 0 });
  });

  it("launches a configured JS entry through node, as ACP sessions do", async () => {
    mockPlatform("win32");
    const child = createMockChild();
    const resultPromise = runGrokCommand("C:\\tools\\grok\\cli.js", ["--version"], 1000);
    expect(spawn).toHaveBeenCalledWith(process.execPath, ["C:\\tools\\grok\\cli.js", "--version"], expect.objectContaining({ shell: false }));
    child.emit("close", 0);
    await expect(resultPromise).resolves.toMatchObject({ code: 0 });
  });

  it("returns spawn errors with diagnostics instead of empty stderr", async () => {
    mockPlatform("win32");
    const child = createMockChild();

    const resultPromise = runGrokCommand("grok", ["--version"], 1000);
    child.emit("error", Object.assign(new Error("spawn grok ENOENT"), { code: "ENOENT" }));

    const result = await resultPromise;
    expect(result.code).toBe(127);
    expect(result.stderr).toContain("spawn error: ENOENT: spawn grok ENOENT");
  });

  it("kills timed-out Grok commands best-effort and resolves once", async () => {
    vi.useFakeTimers();
    mockPlatform("linux");
    const child = createMockChild();

    const resultPromise = runGrokCommand("grok", ["models"], 25);
    child.stdout.write("partial");

    await vi.advanceTimersByTimeAsync(25);

    await expect(resultPromise).resolves.toEqual({ code: 124, stdout: "partial", stderr: "" });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    child.emit("close", 0);
    await expect(resultPromise).resolves.toMatchObject({ code: 124 });
  });
});
