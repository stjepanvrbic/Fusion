import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";

export type TurnFailureReason = "error" | "aborted";

/**
 * FNXC:ClaudeCliRateLimit 2026-10-10-17:50:
 * Only the error string crosses Pi's session boundary into Fusion's lanes, so every failed turn names its provider.
 * The engine keys its Claude CLI rate-limit retry ladder on this marker; keep it in sync with `CLAUDE_CLI_FAILURE_MARKER` in the engine's `errors/rate-limit-retry.ts`.
 */
export const CLAUDE_CLI_FAILURE_MARKER = "pi-claude-cli: ";

/**
 * End a turn as failed or aborted.
 *
 * FNXC:ClaudeCliProvider 2026-10-07-19:34:
 * A failed or cancelled CLI turn must never read as a completed one. Both routes used to push `done` with `stopReason: "stop"` and an "Error: ..." text block, so Fusion's session layer saw a normal reply and cross-runtime fallback, credential rotation and retry classification never engaged.
 * Terminate with pi-ai's `error` event, whose payload is the AssistantMessage carrying `stopReason` `error`/`aborted` and `errorMessage`; pi's agent loop and Fusion read both. Partial content streamed before the failure is kept.
 */
export function pushTurnFailure(
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  reason: TurnFailureReason,
  errorMessage: string,
): void {
  stream.push({
    type: "error",
    reason,
    error: { ...output, stopReason: reason, errorMessage: `${CLAUDE_CLI_FAILURE_MARKER}${errorMessage}` },
  });
  stream.end();
}
