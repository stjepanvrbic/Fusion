/**
 * FNXC:MergeRestartDeferral 2026-10-08-06:10:
 * A restart is never a merge failure. ProjectEngine rejects pending and refused merge requests with this name-tagged error while it is stopping or not yet started.
 * Callers classify on the name, never on message text, and must leave the card in its review lane with no status, error, or retry spend so the restarted engine's merge sweep re-dispatches it.
 * Name-tagged rather than a class so test doubles of the engine stay compatible, mirroring `MergeAbortedError`.
 */
export const ENGINE_SHUTDOWN_ERROR_NAME = "EngineShutdownError";

export function createEngineShutdownError(message: string): Error {
  const error = new Error(message);
  error.name = ENGINE_SHUTDOWN_ERROR_NAME;
  return error;
}

export function isEngineShutdownError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === ENGINE_SHUTDOWN_ERROR_NAME;
}
