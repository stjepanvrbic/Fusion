import { spawn, type ChildProcess } from "node:child_process";
import { killProcessTree, resolveShellFreeLaunch } from "@fusion/core";

function formatSpawnError(error: Error & { code?: unknown }): string {
  const code = typeof error.code === "string" ? `${error.code}: ` : "";
  return `spawn error: ${code}${error.message}`.trim();
}

export async function runGrokCommand(binary: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: { code: number | null; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    /*
    FNXC:WindowsProcessLaunch 2026-10-07-18:02:
    The probe/discovery runner launches through core's shell-free resolution, the same seam ACP sessions use.
    A `shell:true` probe reported Windows npm shims available while every session spawn failed with ENOENT/EINVAL, and passed argv through cmd.exe.
    */
    let child: ChildProcess;
    try {
      const launch = resolveShellFreeLaunch(binary, args);
      child = spawn(launch.command, launch.args, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      finish({ code: 127, stdout, stderr: `spawn error: ${(error as Error).message}` });
      return;
    }

    timer = setTimeout(() => {
      killProcessTree(child);
      finish({ code: 124, stdout, stderr });
    }, timeoutMs);

    child.stdout?.on("data", (c: Buffer) => { stdout += c.toString("utf-8"); });
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf-8"); });
    child.once("error", (error: Error & { code?: unknown }) => {
      const diagnostic = formatSpawnError(error);
      stderr = stderr ? `${stderr}\n${diagnostic}` : diagnostic;
      finish({ code: 127, stdout, stderr });
    });
    child.once("close", (code) => {
      finish({ code, stdout, stderr });
    });
  });
}
