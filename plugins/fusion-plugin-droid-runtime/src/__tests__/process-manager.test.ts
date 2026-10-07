import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

// Termination goes through the shared tree kill (taskkill /T on Windows); assert that seam, not a platform-specific signal.
const killProcessTreeMock = vi.hoisted(() => vi.fn());
vi.mock("@fusion/plugin-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/plugin-sdk")>()),
  killProcessTree: killProcessTreeMock,
}));

import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { buildDroidSpawnArgs, createSystemPromptFile, spawnDroid } from "../process-manager.js";

function makeProc() {
  const proc = new EventEmitter() as any;
  proc.killed = false;
  proc.exitCode = null;
  proc.pid = 123;
  proc.kill = vi.fn(() => {
    proc.killed = true;
  });
  return proc;
}

describe("Droid agent spawn invariants", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    killProcessTreeMock.mockReset();
    // An empty PATH keeps launch resolution hermetic on hosts that have a real droid installed.
    vi.stubEnv("PATH", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("builds a non-interactive print-mode stream-json invocation", () => {
    const args = buildDroidSpawnArgs("droid-pro", undefined, {
      effort: "high",
      mcpConfigPath: "/tmp/mcp.json",
      newSessionId: "session-1",
    });

    expect(args[0]).toBe("-p");
    expect(args).toEqual(expect.arrayContaining([
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--model",
      "droid-pro",
      "--session-id",
      "session-1",
      "--effort",
      "high",
      "--mcp-config",
      "/tmp/mcp.json",
    ]));
    expect(args).not.toContain("models");
    expect(args).not.toContain("model");
  });

  it("spawns droid with piped stdio and never inherits a TTY", () => {
    const proc = makeProc();
    spawnMock.mockReturnValueOnce(proc);

    expect(spawnDroid("droid-pro", undefined, { cwd: "/tmp/project" })).toBe(proc);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [binary, args, options] = spawnMock.mock.calls[0] as [string, string[], { stdio: string[]; cwd: string }];
    expect(binary).toBe("droid");
    expect(args[0]).toBe("-p");
    expect(args).toEqual(expect.arrayContaining(["--input-format", "stream-json"]));
    expect(options.cwd).toBe("/tmp/project");
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(options.stdio).not.toBe("inherit");
    expect(options.stdio).not.toContain("inherit");
  });

  it("spawns without a shell so Windows shims are resolved, never handed to cmd.exe", () => {
    const proc = makeProc();
    spawnMock.mockReturnValueOnce(proc);
    spawnDroid("droid-pro", undefined, { cwd: "/tmp/project" });
    const options = spawnMock.mock.calls[0][2] as { shell?: unknown; windowsHide?: unknown };
    expect(options.shell).toBe(false);
    expect(options.windowsHide).toBe(true);
  });
});

describe("Droid system prompt files", () => {
  const created: Array<{ cleanup(): void }> = [];
  afterEach(() => {
    for (const file of created.splice(0)) file.cleanup();
  });

  function create(prompt: string, options?: Parameters<typeof createSystemPromptFile>[1]) {
    const file = createSystemPromptFile(prompt, options);
    created.push(file);
    return file;
  }

  it("gives every invocation its own file, so interleaved sessions never read each other's prompt", () => {
    const a = create("prompt A");
    const b = create("prompt B");
    expect(a.path).not.toBe(b.path);
    expect(readFileSync(a.path, "utf8")).toBe("prompt A");
    expect(readFileSync(b.path, "utf8")).toBe("prompt B");
    expect(buildDroidSpawnArgs("droid-pro", a.path)).toEqual(expect.arrayContaining(["--append-system-prompt", a.path]));
  });

  it("removes only its own file, in either completion order, and tolerates repeat cleanup", () => {
    const a = create("prompt A");
    const b = create("prompt B");
    b.cleanup();
    expect(existsSync(b.path)).toBe(false);
    expect(readFileSync(a.path, "utf8")).toBe("prompt A");
    b.cleanup();
    a.cleanup();
    expect(existsSync(a.path)).toBe(false);
  });

  it("never throws when the OS refuses removal, as Windows does for a file still held open", () => {
    const rm = vi.fn(() => {
      throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    });
    const file = createSystemPromptFile("prompt", { rm });
    expect(() => file.cleanup()).not.toThrow();
    expect(rm).toHaveBeenCalledWith(dirname(file.path), expect.objectContaining({ recursive: true, force: true }));
    rmSync(dirname(file.path), { recursive: true, force: true });
  });

  it("does not write any file while building arguments", () => {
    const args = buildDroidSpawnArgs("droid-pro", undefined);
    expect(args).not.toContain("--append-system-prompt");
  });
});
