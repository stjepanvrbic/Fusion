/**
 * Process manager for spawning and managing Claude CLI subprocesses.
 *
 * Handles subprocess lifecycle: spawn with correct CLI flags, write NDJSON
 * messages to stdin, force-kill after result (CLI hangs bug), and stderr capture.
 * Also provides startup validation for CLI presence and authentication.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { killProcessTree, resolveShellFreeLaunch } from "./windows-launch.js";

function debugLog(message: string): void {
  if (process.env.PI_CLAUDE_CLI_DEBUG !== "1") return;
  console.error(`[pi-claude-cli] ${message}`);
}

/** A system prompt written for exactly one Claude CLI invocation. */
export interface SystemPromptFile {
  path: string;
  /** Remove this invocation's file. Idempotent and never throws. */
  cleanup(): void;
}

export interface SystemPromptFileOptions {
  rm?: typeof rmSync;
}

/**
 * Write a system prompt to a file owned by one invocation.
 *
 * FNXC:ClaudeCliProvider 2026-10-07-19:34:
 * The prompt goes through a file because a long prompt argv hits ENAMETOOLONG on Windows, and the CLI reads it via `--append-system-prompt-file`.
 * `--append-system-prompt` takes literal text, so passing the path there sent the model a file name instead of Fusion's instructions.
 * Every turn in one process used one PID-named file, so concurrent sessions overwrote each other's prompt and any turn's cleanup deleted another's.
 * Each invocation now owns a private temp directory that only its own cleanup removes, after its process closes.
 */
export function createSystemPromptFile(systemPrompt: string, options: SystemPromptFileOptions = {}): SystemPromptFile {
  const directory = mkdtempSync(join(tmpdir(), "pi-claude-cli-sysprompt-"));
  const path = join(directory, "system-prompt.txt");
  writeFileSync(path, systemPrompt, "utf-8");
  const rm = options.rm ?? rmSync;
  let removed = false;
  return {
    path,
    cleanup() {
      if (removed) return;
      removed = true;
      try {
        // Windows can briefly hold a just-read file open; retry, then leave the private directory for the OS temp sweeper.
        rm(dirname(path), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch (error) {
        debugLog(`system prompt cleanup failed for ${path}: ${(error as Error).message}`);
      }
    },
  };
}

/**
 * Build the Claude CLI argv for stream-json communication. Pure: writes no files.
 *
 * @param modelId - The model ID to pass via --model flag
 * @param systemPromptFile - Optional path from `createSystemPromptFile`, read via --append-system-prompt-file
 * @param options - Optional effort, MCP config, and session ids
 */
export function buildClaudeSpawnArgs(
  modelId: string,
  systemPromptFile?: string,
  options?: {
    effort?: string;
    mcpConfigPath?: string;
    resumeSessionId?: string;
    newSessionId?: string;
  },
): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    modelId,
  ];

  if (options?.resumeSessionId) {
    // Resume an existing session — CLI loads prior conversation from disk
    args.push("--resume", options.resumeSessionId);
  } else if (options?.newSessionId) {
    // First turn: create session with this ID so subsequent turns can --resume it
    args.push("--session-id", options.newSessionId);
  }

  if (systemPromptFile) {
    args.push("--append-system-prompt-file", systemPromptFile);
  }

  if (options?.effort) {
    args.push("--effort", options.effort);
  }

  if (options?.mcpConfigPath) {
    args.push("--mcp-config", options.mcpConfigPath);
  }

  return args;
}

/**
 * Spawn a Claude CLI subprocess with piped stdio.
 *
 * @param systemPromptFile - Optional path from `createSystemPromptFile`; the caller owns its cleanup
 */
export function spawnClaude(
  modelId: string,
  systemPromptFile?: string,
  options?: {
    cwd?: string;
    effort?: string;
    mcpConfigPath?: string;
    resumeSessionId?: string;
    newSessionId?: string;
  },
): ChildProcess {
  const args = buildClaudeSpawnArgs(modelId, systemPromptFile, {
    effort: options?.effort,
    mcpConfigPath: options?.mcpConfigPath,
    resumeSessionId: options?.resumeSessionId,
    newSessionId: options?.newSessionId,
  });

  /*
  FNXC:WindowsProcessLaunch 2026-10-07-19:34:
  An npm-installed Claude Code is `claude.cmd`, which a bare shell-free spawn cannot find (ENOENT); resolve through the shared launch seam, as the probes do.
  */
  const launch = resolveShellFreeLaunch("claude", args);
  const proc = spawn(launch.command, launch.args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: options?.cwd ?? process.cwd(),
    shell: false,
    windowsHide: true,
  });

  /*
  FNXC:ClaudeCliProvider 2026-10-07-19:34:
  A CLI that exits before reading its input makes the stdin write fail with EPIPE; without a listener that error is uncaught and crashes the host.
  The caller's close handler reports the exit itself, so the stdin error is only logged.
  */
  proc.stdin?.on("error", (error: Error) => {
    debugLog(`stdin error for pid=${proc.pid}: ${error.message}`);
  });

  debugLog(`spawnClaude: pid=${proc.pid} model=${modelId} args=${JSON.stringify(args)}`);

  return proc as ChildProcess;
}

/**
 * Write a user message to the subprocess stdin as NDJSON.
 * Calls stdin.end() after writing the user message to signal EOF, allowing
 * Claude CLI to process the input and start generating.
 *
 * Accepts both string (text-only prompt) and array (ContentBlock[] with images)
 * content. JSON.stringify handles both natively. The stream-json protocol
 * supports either format in the content field.
 *
 * @param proc - The Claude subprocess
 * @param prompt - The prompt text or ContentBlock[] to send
 */
export function writeUserMessage(
  proc: ChildProcess,
  prompt: string | unknown[],
): void {
  const message = {
    type: "user",
    message: {
      role: "user",
      content: prompt,
    },
  };
  proc.stdin!.write(JSON.stringify(message) + "\n");
  proc.stdin!.end();
}

/**
 * Force-kill a subprocess and every process it started. No-ops once it was signalled or has exited.
 * On Windows `proc.kill` ends only the direct child, leaving the CLI's MCP servers running, so the shared tree kill is used.
 *
 * @param proc - The subprocess to force-kill
 */
export function forceKillProcess(proc: ChildProcess): void {
  killProcessTree(proc);
}

/** Registry of active subprocesses for cleanup on teardown. */
const activeProcesses = new Set<ChildProcess>();

/**
 * Register a subprocess in the global process registry.
 * The process is automatically removed from the registry when it exits.
 *
 * @param proc - The subprocess to track
 */
export function registerProcess(proc: ChildProcess): void {
  activeProcesses.add(proc);
  proc.on("exit", () => activeProcesses.delete(proc));
}

/**
 * Force-kill all registered subprocesses and clear the registry.
 * Safe to call multiple times -- no-ops on already-dead processes.
 */
export function killAllProcesses(): void {
  for (const proc of activeProcesses) {
    forceKillProcess(proc);
  }
  activeProcesses.clear();
}

/**
 * Force-kill the subprocess after a 500ms grace period.
 * The Claude CLI hangs after emitting the result message (known bug).
 * Brief grace period allows final stdout flushing before force-kill.
 *
 * @param proc - The Claude subprocess to clean up
 */
export function cleanupProcess(proc: ChildProcess): void {
  setTimeout(() => {
    forceKillProcess(proc);
  }, 500);
}

/**
 * Attach a data listener to stderr and accumulate output into a buffer.
 *
 * @param proc - The Claude subprocess
 * @returns A function that returns the accumulated stderr string
 */
export function captureStderr(proc: ChildProcess): () => string {
  let buffer = "";
  proc.stderr!.on("data", (data: Buffer) => {
    buffer += data.toString();
  });
  return () => buffer;
}

/**
 * Run a one-shot `claude <args>` and resolve to the exit code.
 *
 * FNXC:CliRuntime 2026-06-15-07:35:
 * Third-party CLI presence/auth probes must be non-blocking in Fusion request and session-startup paths. Use spawn-based probes here because synchronous shell probes freeze the dashboard event loop during CLI cold start.
 *
 * Why: a Claude CLI cold start can take 1–3s, occasionally longer. When pi-claude-cli's
 * factory is invoked from a per-request createFnAgent path (Fusion dashboard
 * does this on every chat send), sync probes freeze every other request.
 * This async variant uses spawn so the loop keeps turning while the subprocess
 * starts up.
 *
 * FNXC:CliRuntime 2026-06-20-17:25:
 * FN-6808/FN-6801 require this fire-and-forget auth/presence probe to never reject. Catch synchronous spawn throws from the Vitest child-process guard or platform launch errors and resolve 127, matching the async error sentinel so callers degrade to unauthenticated/not-present instead of surfacing unhandled promise rejections.
 */
function runClaudeProbe(args: string[], timeoutMs = 5000): Promise<number> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      // Probe the same shell-free launch the session uses, so "present" implies spawnable; an unlaunchable shim throws here.
      const launch = resolveShellFreeLaunch("claude", args);
      proc = spawn(launch.command, launch.args, { stdio: "ignore", shell: false, windowsHide: true });
    } catch {
      resolve(127);
      return;
    }

    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already dead
      }
      resolve(124);
    }, timeoutMs);
    proc.once("error", () => {
      clearTimeout(timer);
      resolve(127);
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

/**
 * Async, non-blocking variant of validateCliPresence.
 * Resolves with `{ok: true}` on success, `{ok: false, error}` on failure —
 * never rejects, so callers can fire-and-forget without unhandled rejections.
 */
export async function validateCliPresenceAsync(): Promise<
  { ok: true } | { ok: false; error: Error }
> {
  const code = await runClaudeProbe(["--version"]);
  if (code === 0) return { ok: true };
  return {
    ok: false,
    error: new Error(
      "Claude Code CLI not found. Install it: npm install -g @anthropic-ai/claude-code\n" +
        "Then authenticate: claude auth login",
    ),
  };
}

/**
 * Async, non-blocking variant of validateCliAuth.
 * Returns true if authenticated. Logs a warning (does not throw) otherwise.
 */
export async function validateCliAuthAsync(): Promise<boolean> {
  const code = await runClaudeProbe(["auth", "status"]);
  if (code === 0) return true;
  console.warn(
    "[pi-claude-cli] Claude CLI is not authenticated. " +
      "Run 'claude auth login' to authenticate.",
  );
  return false;
}
