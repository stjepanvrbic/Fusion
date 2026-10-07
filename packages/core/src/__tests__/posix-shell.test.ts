import { describe, expect, it, vi } from "vitest";
import { bindPosixShell, findPosixShell, resolvePosixShell, withPosixShell, execPosix, type PosixShellHost } from "../process/posix-shell.js";

function host(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, files: string[]): PosixShellHost {
  const existing = new Set(files.map((file) => file.toLowerCase()));
  return { platform, env, fileExists: (path) => existing.has(path.toLowerCase()) };
}

describe("findPosixShell", () => {
  it("returns undefined off Windows so Node keeps its default /bin/sh", () => {
    expect(findPosixShell(host("linux", { PATH: "/usr/bin" }, ["/bin/bash"]))).toBeUndefined();
    expect(findPosixShell(host("darwin", {}, []))).toBeUndefined();
  });

  it("derives Git Bash from the git.exe on PATH for each Git for Windows layout", () => {
    const bash = "D:\\Tools\\Git\\bin\\bash.exe";
    for (const dir of ["D:\\Tools\\Git\\cmd", "D:\\Tools\\Git\\mingw64\\bin", "D:\\Tools\\Git\\usr\\bin", "D:\\Tools\\Git\\bin\\"]) {
      expect(findPosixShell(host("win32", { Path: `C:\\Windows\\System32;${dir}` }, [`${dir.replace(/\\$/, "")}\\git.exe`, bash]))).toBe(bash);
    }
  });

  it("prefers FUSION_POSIX_SHELL when it exists", () => {
    const override = "E:\\msys64\\usr\\bin\\bash.exe";
    expect(findPosixShell(host("win32", { FUSION_POSIX_SHELL: override, ProgramFiles: "C:\\Program Files" }, [override, "C:\\Program Files\\Git\\bin\\bash.exe"]))).toBe(override);
  });

  it("falls back to install roots with case-insensitive env names (MSYS upper-cases them)", () => {
    expect(findPosixShell(host("win32", { PROGRAMFILES: "C:\\Program Files" }, ["C:\\Program Files\\Git\\bin\\bash.exe"]))).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(findPosixShell(host("win32", { localappdata: "C:\\Users\\me\\AppData\\Local" }, ["C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe"]))).toBe(
      "C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe",
    );
  });

  it("never selects the WSL launcher, even as an override", () => {
    const wsl = "C:\\Windows\\System32\\bash.exe";
    expect(findPosixShell(host("win32", { FUSION_POSIX_SHELL: wsl, PATH: "C:\\Windows\\System32" }, [wsl, "C:\\Windows\\System32\\git.exe"]))).toBeUndefined();
  });

  it("returns undefined on Windows when no bash exists", () => {
    expect(findPosixShell(host("win32", { PATH: "C:\\Git\\cmd", ProgramFiles: "C:\\Program Files" }, ["C:\\Git\\cmd\\git.exe"]))).toBeUndefined();
  });
});

describe("withPosixShell / bindPosixShell", () => {
  const shell = resolvePosixShell();

  it("leaves a caller-chosen shell untouched", () => {
    const options = { cwd: "x", shell: "/custom/sh" };
    expect(withPosixShell(options)).toBe(options);
  });

  it("adds the resolved shell only when one is needed", () => {
    const options = { cwd: "x" };
    if (shell) expect(withPosixShell(options)).toEqual({ cwd: "x", shell });
    else expect(withPosixShell(options)).toBe(options);
  });

  it("passes calls through unchanged when no POSIX shell override applies, and injects it otherwise", () => {
    const fn = vi.fn((..._args: unknown[]) => "ok");
    const bound = bindPosixShell(fn as (command: string, ...args: unknown[]) => string);
    bound("git status");
    bound("git status", { cwd: "y" });
    if (shell) {
      expect(fn.mock.calls).toEqual([["git status", { shell }], ["git status", { cwd: "y", shell }]]);
    } else {
      expect(fn.mock.calls).toEqual([["git status"], ["git status", { cwd: "y" }]]);
    }
  });

  it("runs POSIX quoting, redirection and command substitution on the current platform", async () => {
    const { stdout } = await execPosix(`printf '%s|' 'it'\\''s' "$(printf sub)" 2>/dev/null || true`, { encoding: "utf-8" });
    expect(stdout).toBe("it's|sub|");
  });
});
