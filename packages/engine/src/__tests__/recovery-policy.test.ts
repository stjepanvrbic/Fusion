import { describe, it, expect, vi, afterEach } from "vitest";
import {
  computeRecoveryDecision,
  formatDelay,
  MAX_RECOVERY_RETRIES,
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  BACKOFF_MULTIPLIER,
  MAX_RECOVERY_RESEEDS,
} from "../healing/recovery-policy.js";

describe("computeRecoveryDecision", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns shouldRetry=true on first failure (count=0)", () => {
    const decision = computeRecoveryDecision({});
    expect(decision.disposition).toBe("retry");
    expect(decision.shouldRetry).toBe(true);
    expect(decision.exhausted).toBe(false);
    expect(decision.nextState.recoveryRetryCount).toBe(1);
    expect(decision.nextState.nextRecoveryAt).toBeDefined();
    expect(decision.delayMs).toBeGreaterThan(0);
  });

  it("increments recovery count on each attempt", () => {
    const d1 = computeRecoveryDecision({ recoveryRetryCount: 0 });
    expect(d1.nextState.recoveryRetryCount).toBe(1);

    const d2 = computeRecoveryDecision({ recoveryRetryCount: 1 });
    expect(d2.nextState.recoveryRetryCount).toBe(2);

    const d3 = computeRecoveryDecision({ recoveryRetryCount: 2 });
    expect(d3.nextState.recoveryRetryCount).toBe(3);
  });

  it("spends the episode reseed after MAX_RECOVERY_RETRIES attempts without resetting the counter", () => {
    const decision = computeRecoveryDecision({
      recoveryRetryCount: MAX_RECOVERY_RETRIES,
    });
    expect(decision.disposition).toBe("escalate");
    expect(decision.shouldRetry).toBe(false);
    expect(decision.exhausted).toBe(true);
    if (decision.disposition !== "escalate") throw new Error("expected escalation");
    expect(decision.escalation).toBe("reseed");
    expect(decision.nextState.recoveryRetryCount).toBe(MAX_RECOVERY_RETRIES + 1);
    expect(decision.nextState.nextRecoveryAt).toBeUndefined();
    expect(decision.delayMs).toBe(0);
  });

  it("bounds the whole episode: ladder, one reseed, ladder, then a terminal park", () => {
    const outcomes: string[] = [];
    let count: number | undefined;
    for (let step = 0; step < 20; step++) {
      const decision = computeRecoveryDecision({ recoveryRetryCount: count });
      outcomes.push(decision.disposition === "retry" ? `retry${decision.attempt}` : decision.escalation);
      if (decision.disposition === "escalate" && decision.escalation === "park") {
        // A parked episode stays parked: re-evaluating the persisted state never re-arms the ladder.
        expect(computeRecoveryDecision(decision.nextState).disposition).toBe("escalate");
        break;
      }
      count = decision.nextState.recoveryRetryCount;
    }
    expect(MAX_RECOVERY_RESEEDS).toBe(1);
    expect(outcomes).toEqual(["retry1", "retry2", "retry3", "reseed", "retry1", "retry2", "retry3", "park"]);
  });

  it("restarts the backoff ladder after a reseed", () => {
    const decision = computeRecoveryDecision({ recoveryRetryCount: MAX_RECOVERY_RETRIES + 1 });
    if (decision.disposition !== "retry") throw new Error("expected retry");
    expect(decision.attempt).toBe(1);
    expect(decision.delayMs).toBeLessThanOrEqual(BASE_DELAY_MS * 1.1);
  });

  it("honors an owner-specific bounded retry budget", () => {
    const decision = computeRecoveryDecision({ recoveryRetryCount: 1 }, { maxRetries: 1 });
    expect(decision.disposition).toBe("escalate");
    expect(decision.exhausted).toBe(true);
  });

  it("parks immediately on exhaustion when the owner has no reseed budget", () => {
    const decision = computeRecoveryDecision({ recoveryRetryCount: 3 }, { maxRetries: 3, reseedBudget: 0 });
    if (decision.disposition !== "escalate") throw new Error("expected escalation");
    expect(decision.escalation).toBe("park");
    expect(decision.nextState.recoveryRetryCount).toBe(3);
  });

  it("parks when count exceeds the episode budget (overflow safety)", () => {
    const decision = computeRecoveryDecision({
      recoveryRetryCount: 999,
    });
    expect(decision.shouldRetry).toBe(false);
    expect(decision.exhausted).toBe(true);
    if (decision.disposition !== "escalate") throw new Error("expected escalation");
    expect(decision.escalation).toBe("park");
  });

  it("uses exponential backoff with increasing delays", () => {
    // Use fixed random for deterministic test
    vi.spyOn(Math, "random").mockReturnValue(0.5); // No jitter when random=0.5

    const d1 = computeRecoveryDecision({});
    const d2 = computeRecoveryDecision({ recoveryRetryCount: 1 });
    const d3 = computeRecoveryDecision({ recoveryRetryCount: 2 });

    // Base: 60s, then 120s, then 240s (capped at 300s)
    expect(d1.delayMs).toBe(BASE_DELAY_MS); // 60s × 2^0 = 60s
    expect(d2.delayMs).toBe(BASE_DELAY_MS * BACKOFF_MULTIPLIER); // 60s × 2^1 = 120s
    expect(d3.delayMs).toBe(BASE_DELAY_MS * BACKOFF_MULTIPLIER ** 2); // 60s × 2^2 = 240s
  });

  it("caps delay at MAX_DELAY_MS", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    // With high retry count, delay should be capped
    const decision = computeRecoveryDecision({ recoveryRetryCount: 2 });
    expect(decision.delayMs).toBeLessThanOrEqual(MAX_DELAY_MS * 1.1); // Allow for jitter
  });

  it("applies jitter (±10%) to delays", () => {
    // Zero jitter
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const noJitter = computeRecoveryDecision({});

    // Max positive jitter
    vi.spyOn(Math, "random").mockReturnValue(1.0);
    const maxJitter = computeRecoveryDecision({});

    // Max negative jitter
    vi.spyOn(Math, "random").mockReturnValue(0.0);
    const minJitter = computeRecoveryDecision({});

    // All should be within ±10% of base delay
    const base = BASE_DELAY_MS;
    expect(noJitter.delayMs).toBe(base);
    expect(maxJitter.delayMs).toBeGreaterThan(base);
    expect(maxJitter.delayMs).toBeLessThanOrEqual(base * 1.1);
    expect(minJitter.delayMs).toBeLessThan(base);
    expect(minJitter.delayMs).toBeGreaterThanOrEqual(base * 0.9);
  });

  it("sets nextRecoveryAt to a future ISO timestamp", () => {
    const before = Date.now();
    const decision = computeRecoveryDecision({});
    const after = Date.now();

    const recoveryTime = new Date(decision.nextState.nextRecoveryAt!).getTime();
    expect(recoveryTime).toBeGreaterThanOrEqual(before + decision.delayMs - 1);
    expect(recoveryTime).toBeLessThanOrEqual(after + decision.delayMs + 1);
  });

  it("treats undefined recoveryRetryCount as 0", () => {
    const decision = computeRecoveryDecision({ recoveryRetryCount: undefined });
    expect(decision.shouldRetry).toBe(true);
    expect(decision.nextState.recoveryRetryCount).toBe(1);
  });

  it("clears the recovery deadline but keeps the episode count when exhausted", () => {
    const decision = computeRecoveryDecision({
      recoveryRetryCount: MAX_RECOVERY_RETRIES,
      nextRecoveryAt: new Date().toISOString(),
    });
    expect(decision.nextState.recoveryRetryCount).toBe(MAX_RECOVERY_RETRIES + 1);
    expect(decision.nextState.nextRecoveryAt).toBeUndefined();
  });
});

describe("formatDelay", () => {
  it("formats seconds under 60 as Ns", () => {
    expect(formatDelay(5000)).toBe("5s");
    expect(formatDelay(30000)).toBe("30s");
    expect(formatDelay(59000)).toBe("59s");
  });

  it("formats exact minutes as Nm", () => {
    expect(formatDelay(60000)).toBe("1m");
    expect(formatDelay(120000)).toBe("2m");
    expect(formatDelay(300000)).toBe("5m");
  });

  it("formats non-exact minutes as seconds", () => {
    expect(formatDelay(90000)).toBe("90s");
    expect(formatDelay(150000)).toBe("150s");
  });

  it("handles zero", () => {
    expect(formatDelay(0)).toBe("0s");
  });
});

describe("constants", () => {
  it("MAX_RECOVERY_RETRIES is 3", () => {
    expect(MAX_RECOVERY_RETRIES).toBe(3);
  });

  it("BASE_DELAY_MS is 60 seconds", () => {
    expect(BASE_DELAY_MS).toBe(60_000);
  });

  it("MAX_DELAY_MS is 300 seconds (5 minutes)", () => {
    expect(MAX_DELAY_MS).toBe(300_000);
  });
});
