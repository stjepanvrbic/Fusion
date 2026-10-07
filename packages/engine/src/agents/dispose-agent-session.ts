/*
FNXC:AiMerge 2026-10-07-15:11:
AI-merge agent sessions were disposed fire-and-forget (`session.dispose()` without await), so the
clean-room removal in runAiMerge's finally raced the agent's still-exiting child processes and, on
Windows, every AI merge logged "Directory not empty". Callers now await disposal before releasing the
checkout. Disposal is bounded: a hung or throwing dispose must never wedge or fail the merge, because
the merge outcome is already decided when the agent call returns.
*/

/** Upper bound on waiting for an agent session (and its child processes) to wind down. */
export const AGENT_SESSION_DISPOSE_TIMEOUT_MS = 10_000;

export type AgentSessionDisposeOutcome = "disposed" | "timed-out" | "failed";

/** Awaits `session.dispose()` (sync or async) for at most `timeoutMs`; never throws. */
export async function disposeAgentSessionBounded(
  session: { dispose: () => unknown },
  options: { timeoutMs?: number } = {},
): Promise<AgentSessionDisposeOutcome> {
  const timeoutMs = options.timeoutMs ?? AGENT_SESSION_DISPOSE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<AgentSessionDisposeOutcome>((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), timeoutMs);
    timer.unref?.();
  });
  const disposed = (async (): Promise<AgentSessionDisposeOutcome> => {
    try {
      await session.dispose();
      return "disposed";
    } catch {
      return "failed";
    }
  })();
  try {
    return await Promise.race([disposed, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
