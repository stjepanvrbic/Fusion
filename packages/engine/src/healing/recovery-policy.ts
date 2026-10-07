/**
 * Recovery Policy — bounded exponential-backoff retry for recoverable executor/triage failures.
 *
 * This module provides a **pure decision function** that computes whether a transient
 * failure should be retried, and if so, what the updated recovery state should be.
 *
 * **Design boundary:**
 * - `recovery-policy.ts` handles **inter-poll** recoverable retries — tasks moved back
 *   to todo/triage with backoff, gated by `nextRecoveryAt` in the scheduler/triage poller.
 * - `withRateLimitRetry()` in `rate-limit-retry.ts` handles **intra-session** rate-limit
 *   retries — immediate retry within the same agent session with exponential backoff.
 * - `transient-error-detector.ts` provides the low-level error classifier (`isTransientError`,
 *   `classifyError`). This module consumes those classifiers but does not replace them.
 *
 * **Retry semantics:**
 * - Up to `MAX_RECOVERY_RETRIES` attempts with exponential backoff.
 * - Base delay: 60 seconds, multiplied by 2^attempt, capped at 300 seconds.
 * - ±10% jitter to avoid thundering-herd effects.
 * - Recovery metadata (`recoveryRetryCount`, `nextRecoveryAt`) is persisted on the task
 *   so retries survive engine restarts.
 * - An exhausted ladder escalates. The first escalation in an episode is one fresh-session
 *   reseed; the next exhaustion parks the card visibly (status failed, audited). The counter
 *   is never reset by escalation, so the episode stays bounded until an operator retry or
 *   completion clears it.
 *
 * **Not retried via this policy:**
 * - FNXC:ProviderRateLimitIsolation 2026-07-21-18:00: usage-limit errors
 *   (handled by `UsageLimitPauser` with a provider-scoped task park)
 * - User pauses (handled by pause flow)
 * - Stuck-task-detector kills (handled by stuck flow)
 * - Dependency-abort cleanups (handled by dep-abort flow)
 * - Merge-conflict retries (handled by `mergeRetries` separately)
 */

// ── Constants ────────────────────────────────────────────────────────

/** Maximum number of recovery retry attempts before escalating to failure. */
export const MAX_RECOVERY_RETRIES = 3;

/** Base delay in milliseconds for the first retry (60 seconds). */
export const BASE_DELAY_MS = 60_000;

/** Maximum delay cap in milliseconds (300 seconds = 5 minutes). */
export const MAX_DELAY_MS = 300_000;

/** Backoff multiplier (2x exponential). */
export const BACKOFF_MULTIPLIER = 2;

/**
 * FNXC:RecoveryOwnership 2026-10-07-18:04:
 * Fresh-session reseeds an owner may spend per recovery episode before it must park visibly.
 * FN-9512 reset the counter on every escalation, so a deterministic failure re-armed the ladder forever.
 */
export const MAX_RECOVERY_RESEEDS = 1;

// ── Types ────────────────────────────────────────────────────────────

export interface RecoveryState {
  recoveryRetryCount?: number;
  nextRecoveryAt?: string;
}

export type RecoveryDisposition = "retry" | "escalate";

/** What an owner does with an exhausted ladder: spend a reseed, or park terminally. */
export type RecoveryEscalation = "reseed" | "park";

interface RecoveryDecisionBase {
  /** Updated recovery state to persist on the task. */
  nextState: RecoveryState;
  /** Computed delay in milliseconds (for logging). Zero when exhausted. */
  delayMs: number;
}

export interface RecoveryRetryDecision extends RecoveryDecisionBase {
  disposition: "retry";
  /** Whether the task should be retried in its current lifecycle role. */
  shouldRetry: true;
  exhausted: false;
  /** 1-based attempt within the current ladder, for operator-facing `attempt/max` copy. */
  attempt: number;
}

export interface RecoveryEscalationDecision extends RecoveryDecisionBase {
  disposition: "escalate";
  shouldRetry: false;
  /** The bounded retry owner must hand this failure to an operator-visible escalation. */
  exhausted: true;
  /** `reseed` spends the episode's fresh-session reseed; `park` is the terminal, visible stop. */
  escalation: RecoveryEscalation;
  /** Recovery actions already spent in this episode (retries plus reseeds). */
  attempts: number;
}

/**
 * A discriminated recovery outcome prevents callers from treating an exhausted
 * budget as an ordinary no-op pause.
 */
export type RecoveryDecision = RecoveryRetryDecision | RecoveryEscalationDecision;

export interface RecoveryPolicyOptions {
  /** Override the default budget for a recovery owner. */
  maxRetries?: number;
  /** Reseeds allowed per episode before parking; defaults to `MAX_RECOVERY_RESEEDS`. */
  reseedBudget?: number;
}

// ── Decision function ────────────────────────────────────────────────

/**
 * Compute whether a recoverable failure should be retried and what the
 * updated recovery state should be.
 *
 * This is a **pure function** — it does not call TaskStore or perform I/O.
 * The caller is responsible for persisting `nextState` via `store.updateTask()`.
 *
 * @param currentState - Current recovery metadata from the task
 * @returns A decision describing whether to retry or escalate
 */
export function computeRecoveryDecision(
  currentState: RecoveryState,
  options: RecoveryPolicyOptions = {},
): RecoveryDecision {
  const maxRetries = options.maxRetries ?? MAX_RECOVERY_RETRIES;
  const reseedBudget = Math.max(0, options.reseedBudget ?? MAX_RECOVERY_RESEEDS);
  const currentCount = Math.max(0, currentState.recoveryRetryCount ?? 0);
  /*
  FNXC:RecoveryOwnership 2026-10-07-18:04:
  `recoveryRetryCount` counts every recovery action in the episode: each ladder holds `maxRetries`
  retries followed by one reseed slot. The final ladder has no reseed slot, so the owner parks.
  The FN-9512 escalation still never reads as a silent pause, but it is now bounded: an exhausted
  owner either spends its single reseed or reports a terminal, operator-visible park.
  */
  const ladderLength = maxRetries + 1;
  const totalActions = (reseedBudget + 1) * ladderLength - 1;
  const ladderPosition = currentCount % ladderLength;

  if (currentCount >= totalActions || ladderPosition === maxRetries) {
    const escalation: RecoveryEscalation = currentCount >= totalActions ? "park" : "reseed";
    return {
      disposition: "escalate",
      shouldRetry: false,
      exhausted: true,
      escalation,
      attempts: currentCount,
      nextState: {
        recoveryRetryCount: escalation === "reseed" ? currentCount + 1 : currentCount,
        nextRecoveryAt: undefined,
      },
      delayMs: 0,
    };
  }

  const attempt = ladderPosition + 1;
  // Exponential backoff: base × 2^(attempt-1), capped at max
  const rawDelay = Math.min(
    BASE_DELAY_MS * BACKOFF_MULTIPLIER ** (attempt - 1),
    MAX_DELAY_MS,
  );

  // ±10% jitter to avoid thundering herd
  const jitter = rawDelay * 0.1 * (2 * Math.random() - 1);
  const delayMs = Math.max(0, Math.round(rawDelay + jitter));

  const nextRecoveryAt = new Date(Date.now() + delayMs).toISOString();

  return {
    disposition: "retry",
    shouldRetry: true,
    exhausted: false,
    attempt,
    nextState: {
      recoveryRetryCount: currentCount + 1,
      nextRecoveryAt,
    },
    delayMs,
  };
}

/**
 * FNXC:RecoveryOwnership 2026-10-07-18:04:
 * True when the persisted counter says the owner already spent the episode's reseed and parked.
 * Automatic re-entry points (restart recovery, unpause resume) use it to keep a terminal park parked.
 */
export function isRecoveryEpisodeParked(state: RecoveryState, options: RecoveryPolicyOptions = {}): boolean {
  if (!state.recoveryRetryCount) return false;
  const decision = computeRecoveryDecision(state, options);
  return decision.disposition === "escalate" && decision.escalation === "park";
}

/**
 * Format a retry delay for human-readable logging.
 *
 * @param delayMs - Delay in milliseconds
 * @returns Human-readable string like "60s" or "120s"
 */
export function formatDelay(delayMs: number): string {
  const seconds = Math.round(delayMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return seconds % 60 === 0 ? `${minutes}m` : `${seconds}s`;
}
