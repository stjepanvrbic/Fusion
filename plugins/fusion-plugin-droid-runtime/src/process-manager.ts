/**
 * Process manager for spawning and managing Droid CLI subprocesses.
 *
 * Handles subprocess lifecycle: spawn with correct CLI flags, write NDJSON
 * messages to stdin, force-kill after result (CLI hangs bug), and stderr capture.
 * Also provides startup validation for CLI presence and authentication.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { killProcessTree, resolveShellFreeLaunch } from "@fusion/plugin-sdk";

function debugLog(message: string): void {
  if (process.env.PI_DROID_CLI_DEBUG !== "1") return;
  console.error(`[droid-cli] ${message}`);
}

/** A system prompt written for exactly one Droid invocation. */
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
 * FNXC:DroidCli 2026-10-07-18:02:
 * The prompt goes through a file because a long `--append-system-prompt` argv hits ENAMETOOLONG on Windows.
 * Every Droid run in one Fusion process used the same PID-named file, so a concurrent session overwrote another's instructions before its CLI read them and any run's cleanup deleted the file another was starting with.
 * Each invocation now owns a private temp directory that only its own cleanup removes, after its process completes.
 */
export function createSystemPromptFile(systemPrompt: string, options: SystemPromptFileOptions = {}): SystemPromptFile {
  const directory = mkdtempSync(join(tmpdir(), "droid-cli-sysprompt-"));
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
 * Build the Droid CLI argv for stream-json communication. Pure: writes no files.
 *
 * @param modelId - The model ID to pass via --model flag
 * @param systemPromptFile - Optional path from `createSystemPromptFile`, appended via --append-system-prompt
 * @param options - Optional effort, MCP config, and session ids
 */
export function buildDroidSpawnArgs(
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
    // Droid CLI's --append-system-prompt accepts a file path or literal text.
    args.push("--append-system-prompt", systemPromptFile);
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
 * Spawn a Droid CLI subprocess with piped stdio.
 *
 * @param systemPromptFile - Optional path from `createSystemPromptFile`; the caller owns its cleanup
 */
export function spawnDroid(
  modelId: string,
  systemPromptFile?: string,
  options?: {
    /** Configured `droidBinaryPath`; the probe checks the same binary. Defaults to `droid` on PATH. */
    binaryPath?: string;
    cwd?: string;
    signal?: AbortSignal;
    effort?: string;
    mcpConfigPath?: string;
    resumeSessionId?: string;
    newSessionId?: string;
  },
): ChildProcess {
  const args = buildDroidSpawnArgs(modelId, systemPromptFile, {
    effort: options?.effort,
    mcpConfigPath: options?.mcpConfigPath,
    resumeSessionId: options?.resumeSessionId,
    newSessionId: options?.newSessionId,
  });

  /*
  FNXC:WindowsProcessLaunch 2026-10-07-18:02:
  An npm-installed Droid is `droid.cmd`, which a bare shell-free spawn cannot find (ENOENT); resolve through the shared launch seam, as the probe does.
  Sessions launch the configured binary the probe reported available, not always the bare `droid`.
  */
  const launch = resolveShellFreeLaunch(options?.binaryPath ?? "droid", args);
  const proc = spawn(launch.command, launch.args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: options?.cwd ?? process.cwd(),
    shell: false,
    windowsHide: true,
  });

  debugLog(`spawnDroid: pid=${proc.pid} model=${modelId}`);

  return proc as ChildProcess;
}

/**
 * Write a user message to the subprocess stdin as NDJSON.
 * Calls stdin.end() after writing the user message to signal EOF, allowing
 * Droid CLI to process the input and start generating.
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
 * Force-kill a subprocess and every process it started. No-ops once it has exited.
 * On Windows `proc.kill` ends only the direct child, so the shared tree kill is used.
 *
 * @param proc - The subprocess to force-kill
 */
export function forceKillProcess(proc: ChildProcess): void {
  killProcessTree(proc);
}

/** Registry of active subprocesses for cleanup on teardown. */
const activeProcesses = new Set<ChildProcess>();

/**
 * Hard ceiling on a single `droid models`/`droid model list` discovery spawn.
 * The droid CLI can keep stdout open via its stream-jsonrpc backend, so this
 * bound guarantees the spawn is SIGKILLed and the promise settles. Kept short
 * because discovery runs on the dashboard's per-session extension load path.
 */
const DROID_MODEL_DISCOVERY_TIMEOUT_MS = 10_000;

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
 * The Droid CLI hangs after emitting the result message (known bug).
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
 * Run a one-shot `droid <args>` and resolve to the exit code.
 *
 * FNXC:CliRuntime 2026-06-15-07:35:
 * Third-party CLI presence/auth probes must be non-blocking in Fusion request and session-startup paths. Use spawn-based probes here because synchronous shell probes freeze the dashboard event loop during CLI cold start.
 *
 * Why: a Droid CLI cold start can take 1–3s, occasionally longer. When droid-cli's
 * factory is invoked from a per-request createFnAgent path (Fusion dashboard
 * does this on every chat send), sync probes freeze every other request.
 * This async variant uses spawn so the loop keeps turning while the subprocess
 * starts up.
 *
 * FNXC:CliRuntime 2026-06-20-17:25:
 * FN-6808/FN-6801 require this fire-and-forget auth/presence probe to never reject. Catch synchronous spawn throws from the Vitest child-process guard or platform launch errors and resolve 127, matching the async error sentinel so callers degrade to unauthenticated/not-present instead of surfacing unhandled promise rejections.
 */
function runDroidProbe(args: string[], timeoutMs = 45000): Promise<number> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      const launch = resolveShellFreeLaunch("droid", args);
      proc = spawn(launch.command, launch.args, { stdio: "ignore", shell: false, windowsHide: true });
    } catch {
      resolve(127);
      return;
    }

    const timer = setTimeout(() => {
      forceKillProcess(proc);
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
  const code = await runDroidProbe(["--version"]);
  if (code === 0) return { ok: true };
  return {
    ok: false,
    error: new Error(
      "Droid CLI not found on PATH. Install Droid CLI and then run: droid auth login",
    ),
  };
}

/**
 * Async, non-blocking variant of validateCliAuth.
 * Returns true if authenticated. Logs a warning (does not throw) otherwise.
 */
export async function validateCliAuthAsync(): Promise<boolean> {
  const code = await runDroidProbe(["auth", "status"]);
  if (code === 0) return true;
  console.warn(
    "[droid-cli] Droid CLI is not authenticated. " +
      "Run 'droid auth login' to authenticate.",
  );
  return false;
}

/**
 * Parse model IDs out of `droid exec --help`. The help text lists the catalog
 * under `Available Models:` and `Custom Models:` headers, each entry indented as
 * `  <model-id>   <description>`. The trailing `Model details:` section (lines
 * like `  - Claude Opus 4.8: ...`) is intentionally excluded — those are prose,
 * not IDs. Exported for unit testing.
 */
export function parseDroidModelsFromHelp(helpText: string): string[] {
  const ids: string[] = [];
  let collecting = false;
  for (const line of helpText.split(/\r?\n/)) {
    // Section header at column 0, e.g. "Available Models:" / "Custom Models:".
    if (/^[A-Za-z][A-Za-z ]*Models:\s*$/.test(line)) {
      collecting = true;
      continue;
    }
    // Any other non-indented, non-empty line ends the current section
    // (notably "Model details:").
    if (collecting && line.trim() && !/^\s/.test(line)) {
      collecting = false;
    }
    if (!collecting) continue;
    // Indented "  <id>   <description>"; the id is the first whitespace-delimited
    // token (handles `custom:CC:-Opus-4.6-(Max)-0` and the like — no spaces).
    const match = line.match(/^\s+(\S+)\s{2,}\S/);
    if (match) ids.push(match[1]);
  }
  return Array.from(new Set(ids));
}

export async function discoverDroidModels(): Promise<string[]> {
  // The droid CLI has no `models`/`model list` command — those parse as a
  // *prompt* and launch a hung agent session. The catalog is printed by
  // `droid exec --help` (and exits cleanly).
  return new Promise<string[]>((resolve) => {
    let proc: ChildProcess;
    try {
      const launch = resolveShellFreeLaunch("droid", ["exec", "--help"]);
      proc = spawn(launch.command, launch.args, { stdio: ["ignore", "pipe", "ignore"], shell: false, windowsHide: true });
    } catch {
      resolve([]);
      return;
    }

    // FNXC:CliRuntime 2026-06-21: keep discovery bounded. `droid exec --help`
    // exits on its own, but a SIGKILL-on-timeout guard ensures a wedged spawn
    // can never leak (the prior `droid models` form launched a persistent
    // stream-jsonrpc backend that never exited, piling up into a process storm
    // because the dashboard re-loads this extension per chat-send).
    let settled = false;
    const settle = (value: string[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      forceKillProcess(proc);
      resolve(value);
    };
    const timer = setTimeout(() => settle([]), DROID_MODEL_DISCOVERY_TIMEOUT_MS);

    let out = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.once("error", () => settle([]));
    proc.once("exit", () => settle(parseDroidModelsFromHelp(out)));
  });
}
