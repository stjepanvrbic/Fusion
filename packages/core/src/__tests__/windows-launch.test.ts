import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  UnlaunchableCommandError,
  WINDOWS_BASE_ENV_KEYS,
  killProcessTree,
  resolveShellFreeLaunch,
  withPlatformBaseEnvKeys,
} from "../process/windows-launch.js";

const NPM_SHIM = [
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
  "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@vibe-kit\\grok-cli\\dist\\index.js\" %*",
  "",
].join("\r\n");

const PNPM_SHIM = [
  "@SETLOCAL",
  "@IF NOT DEFINED NODE_PATH (",
  "  @SET \"NODE_PATH=C:\\x\\node_modules\"",
  ")",
  "@IF EXIST \"%~dp0\\node.exe\" (",
  "  \"%~dp0\\node.exe\"  \"%~dp0\\..\\claude-code-cli-acp\\bin\\claude-code-cli-acp.js\" %*",
  ") ELSE (",
  "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
  "  node  \"%~dp0\\..\\claude-code-cli-acp\\bin\\claude-code-cli-acp.js\" %*",
  ")",
].join("\r\n");

const FUSION_BRIDGE_SHIM = "@echo off\r\nnode \"%~dp0node_modules\\claude-code-cli-acp\\bin\\claude-code-cli-acp.js\" %*\r\n";
const NATIVE_EXE_SHIM = "@ECHO off\r\n\"%~dp0\\node_modules\\@openai\\codex\\bin\\codex.exe\"   %*\r\n";

function fakeFs(files: Record<string, string>) {
  const lower = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    isFile: (p: string) => lower.has(p.toLowerCase()),
    readFile: (p: string) => {
      const value = lower.get(p.toLowerCase());
      if (value === undefined) throw new Error(`ENOENT ${p}`);
      return value;
    },
  };
}

const winEnv = { PATH: "C:\\first;C:\\npm;C:\\Program Files\\nodejs", PATHEXT: ".COM;.EXE;.BAT;.CMD" };
const winBase = { platform: "win32" as const, env: winEnv, execPath: "C:\\Program Files\\nodejs\\node.exe", isElectron: false };

describe("resolveShellFreeLaunch", () => {
  it("never returns a batch file or a shell for any Windows shim shape", () => {
    const cases: Array<{ name: string; files: Record<string, string>; command: string; expect: { command: string; args: string[] } }> = [
      {
        name: "npm cmd-shim targeting a JS entry",
        files: { "C:\\npm\\grok.cmd": NPM_SHIM, "C:\\npm\\node_modules\\@vibe-kit\\grok-cli\\dist\\index.js": "" },
        command: "grok",
        expect: { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\npm\\node_modules\\@vibe-kit\\grok-cli\\dist\\index.js", "agent", "stdio"] },
      },
      {
        name: "pnpm .bin shim",
        files: { "C:\\p\\node_modules\\.bin\\claude-code-cli-acp.cmd": PNPM_SHIM, "C:\\p\\node_modules\\claude-code-cli-acp\\bin\\claude-code-cli-acp.js": "" },
        command: "C:\\p\\node_modules\\.bin\\claude-code-cli-acp.cmd",
        expect: { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\p\\node_modules\\claude-code-cli-acp\\bin\\claude-code-cli-acp.js", "agent", "stdio"] },
      },
      {
        name: "Fusion's staged bridge wrapper",
        files: { "C:\\plug\\bridge\\claude-code-cli-acp.cmd": FUSION_BRIDGE_SHIM, "C:\\plug\\bridge\\node_modules\\claude-code-cli-acp\\bin\\claude-code-cli-acp.js": "" },
        command: "C:\\plug\\bridge\\claude-code-cli-acp.cmd",
        expect: { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\plug\\bridge\\node_modules\\claude-code-cli-acp\\bin\\claude-code-cli-acp.js", "agent", "stdio"] },
      },
      {
        name: "shim wrapping a native executable",
        files: { "C:\\npm\\codex.cmd": NATIVE_EXE_SHIM, "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.exe": "" },
        command: "codex",
        expect: { command: "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.exe", args: ["agent", "stdio"] },
      },
    ];
    for (const testCase of cases) {
      const launch = resolveShellFreeLaunch(testCase.command, ["agent", "stdio"], { ...winBase, ...fakeFs(testCase.files) });
      expect(launch.command, testCase.name).toBe(testCase.expect.command);
      expect(launch.args, testCase.name).toEqual(testCase.expect.args);
      expect(launch.command.toLowerCase(), testCase.name).not.toMatch(/\.(cmd|bat)$/);
    }
  });

  it("prefers node.exe staged beside the shim, as the shim itself does", () => {
    const files = { "C:\\npm\\grok.cmd": NPM_SHIM, "C:\\npm\\node.exe": "", "C:\\npm\\node_modules\\@vibe-kit\\grok-cli\\dist\\index.js": "" };
    const launch = resolveShellFreeLaunch("grok", [], { ...winBase, ...fakeFs(files) });
    expect(launch.command).toBe("C:\\npm\\node.exe");
  });

  it("uses PATH node when the host runtime is Electron", () => {
    const files = { "C:\\npm\\grok.cmd": NPM_SHIM, "C:\\Program Files\\nodejs\\node.exe": "", "C:\\npm\\node_modules\\@vibe-kit\\grok-cli\\dist\\index.js": "" };
    const launch = resolveShellFreeLaunch("grok", [], { ...winBase, execPath: "C:\\Fusion\\Fusion.exe", isElectron: true, ...fakeFs(files) });
    expect(launch.command).toBe("C:\\Program Files\\nodejs\\node.exe");
  });

  it("searches the first PATH directory before later ones, then PATHEXT order within it", () => {
    const ompShim = FUSION_BRIDGE_SHIM.replace("claude-code-cli-acp\\bin\\claude-code-cli-acp.js", "omp\\cli.js");
    const files = { "C:\\first\\omp.cmd": ompShim, "C:\\first\\node_modules\\omp\\cli.js": "", "C:\\first\\omp.exe": "", "C:\\npm\\omp.exe": "" };
    expect(resolveShellFreeLaunch("omp", [], { ...winBase, ...fakeFs(files) }).command).toBe("C:\\first\\omp.exe");
    const cmdOnly = { "C:\\first\\omp.cmd": ompShim, "C:\\first\\node_modules\\omp\\cli.js": "", "C:\\npm\\omp.exe": "" };
    expect(resolveShellFreeLaunch("omp", [], { ...winBase, ...fakeFs(cmdOnly) }).args).toEqual(["C:\\first\\node_modules\\omp\\cli.js"]);
  });

  it("resolves an extensionless explicit path through PATHEXT", () => {
    const files = { "C:\\tools\\droid.exe": "" };
    expect(resolveShellFreeLaunch("C:\\tools\\droid", ["-p"], { ...winBase, ...fakeFs(files) }).command).toBe("C:\\tools\\droid.exe");
  });

  it("returns an unresolvable bare name unchanged so spawn reports ENOENT", () => {
    expect(resolveShellFreeLaunch("droid", ["--version"], { ...winBase, ...fakeFs({}) })).toEqual({ command: "droid", args: ["--version"] });
  });

  it("refuses an unparseable batch file or script instead of handing it to a shell", () => {
    const files = { "C:\\npm\\weird.cmd": "@echo off\r\ncall something-else.bat %*\r\n" };
    expect(() => resolveShellFreeLaunch("weird", [], { ...winBase, ...fakeFs(files) })).toThrow(UnlaunchableCommandError);
    expect(() => resolveShellFreeLaunch("C:\\x\\tool.ps1", [], { ...winBase, ...fakeFs({ "C:\\x\\tool.ps1": "" }) })).toThrow(UnlaunchableCommandError);
    const missingTarget = { "C:\\npm\\grok.cmd": NPM_SHIM };
    expect(() => resolveShellFreeLaunch("grok", [], { ...winBase, ...fakeFs(missingTarget) })).toThrow(UnlaunchableCommandError);
  });

  it("launches a JS entry through node on every platform", () => {
    expect(resolveShellFreeLaunch("/opt/plug/bridge/entry.js", ["a"], { platform: "linux", env: {}, execPath: "/usr/bin/node", isElectron: false, ...fakeFs({}) }))
      .toEqual({ command: "/usr/bin/node", args: ["/opt/plug/bridge/entry.js", "a"], resolvedPath: "/opt/plug/bridge/entry.js" });
    expect(resolveShellFreeLaunch("C:\\plug\\bridge\\entry.mjs", ["a"], { ...winBase, ...fakeFs({}) }))
      .toEqual({ command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\plug\\bridge\\entry.mjs", "a"], resolvedPath: "C:\\plug\\bridge\\entry.mjs" });
  });

  it("leaves POSIX commands untouched", () => {
    expect(resolveShellFreeLaunch("grok", ["agent"], { platform: "linux", env: { PATH: "/usr/bin" }, ...fakeFs({}) })).toEqual({ command: "grok", args: ["agent"] });
  });
});

describe("withPlatformBaseEnvKeys", () => {
  it("adds the Windows base keys only on win32", () => {
    const win = withPlatformBaseEnvKeys(["HOME", "PATH"], "win32");
    for (const key of ["SystemRoot", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "ComSpec"]) expect(win).toContain(key);
    expect(new Set(win).size).toBe(win.length);
    expect(withPlatformBaseEnvKeys(["HOME", "PATH"], "linux")).toEqual(["HOME", "PATH"]);
    expect(WINDOWS_BASE_ENV_KEYS).not.toContain("ANTHROPIC_API_KEY");
  });
});

describe("killProcessTree", () => {
  function fakeChild(pid: number | undefined) {
    const child = new EventEmitter() as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn> };
    Object.assign(child, { pid, killed: false, exitCode: null, signalCode: null, kill: vi.fn() });
    return child;
  }

  it("terminates the whole tree with taskkill on Windows", () => {
    const child = fakeChild(4321);
    const spawnImpl = vi.fn(() => new EventEmitter() as unknown as ChildProcess);
    killProcessTree(child, { platform: "win32", spawnImpl });
    expect(spawnImpl).toHaveBeenCalledWith("taskkill", ["/PID", "4321", "/T", "/F"], expect.objectContaining({ shell: false, windowsHide: true }));
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("falls back to a direct kill when taskkill cannot start", () => {
    const child = fakeChild(4321);
    const killer = new EventEmitter() as unknown as ChildProcess;
    killProcessTree(child, { platform: "win32", spawnImpl: () => killer });
    killer.emit("error", new Error("ENOENT"));
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("uses SIGKILL off Windows and no-ops on exited children", () => {
    const child = fakeChild(10);
    killProcessTree(child, { platform: "linux", spawnImpl: vi.fn() });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    const exited = fakeChild(11);
    Object.assign(exited, { exitCode: 0 });
    const spawnImpl = vi.fn();
    killProcessTree(exited, { platform: "win32", spawnImpl });
    expect(spawnImpl).not.toHaveBeenCalled();
    const alreadyKilled = fakeChild(12);
    Object.assign(alreadyKilled, { killed: true });
    killProcessTree(alreadyKilled, { platform: "linux", spawnImpl });
    expect(alreadyKilled.kill).not.toHaveBeenCalled();
  });
});
