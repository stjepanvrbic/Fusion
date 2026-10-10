import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChildProcess } from "node:child_process";

// Mock child_process.spawn before importing process-manager
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(() => {
    const EventEmitter = require("node:events");
    const proc = new EventEmitter();
    proc.stdin = new EventEmitter();
    proc.stdin.write = vi.fn();
    proc.stdin.end = vi.fn();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.killed = false;
    proc.kill = vi.fn(() => {
      proc.killed = true;
    });
    proc.pid = 12345;
    return proc;
  }),
}));

const mocks = vi.hoisted(() => {
  let dirSeq = 0;
  return {
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    mkdtempSync: vi.fn((prefix: string) => `${prefix}${++dirSeq}`),
    rmSync: vi.fn(),
    tmpdir: vi.fn(() => "/mock-tmp"),
  };
});

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  writeFileSync: mocks.writeFileSync,
  unlinkSync: mocks.unlinkSync,
  existsSync: mocks.existsSync,
  readFileSync: mocks.readFileSync,
  mkdtempSync: mocks.mkdtempSync,
  rmSync: mocks.rmSync,
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  tmpdir: mocks.tmpdir,
}));

// Observe the shared launch seam while keeping its real resolution.
vi.mock("../windows-launch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../windows-launch.js")>();
  return { ...actual, resolveShellFreeLaunch: vi.fn(actual.resolveShellFreeLaunch) };
});

/*
FNXC:ClaudeCliProvider 2026-10-07-19:34:
These cases assert POSIX launch and SIGKILL semantics on fake processes. Pin a POSIX host so a Windows runner, where launches resolve through PATHEXT and kills go through taskkill, exercises the same contract.
The Windows launch and tree-kill cases below override the pin explicitly.
*/
beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
});

import { spawn } from "node:child_process";
import { resolveShellFreeLaunch } from "../windows-launch.js";
import {
  spawnClaude,
  buildClaudeSpawnArgs,
  writeUserMessage,
  cleanupProcess,
  captureStderr,
  validateCliPresenceAsync,
  validateCliAuthAsync,
  forceKillProcess,
  registerProcess,
  killAllProcesses,
  createSystemPromptFile,
} from "../process-manager";

describe("buildClaudeSpawnArgs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.writeFileSync.mockReset();
    mocks.tmpdir.mockReset();
    mocks.tmpdir.mockReturnValue("/mock-tmp");
  });

  it("builds args including model and optional session/mcp flags", () => {
    const args = buildClaudeSpawnArgs("claude-sonnet-4-6", undefined, {
      resumeSessionId: "sess-1",
      effort: "high",
      mcpConfigPath: "/tmp/mcp.json",
    });

    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-4-6");
    expect(args).toContain("--resume");
    expect(args).toContain("sess-1");
    expect(args).toContain("--effort");
    expect(args).toContain("high");
    expect(args).toContain("--mcp-config");
    expect(args).toContain("/tmp/mcp.json");
  });
});

describe("spawnClaude", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.writeFileSync.mockReset();
    mocks.existsSync.mockReset();
    mocks.readFileSync.mockReset();
    mocks.tmpdir.mockReset();
    mocks.tmpdir.mockReturnValue("/mock-tmp");
  });

  it("spawns claude with all required CLI flags", () => {
    spawnClaude("claude-sonnet-4-5-20250929");

    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args] = (spawn as any).mock.calls[0];

    expect(cmd).toBe("claude");
    expect(args).toContain("-p");
    expect(args).toContain("--input-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--output-format");
    expect(args).toContain("--verbose");
    expect(args).toContain("--include-partial-messages");
    expect(args).not.toContain("--no-session-persistence");
    expect(args).toContain("--model");
    expect(args).toContain("claude-sonnet-4-5-20250929");
    expect(args).not.toContain("--permission-prompt-tool");
    expect(args).not.toContain("stdio");
  });

  it("passes stream-json for both input-format and output-format", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const args = (spawn as any).mock.calls[0][1] as string[];

    const inputFormatIdx = args.indexOf("--input-format");
    expect(args[inputFormatIdx + 1]).toBe("stream-json");

    const outputFormatIdx = args.indexOf("--output-format");
    expect(args[outputFormatIdx + 1]).toBe("stream-json");
  });

  it("sets stdio to pipe for stdin, stdout, and stderr", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const options = (spawn as any).mock.calls[0][2];
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
  });

  it("passes cwd from options when provided", () => {
    spawnClaude("claude-sonnet-4-5-20250929", undefined, {
      cwd: "/custom/path",
    });
    const options = (spawn as any).mock.calls[0][2];
    expect(options.cwd).toBe("/custom/path");
  });

  it("passes the prompt file path via --append-system-prompt-file, never as literal --append-system-prompt text", () => {
    const promptFile = createSystemPromptFile("You are a helpful assistant.");
    spawnClaude("claude-sonnet-4-5-20250929", promptFile.path);
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).not.toContain("--append-system-prompt");
    const idx = args.indexOf("--append-system-prompt-file");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe(promptFile.path);
    expect(mocks.writeFileSync).toHaveBeenCalledWith(promptFile.path, "You are a helpful assistant.", "utf-8");
  });

  it("writes no files itself", () => {
    spawnClaude("claude-sonnet-4-5-20250929", "/given/prompt.txt");
    expect(mocks.writeFileSync).not.toHaveBeenCalled();
    expect(mocks.mkdtempSync).not.toHaveBeenCalled();
  });

  it("does not include a system prompt flag when no system prompt file", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const args = (spawn as any).mock.calls[0][1] as string[];
    expect(args).not.toContain("--append-system-prompt");
    expect(args).not.toContain("--append-system-prompt-file");
  });

  it("spawns without a shell", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const options = (spawn as any).mock.calls[0][2];
    expect(options.shell).toBe(false);
    expect(options.windowsHide).toBe(true);
  });

  it("launches whatever the shared shell-free seam resolves, so an npm claude.cmd shim runs as node plus its entry", () => {
    vi.mocked(resolveShellFreeLaunch).mockImplementationOnce((_command, args) => ({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js", ...args],
    }));
    spawnClaude("claude-sonnet-4-5-20250929");

    expect(resolveShellFreeLaunch).toHaveBeenCalledWith("claude", expect.arrayContaining(["--model"]));
    const [cmd, args] = (spawn as any).mock.calls[0];
    expect(cmd).toBe("C:\\Program Files\\nodejs\\node.exe");
    expect(args[0]).toBe("C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js");
    expect(args).toContain("--model");
  });

  it("listens for stdin errors so an early CLI exit cannot crash the host with EPIPE", () => {
    const proc = spawnClaude("claude-sonnet-4-5-20250929") as any;
    expect(proc.stdin.listenerCount("error")).toBe(1);
    expect(() => proc.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).not.toThrow();
  });

  it("returns the spawned ChildProcess", () => {
    const proc = spawnClaude("claude-sonnet-4-5-20250929");
    expect(proc).toBeDefined();
    expect(proc.pid).toBe(12345);
  });
});

describe("effort flag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes --effort and high in args when effort is high", () => {
    spawnClaude("claude-sonnet-4-5-20250929", undefined, { effort: "high" });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--effort");
    const idx = args.indexOf("--effort");
    expect(args[idx + 1]).toBe("high");
  });

  it("includes --effort and max in args when effort is max", () => {
    spawnClaude("claude-opus-4-6-20260301", undefined, { effort: "max" });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--effort");
    const idx = args.indexOf("--effort");
    expect(args[idx + 1]).toBe("max");
  });

  it("includes --effort and low in args when effort is low", () => {
    spawnClaude("claude-sonnet-4-5-20250929", undefined, { effort: "low" });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--effort");
    const idx = args.indexOf("--effort");
    expect(args[idx + 1]).toBe("low");
  });

  it("does NOT include --effort when effort is undefined", () => {
    spawnClaude("claude-sonnet-4-5-20250929", undefined, { cwd: "/some/path" });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).not.toContain("--effort");
  });

  it("does NOT include --effort when options is undefined", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).not.toContain("--effort");
  });

  it("is backward compatible - existing calls without effort still work", () => {
    spawnClaude("claude-sonnet-4-5-20250929", "/prompt/system-prompt.txt", {
      cwd: "/path",
    });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--append-system-prompt-file");
    expect(args).not.toContain("--effort");
  });
});

describe("writeUserMessage", () => {
  it("writes correct NDJSON user message to stdin", () => {
    const mockStdin = { write: vi.fn(), end: vi.fn() };
    const proc = { stdin: mockStdin } as unknown as ChildProcess;

    writeUserMessage(proc, "Hello Claude");

    expect(mockStdin.write).toHaveBeenCalledTimes(1);
    const written = mockStdin.write.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(parsed.type).toBe("user");
    expect(parsed.message.role).toBe("user");
    expect(parsed.message.content).toBe("Hello Claude");
  });

  it("appends newline to the JSON", () => {
    const mockStdin = { write: vi.fn(), end: vi.fn() };
    const proc = { stdin: mockStdin } as unknown as ChildProcess;

    writeUserMessage(proc, "test");

    const written = mockStdin.write.mock.calls[0][0] as string;
    expect(written.endsWith("\n")).toBe(true);
  });

  it("calls stdin.end() after writing user message", () => {
    const mockStdin = { write: vi.fn(), end: vi.fn() };
    const proc = { stdin: mockStdin } as unknown as ChildProcess;

    writeUserMessage(proc, "test");

    expect(mockStdin.end).toHaveBeenCalledTimes(1);
  });

  it("sends string content in NDJSON when given string", () => {
    const mockStdin = { write: vi.fn(), end: vi.fn() };
    const proc = { stdin: mockStdin } as unknown as ChildProcess;

    writeUserMessage(proc, "hello");

    const written = mockStdin.write.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(typeof parsed.message.content).toBe("string");
    expect(parsed.message.content).toBe("hello");
  });

  it("sends array content in NDJSON when given ContentBlock[]", () => {
    const mockStdin = { write: vi.fn(), end: vi.fn() };
    const proc = { stdin: mockStdin } as unknown as ChildProcess;

    const blocks = [
      { type: "text", text: "hello" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "abc" },
      },
    ];
    writeUserMessage(proc, blocks as any);

    const written = mockStdin.write.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(Array.isArray(parsed.message.content)).toBe(true);
    expect(parsed.message.content).toEqual(blocks);
  });
});

describe("cleanupProcess", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("kills the process with SIGKILL after 500ms grace period", () => {
    const mockProc: any = {
      killed: false,
      exitCode: null,
      kill: vi.fn(() => {
        mockProc.killed = true;
      }),
    };

    cleanupProcess(mockProc as ChildProcess);

    // Not killed immediately
    expect(mockProc.kill).not.toHaveBeenCalled();

    // Not killed at 400ms
    vi.advanceTimersByTime(400);
    expect(mockProc.kill).not.toHaveBeenCalled();

    // Killed after 500ms grace period
    vi.advanceTimersByTime(100);
    expect(mockProc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("does not kill if process is already killed", () => {
    const proc = {
      killed: true,
      exitCode: null,
      kill: vi.fn(),
    } as unknown as ChildProcess;

    cleanupProcess(proc);
    vi.advanceTimersByTime(500);

    expect(proc.kill).not.toHaveBeenCalled();
  });
});

describe("captureStderr", () => {
  it("returns a function that accumulates stderr data", () => {
    const EventEmitter = require("node:events");
    const stderr = new EventEmitter();
    const proc = { stderr } as unknown as ChildProcess;

    const getStderr = captureStderr(proc);

    stderr.emit("data", Buffer.from("error line 1\n"));
    stderr.emit("data", Buffer.from("error line 2\n"));

    expect(getStderr()).toBe("error line 1\nerror line 2\n");
  });

  it("returns empty string when no stderr data", () => {
    const EventEmitter = require("node:events");
    const stderr = new EventEmitter();
    const proc = { stderr } as unknown as ChildProcess;

    const getStderr = captureStderr(proc);
    expect(getStderr()).toBe("");
  });
});

describe("validateCliPresenceAsync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves ok=true when claude --version exits 0", async () => {
    const EventEmitter = require("node:events");
    (spawn as any).mockImplementationOnce(() => {
      const proc = new EventEmitter();
      proc.kill = vi.fn();
      setImmediate(() => proc.emit("exit", 0));
      return proc;
    });

    const result = await validateCliPresenceAsync();
    expect(result).toEqual({ ok: true });
    const args = (spawn as any).mock.calls[0][1] as string[];
    expect(args).toEqual(["--version"]);
  });

  it("resolves ok=false with install message when spawn errors", async () => {
    const EventEmitter = require("node:events");
    (spawn as any).mockImplementationOnce(() => {
      const proc = new EventEmitter();
      proc.kill = vi.fn();
      setImmediate(() => proc.emit("error", new Error("ENOENT")));
      return proc;
    });

    const result = await validateCliPresenceAsync();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Claude Code CLI not found");
      expect(result.error.message).toContain("npm install");
    }
  });

  it("resolves ok=false when claude --version exits non-zero", async () => {
    const EventEmitter = require("node:events");
    (spawn as any).mockImplementationOnce(() => {
      const proc = new EventEmitter();
      proc.kill = vi.fn();
      setImmediate(() => proc.emit("exit", 1));
      return proc;
    });

    const result = await validateCliPresenceAsync();
    expect(result.ok).toBe(false);
  });

  it("probes the same shell-free launch the session uses", async () => {
    const EventEmitter = require("node:events");
    vi.mocked(resolveShellFreeLaunch).mockImplementationOnce((_command, args) => ({
      command: "/resolved/node",
      args: ["/resolved/cli.js", ...args],
    }));
    (spawn as any).mockImplementationOnce(() => {
      const proc = new EventEmitter();
      proc.kill = vi.fn();
      setImmediate(() => proc.emit("exit", 0));
      return proc;
    });

    await expect(validateCliPresenceAsync()).resolves.toEqual({ ok: true });
    const [cmd, args, options] = (spawn as any).mock.calls[0];
    expect(cmd).toBe("/resolved/node");
    expect(args).toEqual(["/resolved/cli.js", "--version"]);
    expect(options.shell).toBe(false);
  });

  it("resolves ok=false when the claude shim cannot be launched without a shell", async () => {
    vi.mocked(resolveShellFreeLaunch).mockImplementationOnce(() => {
      throw new Error("Cannot launch claude (C:\\bin\\claude.bat) without a command shell");
    });

    await expect(validateCliPresenceAsync()).resolves.toMatchObject({ ok: false });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("resolves ok=false instead of rejecting when claude spawn throws synchronously", async () => {
    (spawn as any).mockImplementationOnce(() => {
      throw new Error("Real AI CLI launch blocked during tests: claude --version");
    });

    await expect(validateCliPresenceAsync()).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe("validateCliAuthAsync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves true when claude auth status exits 0", async () => {
    const EventEmitter = require("node:events");
    (spawn as any).mockImplementationOnce(() => {
      const proc = new EventEmitter();
      proc.kill = vi.fn();
      setImmediate(() => proc.emit("exit", 0));
      return proc;
    });

    expect(await validateCliAuthAsync()).toBe(true);
    const args = (spawn as any).mock.calls[0][1] as string[];
    expect(args).toEqual(["auth", "status"]);
  });

  it("resolves false and warns when claude auth status fails", async () => {
    const EventEmitter = require("node:events");
    (spawn as any).mockImplementationOnce(() => {
      const proc = new EventEmitter();
      proc.kill = vi.fn();
      setImmediate(() => proc.emit("exit", 1));
      return proc;
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await validateCliAuthAsync()).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("not authenticated"),
    );
    warnSpy.mockRestore();
  });

  it("resolves false instead of rejecting when claude auth spawn throws synchronously", async () => {
    (spawn as any).mockImplementationOnce(() => {
      throw new Error(
        "Real AI CLI launch blocked during tests: claude auth status",
      );
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(validateCliAuthAsync()).resolves.toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("not authenticated"),
    );
    warnSpy.mockRestore();
  });
});

describe("CLI flags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spawnClaude does NOT include --permission-mode or dontAsk in args", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("dontAsk");
  });

  it("spawnClaude does NOT include --permission-prompt-tool in args", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).not.toContain("--permission-prompt-tool");
  });
});

describe("mcp-config flag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spawnClaude with mcpConfigPath includes --mcp-config followed by the path", () => {
    spawnClaude("claude-sonnet-4-5-20250929", undefined, {
      mcpConfigPath: "/tmp/mcp-config.json",
    });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--mcp-config");
    const idx = args.indexOf("--mcp-config");
    expect(args[idx + 1]).toBe("/tmp/mcp-config.json");
  });

  it("spawnClaude without mcpConfigPath does NOT include --mcp-config in args", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).not.toContain("--mcp-config");
  });

  /*
  FNXC:ClaudeCliToolOwnership 2026-10-10-20:56:
  Fusion is the only executor of a tool call, so the CLI is launched with no built-in tools and only the MCP servers Fusion passes.
  This replaces the earlier rule that the CLI kept the operator's own Claude Code MCP servers; Fusion's `mcpServers` setting is the way to give a session an MCP server.
  */
  it("launches the CLI with no built-in tools and no MCP servers of its own", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--tools=");
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--allowedTools");
  });

  it("pre-approves the schema server's tools when Fusion passes an MCP config", () => {
    spawnClaude("claude-sonnet-4-5-20250929", undefined, {
      mcpConfigPath: "/tmp/mcp-config.json",
    });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--tools=");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__custom-tools");
  });

  it("backward compatibility - existing calls with only effort/cwd still work", () => {
    spawnClaude("claude-sonnet-4-5-20250929", "/prompt/system-prompt.txt", {
      cwd: "/path",
      effort: "high",
    });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--append-system-prompt-file");
    expect(args).toContain("--effort");
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--permission-prompt-tool");
  });
});

describe("forceKillProcess", () => {
  it("calls proc.kill('SIGKILL') on live process", () => {
    const proc = {
      killed: false,
      exitCode: null,
      kill: vi.fn(),
    } as unknown as ChildProcess;

    forceKillProcess(proc);

    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("no-ops when proc.killed is true", () => {
    const proc = {
      killed: true,
      exitCode: null,
      kill: vi.fn(),
    } as unknown as ChildProcess;

    forceKillProcess(proc);

    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("no-ops when proc.exitCode is not null", () => {
    const proc = {
      killed: false,
      exitCode: 0,
      kill: vi.fn(),
    } as unknown as ChildProcess;

    forceKillProcess(proc);

    expect(proc.kill).not.toHaveBeenCalled();
  });
});

describe("forceKillProcess on Windows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  });

  it("kills the whole process tree with taskkill, not just the direct child", () => {
    const EventEmitter = require("node:events");
    const killer = new EventEmitter();
    killer.unref = vi.fn();
    (spawn as any).mockImplementationOnce(() => killer);
    const proc = { pid: 4242, killed: false, exitCode: null, signalCode: null, kill: vi.fn() } as unknown as ChildProcess;

    forceKillProcess(proc);

    const [cmd, args, options] = (spawn as any).mock.calls[0];
    // Core resolves taskkill under %SystemRoot%\System32 when it is set.
    expect(cmd).toMatch(/(^|[\\/])taskkill(\.exe)?$/i);
    expect(args).toEqual(["/PID", "4242", "/T", "/F"]);
    expect(options.shell).toBe(false);
  });
});

describe("process registry", () => {
  beforeEach(() => {
    // Clear registry between tests
    killAllProcesses();
    vi.clearAllMocks();
  });

  it("registerProcess adds proc and killAllProcesses kills it", () => {
    const EventEmitter = require("node:events");
    const proc = new EventEmitter();
    proc.killed = false;
    proc.exitCode = null;
    proc.kill = vi.fn(() => {
      proc.killed = true;
    });

    registerProcess(proc as unknown as ChildProcess);
    killAllProcesses();

    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("proc exit event removes from registry", () => {
    const EventEmitter = require("node:events");
    const proc = new EventEmitter();
    proc.killed = false;
    proc.exitCode = null;
    proc.kill = vi.fn(() => {
      proc.killed = true;
    });

    registerProcess(proc as unknown as ChildProcess);

    // Simulate natural exit
    proc.exitCode = 0;
    proc.emit("exit", 0, null);

    // Clear mock to check killAllProcesses doesn't call kill again
    proc.kill.mockClear();
    proc.killed = false;
    proc.exitCode = null;

    killAllProcesses();

    // Should NOT have been killed since it was removed on exit
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("killAllProcesses clears set and handles already-dead processes", () => {
    const EventEmitter = require("node:events");
    const proc1 = new EventEmitter();
    proc1.killed = true; // already dead
    proc1.exitCode = null;
    proc1.kill = vi.fn();

    const proc2 = new EventEmitter();
    proc2.killed = false;
    proc2.exitCode = 1; // already exited
    proc2.kill = vi.fn();

    const proc3 = new EventEmitter();
    proc3.killed = false;
    proc3.exitCode = null; // alive
    proc3.kill = vi.fn(() => {
      proc3.killed = true;
    });

    registerProcess(proc1 as unknown as ChildProcess);
    registerProcess(proc2 as unknown as ChildProcess);
    registerProcess(proc3 as unknown as ChildProcess);

    killAllProcesses();

    // Already dead -- forceKillProcess should no-op
    expect(proc1.kill).not.toHaveBeenCalled();
    expect(proc2.kill).not.toHaveBeenCalled();
    // Live process should be killed
    expect(proc3.kill).toHaveBeenCalledWith("SIGKILL");

    // Calling again should not kill anything (set was cleared)
    proc3.kill.mockClear();
    proc3.killed = false;
    proc3.exitCode = null;
    killAllProcesses();
    expect(proc3.kill).not.toHaveBeenCalled();
  });
});

describe("resume session flag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes --resume followed by session ID when resumeSessionId is provided", () => {
    spawnClaude("claude-sonnet-4-5-20250929", undefined, {
      resumeSessionId: "session-abc-123",
    });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--resume");
    const idx = args.indexOf("--resume");
    expect(args[idx + 1]).toBe("session-abc-123");
  });

  it("does NOT include --resume when resumeSessionId is undefined", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).not.toContain("--resume");
  });

  it("does not include --session-id when --resume is provided", () => {
    spawnClaude("claude-sonnet-4-5-20250929", undefined, {
      resumeSessionId: "session-abc",
      newSessionId: "session-new",
    });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--resume");
    expect(args).not.toContain("--session-id");
  });

  it("includes both --resume and --effort when both are provided", () => {
    spawnClaude("claude-sonnet-4-5-20250929", undefined, {
      resumeSessionId: "session-abc",
      effort: "high",
    });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--resume");
    expect(args).toContain("--effort");
  });

  it("includes both --resume and --mcp-config when both are provided", () => {
    spawnClaude("claude-sonnet-4-5-20250929", undefined, {
      resumeSessionId: "session-abc",
      mcpConfigPath: "/tmp/mcp.json",
    });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--resume");
    expect(args).toContain("--mcp-config");
  });
});

describe("createSystemPromptFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rmSync.mockReset();
    mocks.tmpdir.mockReset();
    mocks.tmpdir.mockReturnValue("/mock-tmp");
  });

  it("gives every invocation its own file holding its own prompt", () => {
    const a = createSystemPromptFile("prompt A");
    const b = createSystemPromptFile("prompt B");

    expect(a.path).not.toBe(b.path);
    expect(mocks.writeFileSync).toHaveBeenCalledWith(a.path, "prompt A", "utf-8");
    expect(mocks.writeFileSync).toHaveBeenCalledWith(b.path, "prompt B", "utf-8");
    expect(a.path).not.toContain(String(process.pid));
  });

  it("removes only its own directory, once", () => {
    const a = createSystemPromptFile("prompt A");
    const b = createSystemPromptFile("prompt B");

    a.cleanup();
    a.cleanup();

    expect(mocks.rmSync).toHaveBeenCalledTimes(1);
    const removed = mocks.rmSync.mock.calls[0][0] as string;
    expect(a.path.startsWith(removed)).toBe(true);
    expect(b.path.startsWith(removed)).toBe(false);
  });

  it("does not throw when removal fails", () => {
    mocks.rmSync.mockImplementation(() => {
      throw new Error("EBUSY");
    });

    expect(() => createSystemPromptFile("prompt").cleanup()).not.toThrow();
  });
});
