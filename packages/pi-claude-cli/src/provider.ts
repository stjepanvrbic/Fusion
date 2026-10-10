/**
 * Provider orchestration for bridging pi requests to the Claude CLI subprocess.
 *
 * streamViaCli is the core function that:
 * 1. Builds the prompt from conversation context
 * 2. Spawns a Claude CLI subprocess with correct flags
 * 3. Writes the user message to stdin as NDJSON
 * 4. Reads stdout line-by-line, parsing NDJSON
 * 5. Routes stream events through the event bridge to pi's stream
 * 6. Handles result/error messages and cleans up the subprocess
 * 7. Implements break-early: kills subprocess at message_stop when
 *    built-in or custom-tools MCP tool_use blocks are seen
 * 8. Hardened lifecycle: inactivity timeout, subprocess exit handler,
 *    streamEnded guard, abort via SIGKILL, process registry
 */


import { createInterface } from "node:readline";
import {
  AssistantMessageEventStream,
  type Api,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  buildPrompt,
  buildSystemPrompt,
  buildResumePrompt,
  type PiContext,
} from "./prompt-builder.js";
import {
  spawnClaude,
  writeUserMessage,
  cleanupProcess,
  captureStderr,
  forceKillProcess,
  registerProcess,
  createSystemPromptFile,
  buildClaudeSpawnArgs,
  type SystemPromptFile,
} from "./process-manager.js";
import { parseLine } from "./stream-parser.js";
import { resolveCliSessionMode, sessionModeAfterRejection, type CliSessionMode } from "./session-store.js";
import { createEventBridge } from "./event-bridge.js";
import { mapThinkingEffort } from "./thinking-config.js";
import { isPiKnownClaudeTool } from "./tool-mapping.js";
import { pushTurnFailure, type TurnFailureReason } from "./turn-failure.js";
import type { ClaudeResultMessage } from "./types.js";
/**
 * Inactivity safety net for the Claude CLI subprocess.
 *
 * Set very high (30 minutes) because the caller is the authoritative source of
 * truth for "this session is stuck": Fusion's engine runs a `StuckTaskDetector`
 * with a configurable heartbeat (default 1 hour) and aborts the session via
 * `AbortSignal` when it decides the agent has gone quiet. pi-claude-cli already
 * forwards that signal to the subprocess (`forceKillProcess` on `signal.abort`).
 *
 * A short timeout here was racing the engine: Sonnet 4.6 with extended thinking
 * on the triage prompt (~40k chars) routinely goes >3 minutes between thinking
 * deltas, and we were killing those subprocesses before they could write
 * PROMPT.md and call `fn_review_spec`. The half-hour ceiling is just a
 * last-resort guard for catastrophically hung processes when no abort signal
 * arrives (e.g. someone embeds pi-claude-cli without a stuck detector).
 */
const INACTIVITY_TIMEOUT_MS = 30 * 60_000;
/** How long a turn whose output ended without a result waits for the exit code and stderr before reporting the failure without them. */
const EXIT_REPORT_GRACE_MS = 1_000;
const ABORTED_MESSAGE = "Claude CLI request was aborted";

function isDebugStreamEnabled(): boolean {
  return process.env.PI_CLAUDE_CLI_DEBUG === "1";
}

function debugLog(message: string): void {
  if (!isDebugStreamEnabled()) return;
  console.error(`[pi-claude-cli] ${message}`);
}

/**
 * The failure a result message reports, or undefined for a completed turn.
 * Only `subtype: "success"` without `is_error` completed; see {@link ClaudeResultMessage}.
 */
function describeResultFailure(msg: ClaudeResultMessage): string | undefined {
  if (msg.subtype === "success" && msg.is_error !== true) return undefined;
  const detail =
    msg.errors?.filter((entry) => typeof entry === "string" && entry.length > 0).join("; ") ||
    msg.result ||
    msg.error ||
    "no error detail";
  /*
   * FNXC:ClaudeCliRateLimit 2026-10-10-17:50:
   * A subscription usage limit reports the CLI's own limit notice as the result text, with no status code, so Fusion's usage-limit classifier could not recognise it and the turn read as a generic failure.
   * The documented `api_error_status` field carries the HTTP status (429 for a rate limit); including it lets the engine's retry ladder and rate-limit freeze recognise CLI limits.
   */
  const status = typeof msg.api_error_status === "number" ? ` (HTTP ${msg.api_error_status})` : "";
  return `Claude CLI result ${msg.subtype}${msg.is_error ? " (is_error)" : ""}${status}: ${detail}`;
}

/** Extended stream options: pi's SimpleStreamOptions plus optional cwd and mcpConfigPath */
type StreamViaCLiOptions = SimpleStreamOptions & {
  cwd?: string;
  mcpConfigPath?: string;
};

/**
 * Stream a response from Claude CLI as an AssistantMessageEventStream.
 *
 * Orchestrates the full subprocess lifecycle: spawn, write prompt, parse NDJSON,
 * bridge events, handle result, and clean up. Implements break-early pattern:
 * at message_stop, if any built-in or custom-tools MCP tool was seen, kills
 * the subprocess before Claude CLI can auto-execute the tools.
 *
 * FNXC:ClaudeCliProvider 2026-10-07-19:34:
 * Every turn settles the stream exactly once: `done` only for a completed turn (a success result, or a break-early tool call), `error` with `stopReason` `error` for a failed one, and `error` with `stopReason` `aborted` for a cancelled one.
 * A failure result, a non-zero or signal exit, output that ends without a result, the inactivity timeout, a spawn failure and a thrown setup step are all failures.
 * A signal that is already aborted settles the turn without spawning; an abort after spawn kills the CLI and settles immediately rather than waiting for its output to end.
 *
 * @param model - The model to use (from pi's model catalog)
 * @param context - The conversation context with messages and system prompt
 * @param options - Optional cwd, abort signal, reasoning level, thinking budgets, and mcpConfigPath
 * @returns An AssistantMessageEventStream that receives bridged events
 */
export function streamViaCli(
  model: Model<Api>,
  context: PiContext,
  options?: StreamViaCLiOptions,
): AssistantMessageEventStream {
  // @ts-expect-error — tsc can't verify AssistantMessageEventStream is a value
  // through pi-ai's `export *` re-export chain. The class constructor exists at runtime.
  const stream = new AssistantMessageEventStream();
  const bridge = createEventBridge(stream, model);

  // First terminal path wins; later ones are no-ops.
  let streamEnded = false;
  function endStreamWithFailure(reason: TurnFailureReason, errMsg: string) {
    if (streamEnded) return;
    streamEnded = true;
    pushTurnFailure(stream, bridge.getOutput(), reason, errMsg);
  }

  /**
   * Run the turn once in the given session mode.
   * Resolves to the other mode when the CLI rejected this one before producing output and `allowSessionFallback` is set; otherwise the stream is settled and it resolves to undefined.
   */
  const attemptTurn = async (
    sessionMode: CliSessionMode,
    allowSessionFallback: boolean,
  ): Promise<CliSessionMode | undefined> => {
    let proc: ReturnType<typeof spawnClaude> | undefined;
    let promptFile: SystemPromptFile | undefined;
    let abortHandler: (() => void) | undefined;
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    let sessionFallback: CliSessionMode | undefined;
    // Events from a rejected attempt's process may arrive after the next attempt has started.
    let attemptOver = false;
    let forwardedOutput = false;

    /** Fail the turn, unless the failure is the CLI rejecting the session mode and the other mode is still untried. */
    function failTurn(errMsg: string) {
      if (attemptOver) return;
      if (allowSessionFallback && !forwardedOutput) {
        sessionFallback ??= sessionModeAfterRejection(sessionMode, errMsg);
        if (sessionFallback) return;
      }
      endStreamWithFailure("error", errMsg);
    }

    try {
      if (options?.signal?.aborted) {
        endStreamWithFailure("aborted", ABORTED_MESSAGE);
        return undefined;
      }

      const cwd = options?.cwd ?? process.cwd();

      const resumeSessionId = sessionMode === "resume" ? options?.sessionId : undefined;

      // Build prompt: if resuming, only send the latest user turn;
      // otherwise build the full flattened conversation history
      const prompt = resumeSessionId
        ? buildResumePrompt(context)
        : buildPrompt(context);
      const systemPrompt = resumeSessionId
        ? undefined
        : buildSystemPrompt(context, cwd);

      // Compute effort level from reasoning options
      const effort = mapThinkingEffort(
        options?.reasoning,
        model.id,
        options?.thinkingBudgets,
      );

      const sessionOptions = {
        effort,
        mcpConfigPath: options?.mcpConfigPath,
        resumeSessionId,
        newSessionId: !resumeSessionId ? options?.sessionId : undefined,
      };

      if (systemPrompt) promptFile = createSystemPromptFile(systemPrompt);
      proc = spawnClaude(model.id, promptFile?.path, { cwd, ...sessionOptions });
      const spawned = proc;
      // The CLI reads its prompt file at startup; the file belongs to this process and goes away with it.
      const ownedPromptFile = promptFile;
      if (ownedPromptFile) {
        spawned.once("close", () => ownedPromptFile.cleanup());
        spawned.once("error", () => ownedPromptFile.cleanup());
      }
      const getStderr = captureStderr(spawned);

      // Register in global process registry for teardown cleanup
      registerProcess(spawned);
      debugLog(
        `spawned claude subprocess pid=${spawned.pid ?? "unknown"} args=${JSON.stringify(buildClaudeSpawnArgs(model.id, promptFile?.path, sessionOptions))}`,
      );

      // Track tool_use blocks for break-early decision at message_stop
      let sawBuiltInOrCustomTool = false;
      let firstLineReceived = false;
      let resultReceived = false;
      // Guard against buffered readline lines firing after rl.close()
      let broken = false;

      // Set up readline for line-by-line NDJSON parsing
      const rl = createInterface({
        input: spawned.stdout!,
        crlfDelay: Infinity,
        terminal: false,
      });
      const outputClosed = new Promise<void>((resolve) => {
        rl.on("close", resolve);
      });
      let exitInfo = undefined as { code: number | null; signal: string | null } | undefined;
      const exited = new Promise<void>((resolve) => {
        spawned.once("close", (code: number | null, signal: string | null) => {
          exitInfo = { code, signal };
          resolve();
        });
        spawned.once("error", () => resolve());
      });

      // Abort: force-kill the CLI and settle now; its output may never end on its own.
      if (options?.signal) {
        abortHandler = () => {
          clearTimeout(inactivityTimer);
          forceKillProcess(spawned);
          endStreamWithFailure("aborted", ABORTED_MESSAGE);
          rl.close();
        };
        options.signal.addEventListener("abort", abortHandler, { once: true });
        // An abort that landed during setup never fires a listener added afterwards.
        if (options.signal.aborted) abortHandler();
      }

      // Inactivity timeout: kill subprocess if no stdout for INACTIVITY_TIMEOUT_MS
      function resetInactivityTimer() {
        if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          forceKillProcess(spawned);
          endStreamWithFailure(
            "error",
            `Claude CLI subprocess timed out: no output for ${INACTIVITY_TIMEOUT_MS / 1000} seconds`,
          );
          rl.close();
        }, INACTIVITY_TIMEOUT_MS);
      }

      // Handle process error (e.g. spawn ENOENT)
      spawned.on("error", (err: Error) => {
        if (broken || attemptOver) return; // Break-early killed the process intentionally
        clearTimeout(inactivityTimer);
        const stderr = getStderr().trim();
        endStreamWithFailure("error", stderr || err.message);
        rl.close();
      });

      // Handle subprocess close -- surface crashes with stderr and exit code
      spawned.on("close", (code: number | null, _signal: string | null) => {
        clearTimeout(inactivityTimer);
        debugLog(`subprocess closed: code=${code} signal=${_signal}`);
        if (broken) return; // Break-early kill, expected
        const stderr = getStderr().trim();
        if (stderr) {
          if (code === 0 || code === null) {
            // FN-3815: Claude CLI writes benign MCP bring-up diagnostics to stderr
            // on clean/abort shutdown; keep these debug-only to avoid false TUI warnings.
            debugLog(`Claude CLI stderr on close (clean exit): ${stderr}`);
          } else {
            console.warn(`[pi-claude-cli] Claude CLI stderr on close: ${stderr}`);
          }
        }
        if (code !== 0 && code !== null) {
          const message = stderr
            ? `Claude CLI exited with code ${code}: ${stderr}`
            : `Claude CLI exited unexpectedly with code ${code}`;
          failTurn(message);
        }
      });

      // Process NDJSON lines from stdout using event-based callback
      // NOTE: Using 'line' event instead of `for await` because the async
      // iterator batches lines, breaking real-time streaming to pi.
      rl.on("line", (line: string) => {
        if (!firstLineReceived) {
          firstLineReceived = true;
          debugLog("first stdout line received from Claude CLI");
        }
        if (broken || streamEnded) return; // Guard: ignore buffered lines after break-early or settlement

        // Reset inactivity timer on each line of output
        resetInactivityTimer();

        const msg = parseLine(line);
        if (!msg) return;

        if (msg.type === "stream_event") {
          // Only forward top-level events to pi's event bridge.
          // Sub-agent events (parent_tool_use_id !== null) are internal to the CLI.
          const isTopLevel = !msg.parent_tool_use_id;
          if (isTopLevel) {
            forwardedOutput = true;
            bridge.handleEvent(msg.event);
          }

          // Track tool_use blocks for break-early decision (top-level only)
          if (
            isTopLevel &&
            msg.event.type === "content_block_start" &&
            msg.event.content_block?.type === "tool_use"
          ) {
            const toolName = msg.event.content_block.name;
            if (toolName) {
              const piKnownTool = isPiKnownClaudeTool(toolName);
              debugLog(
                `top-level tool_use seen: ${toolName} (piKnown=${piKnownTool ? "yes" : "no"})`,
              );
              if (piKnownTool) {
                // Built-in tool (Read/Write/etc.) OR custom MCP tool (mcp__custom-tools__*)
                // Internal Claude Code tools (ToolSearch, Task, etc.) are excluded
                sawBuiltInOrCustomTool = true;
              }
            }
          }

          // Break-early at message_stop: kill subprocess before CLI auto-executes tools
          // Only on top-level message_stop — sub-agent message_stop is internal
          if (
            isTopLevel &&
            msg.event.type === "message_stop" &&
            sawBuiltInOrCustomTool
          ) {
            debugLog("break-early triggered at message_stop after pi-known tool_use");
            broken = true; // Set guard BEFORE rl.close() to prevent buffered lines
            clearTimeout(inactivityTimer);
            // Pi will execute these tools. Kill subprocess to prevent CLI from executing them.
            forceKillProcess(spawned);
            rl.close();
            return; // Done event pushed after readline closes
          }
        } else if (msg.type === "control_request") {
          debugLog(
            `unexpected control_request received (stdin already closed): ${msg.request_id}`,
          );
        } else if (msg.type === "result") {
          resultReceived = true;
          const failure = describeResultFailure(msg);
          if (failure) failTurn(failure);
          clearTimeout(inactivityTimer);
          cleanupProcess(spawned);
          rl.close();
        }
      });

      // Start inactivity timer before writing so a CLI that never answers is still bounded
      resetInactivityTimer();

      // Write user message to subprocess stdin
      writeUserMessage(spawned, prompt);
      debugLog("user message written to stdin, stdin.end() called");

      // Wait for readline to close (result received, process ended, or turn settled)
      await outputClosed;

      if (streamEnded) return undefined;
      if (sessionFallback) return sessionFallback;

      if (!broken && !resultReceived) {
        // Output ended without a result: the turn did not complete. Wait briefly for the exit code and stderr so the failure says why.
        await Promise.race([
          exited,
          new Promise<void>((resolve) => setTimeout(resolve, EXIT_REPORT_GRACE_MS)),
        ]);
        const stderr = getStderr().trim();
        const exitDetail = exitInfo?.signal
          ? `terminated by ${exitInfo.signal}`
          : exitInfo
            ? `exited with code ${exitInfo.code}`
            : "output ended";
        failTurn(`Claude CLI ${exitDetail} without a result${stderr ? `: ${stderr}` : ""}`);
        return sessionFallback;
      }

      // Push done event after readline closes (async). Pushing synchronously
      // inside handleMessageStop prevents pi from executing tools.
      const output = bridge.getOutput();
      const contentEvents = output.content || [];

      if (contentEvents.length === 0) {
        console.warn(
          `[pi-claude-cli] Claude CLI closed without content events (model=${model.id}, sessionId=${options?.sessionId ?? "none"})`,
        );
      }

      // If stopReason is toolUse but there are no pi-known tool calls in content,
      // it means only user MCP tools were called (filtered by event bridge).
      // Override to "stop" so pi doesn't try to execute non-existent tools.
      const piToolCalls = (output.content || []).filter(
        (c: TextContent | ThinkingContent | ToolCall) => c.type === "toolCall",
      );
      const effectiveReason =
        output.stopReason === "toolUse" && piToolCalls.length === 0
          ? "stop"
          : output.stopReason;

      streamEnded = true;
      stream.push({
        type: "done",
        reason:
          effectiveReason === "toolUse"
            ? "toolUse"
            : effectiveReason === "length"
              ? "length"
              : "stop",
        message: { ...output, stopReason: effectiveReason },
      });
      stream.end();
      return undefined;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (proc) forceKillProcess(proc);
      endStreamWithFailure(options?.signal?.aborted ? "aborted" : "error", errMsg);
      return undefined;
    } finally {
      attemptOver = true;
      clearTimeout(inactivityTimer);
      if (options?.signal && abortHandler) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      // A prompt file whose process never started has no close event to remove it.
      if (!proc) promptFile?.cleanup();
      // A rejected attempt's process has no further use; a settled turn's process is already cleaned up or killed.
      else if (sessionFallback) forceKillProcess(proc);
    }
  };

  /*
  FNXC:ClaudeCliSession 2026-10-10-20:07:
  The first attempt uses the mode the CLI's transcript store indicates.
  If the CLI rejects it (the transcript aged out, or another process created the session in between), the turn is retried once in the other mode: a rejected resume restarts as a new session with the full flattened prompt and system prompt, and a rejected new session resumes.
  */
  (async () => {
    try {
      const firstMode = resolveCliSessionMode(options?.sessionId);
      const fallbackMode = await attemptTurn(firstMode, true);
      if (fallbackMode) {
        debugLog(`CLI rejected session mode ${firstMode} for ${options?.sessionId}; retrying as ${fallbackMode}`);
        await attemptTurn(fallbackMode, false);
      }
    } catch (err) {
      endStreamWithFailure("error", err instanceof Error ? err.message : String(err));
    }
  })();

  return stream;
}
