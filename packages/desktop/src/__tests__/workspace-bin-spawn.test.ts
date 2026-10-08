import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runWorkspaceBin, workspaceBinSpawnCommand } from "../../scripts/workspace-tools";

/*
FNXC:DesktopWindowsSpawn 2026-10-08-04:41:
KB-032: Node >= 20.12 refuses to spawn `.cmd` shims without a shell, and cmd.exe needs the absolute shim path quoted because user profile paths can contain spaces.
These tests pin the helper contract on every platform and prove real `.cmd` execution from a spaced directory on Windows.
*/

const MARKER = "KB032_FAKE_BIN_OK";
const tempDirs: string[] = [];

async function makeSpacedTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "kb032 spaced dir "));
  tempDirs.push(dir);
  return dir;
}

async function writeFakeCmd(filePath: string): Promise<void> {
  await writeFile(filePath, `@echo off\r\necho ${MARKER} %*\r\nexit /b 0\r\n`, "utf-8");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("workspaceBinSpawnCommand", () => {
  it("quotes a win32 path containing spaces and enables the shell", () => {
    const bin = "C:\\Users\\Jane Doe\\repo\\node_modules\\.bin\\vite.cmd";
    expect(workspaceBinSpawnCommand(bin, "win32")).toEqual({ command: `"${bin}"`, shell: true });
  });

  it("quotes a space-free win32 path and enables the shell", () => {
    const bin = "C:\\repo\\node_modules\\.bin\\vite.cmd";
    expect(workspaceBinSpawnCommand(bin, "win32")).toEqual({ command: `"${bin}"`, shell: true });
  });

  it.each(["linux", "darwin"] as const)("returns the raw path without a shell on %s", (platform) => {
    const bin = "/home/a b/node_modules/.bin/vite";
    expect(workspaceBinSpawnCommand(bin, platform)).toEqual({ command: bin, shell: false });
  });
});

describe("workspace bin spawning on Windows", () => {
  it.runIf(process.platform === "win32")("spawns a .cmd shim from a directory containing spaces", async () => {
    const dir = await makeSpacedTempDir();
    const shim = path.join(dir, "fake-bin.cmd");
    await writeFakeCmd(shim);

    const { command, shell } = workspaceBinSpawnCommand(shim);
    const result = await new Promise<{ code: number | null; stdout: string; error?: Error }>((resolve) => {
      let stdout = "";
      const child = spawn(command, ["dev", "--port", "5173"], { cwd: dir, shell });
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.on("error", (error) => resolve({ code: null, stdout, error }));
      child.on("close", (code) => resolve({ code, stdout }));
    });

    expect(result.error).toBeUndefined();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(MARKER);
  });

  it.runIf(process.platform === "win32")("runWorkspaceBin resolves for a package-local shim under a spaced path", async () => {
    const dir = await makeSpacedTempDir();
    const binDir = path.join(dir, "node_modules", ".bin");
    await mkdir(binDir, { recursive: true });
    await writeFakeCmd(path.join(binDir, "fake-bin.cmd"));

    await expect(runWorkspaceBin("fake-bin", ["dev", "--port", "5173"], dir)).resolves.toBeUndefined();
  });
});
