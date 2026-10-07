import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareNativeCommand, resolveWindowsExecutable } from "../process/windows-command.js";

/*
FNXC:ProcessLifecycle 2026-10-07-18:00:
A CLI launch succeeds for every supported Windows install method: native .exe, npm/pnpm .cmd shims, and paths with spaces.
Arguments reach the target program unchanged, including spaces, quotes and cmd.exe metacharacters.
*/
// NTFS paths are case-insensitive; the fake filesystem must be too.
function fakeFiles(paths: string[]): (path: string) => boolean {
  const lower = new Set(paths.map((p) => p.toLowerCase()));
  return (path) => lower.has(path.toLowerCase());
}

describe("resolveWindowsExecutable", () => {
  const env = { PATH: "C:\\tools;C:\\Users\\me\\AppData\\Roaming\\npm", PATHEXT: ".COM;.EXE;.BAT;.CMD" };

  it("finds a bare name through PATH and PATHEXT in extension order", () => {
    const files = new Set(["C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd", "C:\\tools\\claude.exe"]);
    expect(resolveWindowsExecutable("claude", { env, isFile: (p) => files.has(p) })).toBe("C:\\tools\\claude.exe");
  });

  it("finds an npm .cmd shim when no native executable exists", () => {
    const files = new Set(["C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd"]);
    expect(resolveWindowsExecutable("claude", { env, isFile: (p) => files.has(p) })).toBe("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd");
  });

  it("checks a name that already has an extension or a directory as given", () => {
    const files = new Set(["C:\\tools\\pnpm.cmd", "D:\\My Apps\\opencode.exe"]);
    const isFile = (p: string) => files.has(p);
    expect(resolveWindowsExecutable("pnpm.cmd", { env, isFile })).toBe("C:\\tools\\pnpm.cmd");
    expect(resolveWindowsExecutable("D:\\My Apps\\opencode", { env, isFile })).toBe("D:\\My Apps\\opencode.exe");
  });

  it("reads PATH and PATHEXT case-insensitively and returns null when nothing matches", () => {
    const mixedCase = { Path: "C:\\tools", PathExt: ".CMD" };
    const resolved = resolveWindowsExecutable("codex", { env: mixedCase, isFile: fakeFiles(["C:\\tools\\codex.CMD"]) });
    expect(resolved?.toLowerCase()).toBe("c:\\tools\\codex.cmd");
    expect(resolveWindowsExecutable("missing", { env, isFile: () => false })).toBeNull();
  });
});

describe("prepareNativeCommand", () => {
  const env = { PATH: "C:\\Program Files\\nodejs", PATHEXT: ".EXE;.CMD", ComSpec: "C:\\Windows\\system32\\cmd.exe" };

  it("passes commands through unchanged off Windows", () => {
    expect(prepareNativeCommand("claude", ["--version"], { platform: "linux", env })).toEqual({
      command: "claude",
      args: ["--version"],
      windowsVerbatimArguments: false,
    });
  });

  it("launches a resolved native executable directly by its full path", () => {
    const files = new Set(["C:\\Program Files\\nodejs\\opencode.exe"]);
    expect(prepareNativeCommand("opencode", ["models"], { platform: "win32", env, isFile: (p) => files.has(p) })).toEqual({
      command: "C:\\Program Files\\nodejs\\opencode.exe",
      args: ["models"],
      windowsVerbatimArguments: false,
    });
  });

  it("wraps a .cmd shim in cmd.exe /d /s /c with a verbatim, escaped command line", () => {
    const files = new Set(["C:\\Program Files\\nodejs\\pnpm.cmd"]);
    const prepared = prepareNativeCommand("pnpm", ["exec", "a b"], {
      platform: "win32",
      env,
      isFile: (p) => files.has(p),
      readText: () => "@node pnpm.cjs %*",
    });
    expect(prepared.command).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(prepared.windowsVerbatimArguments).toBe(true);
    expect(prepared.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(prepared.args[3].startsWith('"C:\\Program^ Files\\nodejs\\pnpm.cmd ')).toBe(true);
  });

  it("returns an unresolvable name unchanged so the caller sees ENOENT", () => {
    expect(prepareNativeCommand("nope", ["x"], { platform: "win32", env, isFile: () => false })).toEqual({
      command: "nope",
      args: ["x"],
      windowsVerbatimArguments: false,
    });
  });

  const itWin32 = process.platform === "win32" ? it : it.skip;
  itWin32("delivers every argument unchanged through a real .cmd shim in a directory with spaces", () => {
    const root = mkdtempSync(join(os.tmpdir(), "fn win cmd "));
    try {
      const echoScript = join(root, "echo-args.cjs");
      writeFileSync(echoScript, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
      writeFileSync(join(root, "echo-args.cmd"), `@"${process.execPath}" "${echoScript}" %*\r\n`);
      const args = ["plain", "with space", 'quote"inside', "a&b|c<d>e", "100%", "caret^", "trailing\\"];

      const prepared = prepareNativeCommand("echo-args", args, { env: { ...process.env, PATH: `${root};${process.env.PATH ?? ""}` } });
      const result = spawnSync(prepared.command, prepared.args, {
        windowsVerbatimArguments: prepared.windowsVerbatimArguments,
        encoding: "utf8",
      });

      expect(result.error).toBeUndefined();
      expect(JSON.parse(result.stdout)).toEqual(args);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
