import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { killProcessTree, resolveShellFreeLaunch } from "@fusion/core";

export const CLAUDE_CODE_CLI_ACP_BINARY = "claude-code-cli-acp";
export interface ClaudeBridgeResolution { kind: "resolved" | "not_resolved"; requested: string; path?: string; reason?: string }
/*
FNXC:ClaudeAcp 2026-07-18-11:55:
The plugin runs both from source (`src/`), a standalone build (`dist/`), and
Fusion's single-file `bundled.js`. Only the first two sit one directory below the
plugin root; bundled.js sits at the root. Resolve the staged bridge relative to
that layout so published CLI sessions do not look in `dist/plugins/bridge`.
*/
function pluginRootDir(): string {
 const moduleDir = dirname(fileURLToPath(import.meta.url));
 return ["src", "dist"].includes(basename(moduleDir)) ? resolve(moduleDir, "..") : moduleDir;
}
/**
 * Resolve only the identity-pinned bridge launcher staged beside this bundled plugin.
 *
 * FNXC:WindowsProcessLaunch 2026-10-07-18:02:
 * The bridge is the staged launcher's JS entry, run with node on every platform.
 * The former `.cmd`/shebang wrapper was chosen by the build host's platform, so a Linux-built package had no Windows wrapper, and Node refuses to spawn `.cmd` without a shell anyway.
 */
export function bundledClaudeBridgeBinPath(pluginRoot = pluginRootDir()): string {
  return join(pluginRoot, "bridge", "node_modules", CLAUDE_CODE_CLI_ACP_BINARY, "bin", `${CLAUDE_CODE_CLI_ACP_BINARY}.js`);
}
export function resolveBundledClaudeBridgeBinary(options: { pluginRoot?: string; exists?: (path: string) => boolean } = {}): ClaudeBridgeResolution {
  const candidate = bundledClaudeBridgeBinPath(options.pluginRoot ?? pluginRootDir());
  const exists = options.exists ?? existsSync;
  if (!exists(candidate) || !isAbsolute(candidate)) return { kind: "not_resolved", requested: CLAUDE_CODE_CLI_ACP_BINARY, path: candidate, reason: `Staged ${CLAUDE_CODE_CLI_ACP_BINARY} bridge was not found at ${candidate}` };
  return { kind: "resolved", requested: CLAUDE_CODE_CLI_ACP_BINARY, path: candidate };
}
/**
 * Run a short Claude CLI command for probing.
 *
 * FNXC:WindowsProcessLaunch 2026-10-07-18:02:
 * The probe launches through the same shell-free resolution as sessions; a `shell:true` probe reported Windows CLIs available that sessions could not spawn.
 */
export async function runClaudeCommand(binary: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: { code: number | null; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      done(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      const launch = resolveShellFreeLaunch(binary, args);
      child = spawn(launch.command, launch.args, { stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
    } catch (error) {
      finish({ code: 127, stdout, stderr: (error as Error).message });
      return;
    }
    timer = setTimeout(() => {
      killProcessTree(child);
      finish({ code: 124, stdout, stderr });
    }, timeoutMs);
    child.stdout?.on("data", (c) => { stdout += String(c); });
    child.stderr?.on("data", (c) => { stderr += String(c); });
    child.once("error", (e) => finish({ code: 127, stdout, stderr: `${stderr}${e.message}` }));
    child.once("close", (code) => finish({ code, stdout, stderr }));
  });
}
