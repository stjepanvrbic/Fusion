import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";

export type TurnFailureReason = "error" | "aborted";

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
    error: { ...output, stopReason: reason, errorMessage },
  });
  stream.end();
}
