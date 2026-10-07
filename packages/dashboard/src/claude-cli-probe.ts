/**
 * Probe for the locally-installed Claude CLI binary.
 *
 * Used by GET /api/providers/claude-cli/status to power the "Anthropic —
 * via Claude CLI" provider card. The card shows `authenticated=true` only
 * when the binary is on PATH *and* the user has flipped on `useClaudeCli`.
 *
 * Intentional design choices:
 *
 * - No caching. The user's PATH can change between requests (nvm switches,
 *   fresh terminal, etc.) — we'd rather pay one `spawn()` per poll than
 *   serve a stale "claude not installed" response. Claude's `--version`
 *   flag exits in ~40ms, so cost is negligible.
 *
 * - Short timeout. A misbehaving `claude` shim could hang indefinitely;
 *   we cap the probe at 2s and report `available: false` with a timeout
 *   reason rather than blocking the HTTP request.
 *
 * - No authorization. We never shell-interpolate PATH or user input.
 *   We spawn `claude --version` directly with argv, no shell. On Windows an
 *   npm `.cmd` shim runs through cmd.exe with its fixed arguments escaped.
 */

import { spawn } from "node:child_process";
import { killProcessTree, prepareNativeCommand, resolveWindowsExecutable } from "@fusion/core";

/** Result shape returned to the dashboard status endpoint. */
export interface ClaudeCliBinaryStatus {
  /** True if the `claude` binary was found on PATH and ran to completion. */
  available: boolean;
  /** Trimmed stdout from `claude --version`, if available. */
  version?: string;
  /** Absolute path, if we could resolve it via `which`. */
  binaryPath?: string;
  /** Human-readable failure reason when `available === false`. */
  reason?: string;
  /** Wall-clock duration of the probe, useful for debugging slow paths. */
  probeDurationMs: number;
}

/** Default probe timeout. Claude's --version is fast; 2s is generous. */
const PROBE_TIMEOUT_MS = 2000;

/**
 * Spawn `claude --version` and return a structured status result.
 *
 * Never throws — any failure is captured as `available: false` with a reason
 * so the caller (an HTTP handler) can render the provider card without
 * try/catch.
 */
export async function probeClaudeCli(
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<ClaudeCliBinaryStatus> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const env = options.env ?? process.env;

  /*
  FNXC:ProcessLifecycle 2026-10-07-18:00:
  An npm-installed Claude CLI must probe as available on Windows.
  `where claude` can return the extensionless POSIX wrapper and spawn without a shell cannot run the `.cmd` shim, so Windows resolves through PATH and PATHEXT and launches a shim via cmd.exe with escaped arguments.
  */
  const binaryPath = process.platform === "win32"
    ? resolveWindowsExecutable("claude", { env }) ?? undefined
    : await tryResolveBinaryPath("claude", env);
  const launch = prepareNativeCommand(binaryPath ?? "claude", ["--version"], { env });

  return new Promise<ClaudeCliBinaryStatus>((resolvePromise) => {
    const finish = (result: Omit<ClaudeCliBinaryStatus, "probeDurationMs">): void => {
      resolvePromise({ ...result, probeDurationMs: Date.now() - startedAt });
    };

    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(launch.command, launch.args, {
        stdio: ["ignore", "pipe", "pipe"],
        env,
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
      });
    } catch (err) {
      finish({ available: false, binaryPath, reason: err instanceof Error ? err.message : String(err) });
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (typeof child.pid === "number") {
        // A cmd.exe shim wrapper has the real CLI as a child; end the whole tree.
        killProcessTree(child.pid, "SIGKILL");
      }
      finish({
        available: false,
        binaryPath,
        reason: `Probe timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const isNotFound = (err as NodeJS.ErrnoException).code === "ENOENT";
      finish({
        available: false,
        binaryPath,
        reason: isNotFound ? "`claude` not found on PATH" : err.message,
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        finish({
          available: true,
          version: stdout.trim() || undefined,
          binaryPath,
        });
      } else {
        finish({
          available: false,
          binaryPath,
          reason:
            stderr.trim() || `claude --version exited with code ${String(code)}`,
        });
      }
    });
  });
}

/**
 * Best-effort `which claude`. We don't fail probe on inability to resolve
 * the path — the spawn above is the actual authority. This is just for
 * surfacing a friendly "found at /opt/homebrew/bin/claude" in the UI.
 */
async function tryResolveBinaryPath(binary: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    const child = spawn("which", [binary], { stdio: ["ignore", "pipe", "ignore"], env });
    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk.toString("utf-8");
    });
    child.on("error", () => resolvePromise(undefined));
    child.on("close", (code) => {
      if (code === 0) {
        const first = out.trim().split(/\r?\n/)[0];
        resolvePromise(first?.length ? first : undefined);
      } else {
        resolvePromise(undefined);
      }
    });
  });
}
