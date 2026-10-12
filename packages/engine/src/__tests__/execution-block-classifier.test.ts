import { describe, expect, it } from "vitest";
import {
  BLOCKED_THRASH_LIMIT,
  DECLARED_EXTERNAL_FAILURE_CAUSES,
  classifyBlockedExit,
  classifyDeclaredExternalObstacle,
  classifyExternalObstacle,
  countBlockedThrashHits,
  isDurableBlockedTask,
  partitionBlockedByRefs,
} from "../execution-block-classifier.js";
import { ANTHROPIC_RATE_LIMIT_429 } from "./fixtures/rate-limit-deferral-store.js";

/*
FNXC:HonestBlockedExit 2026-08-02-23:59 (operator decision — FN-8728 vs PR #2398):
Blocked exits classify on Fusion task dependencies ONLY. PR refs and file-claim
reason language must never produce a durable park — open PRs are not blockers.
*/

describe("classifyExternalObstacle", () => {
  it("does not misclassify lifecycle transition rejections as credentials", () => {
    expect(classifyExternalObstacle("Cannot move CLOU-058 to 'todo': Forbidden lifecycle path F5: 'in-progress' (wip) → 'todo' (hold); reason=self-healing-session-recovery. A WIP card may return to planning only for Plan Review REVISE")).toBeUndefined();
    expect(classifyExternalObstacle("Step 5 start was rejected by the task lifecycle projection")).toBeUndefined();
    expect(classifyExternalObstacle("TransitionRejectionError: Cannot move task")).toBeUndefined();
  });

  /*
  FNXC:ExternalBlockAutoResume 2026-10-08-08:29:
  Rate limits (transient, auto-resumed) are a different code from billing/quota exhaustion (operator action), and a billing
  signal wins when both appear, because providers answer an exhausted quota with HTTP 429 too.
  */
  it("splits transient rate limits from billing and quota exhaustion", () => {
    for (const message of [
      ANTHROPIC_RATE_LIMIT_429,
      'Usage limit detected (executor/unknown): 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your rate limit"}}',
      "Too Many Requests",
      "overloaded_error: Overloaded",
      "529 server overloaded",
    ]) {
      expect(classifyExternalObstacle(message)).toEqual({ origin: "model-provider", code: "RATE_LIMIT" });
    }
    for (const message of [
      "quota exceeded for this billing period",
      "429 You exceeded your current quota, please check your plan and billing details",
      "Your credit balance is too low to access the API",
      "insufficient_quota",
    ]) {
      expect(classifyExternalObstacle(message)).toEqual({ origin: "model-provider", code: "USAGE_LIMIT" });
    }
  });

  it("continues to classify genuine credential failures", () => {
    expect(classifyExternalObstacle("Invalid API key: authentication failed")).toEqual({ origin: "credentials", code: "CREDENTIALS" });
  });
});

describe("classifyDeclaredExternalObstacle", () => {
  /** The reason stored on KB-147's freeze, verbatim. */
  const KB147_SESSION_14_REASON = "Awaiting the owner's choice among KB-147 options 1-4 (KB-144 recommends 1 with 2). No owner-authored choice is recorded on this card: the task record has no comments or steering messages, the description is the unchanged original, and the only task documents are the planner's plan and the executor's owner-decision-request. The specification forbids choosing for the owner or defaulting to the recommendation, so Steps 2-8 cannot start. This is not a host, network, provider or credential failure and no tool or check is missing. Unblock: an owner comment on KB-147 naming the option numbers (option 3 only with explicit approval of the wider connection budget, option 4 only with sub-variant 4a or 4b).";

  it.each([
    ["host-environment", "ENOSPC: no space left on device, write", "ENOSPC"],
    ["host-environment", "Error: EMFILE: too many open files, open 'a.ts'", "EMFILE"],
    ["network", "read ECONNRESET", "ECONNRESET"],
    ["network", "request failed: socket hang up", "SOCKET_HANG_UP"],
    ["model-provider", ANTHROPIC_RATE_LIMIT_429, "RATE_LIMIT"],
    ["model-provider", "429 You exceeded your current quota, please check your plan and billing details", "USAGE_LIMIT"],
    ["credentials", "Invalid API key: authentication failed", "CREDENTIALS"],
  ] as const)("classifies %s evidence: %s", (cause, observedError, code) => {
    expect(classifyDeclaredExternalObstacle({ cause, observedError })).toEqual({ origin: cause, code });
  });

  it("accepts exactly the origins the session-failure classifier can return", () => {
    expect([...DECLARED_EXTERNAL_FAILURE_CAUSES].sort()).toEqual(["credentials", "host-environment", "model-provider", "network"]);
  });

  it.each([
    ["credentials", "ENOSPC: no space left on device, write"],
    ["host-environment", "read ECONNRESET"],
    ["network", "Invalid API key: authentication failed"],
    ["model-provider", "Invalid API key: authentication failed"],
    ["credentials", ANTHROPIC_RATE_LIMIT_429],
    ["third-party-service", "ENOSPC: no space left on device, write"],
    ["human-decision", "Invalid API key: authentication failed"],
    [undefined, "ENOSPC: no space left on device, write"],
  ])("returns nothing when the declared class %s disagrees with the evidence", (cause, observedError) => {
    expect(classifyDeclaredExternalObstacle({ cause, observedError })).toBeUndefined();
  });

  it.each(["", "   ", "\n\t", undefined, null, 429, { message: "ENOSPC" }])("returns nothing for evidence that is not error text: %j", (observedError) => {
    for (const cause of DECLARED_EXTERNAL_FAILURE_CAUSES) {
      expect(classifyDeclaredExternalObstacle({ cause, observedError })).toBeUndefined();
    }
    expect(classifyDeclaredExternalObstacle(undefined)).toBeUndefined();
  });

  it("does not freeze transient credential rotation or a lifecycle rejection", () => {
    for (const observedError of [
      '401 {"type":"authentication_error","message":"Invalid authentication credentials"}',
      "Cannot move CLOU-058 to 'todo': Forbidden lifecycle path F5: 'in-progress' (wip) → 'todo' (hold); reason=self-healing-session-recovery",
      "Step 5 start was rejected by the task lifecycle projection",
      "TransitionRejectionError: Cannot move task",
    ]) {
      expect(classifyDeclaredExternalObstacle({ cause: "credentials", observedError })).toBeUndefined();
    }
  });

  it("gives an explanation no path into classification", () => {
    // The explanation that froze a card as credentials/CREDENTIALS still matches the prose-reading classifier.
    expect(classifyExternalObstacle(KB147_SESSION_14_REASON)).toEqual({ origin: "credentials", code: "CREDENTIALS" });

    for (const cause of DECLARED_EXTERNAL_FAILURE_CAUSES) {
      const declaration = { cause, reason: KB147_SESSION_14_REASON, message: KB147_SESSION_14_REASON };
      expect(classifyDeclaredExternalObstacle(declaration)).toBeUndefined();
      expect(classifyDeclaredExternalObstacle({ ...declaration, observedError: "" })).toBeUndefined();
    }
    expect(classifyDeclaredExternalObstacle.length).toBe(1);
  });
});

describe("partitionBlockedByRefs", () => {
  it("keeps task ids and discards legacy pr refs and junk", () => {
    expect(partitionBlockedByRefs(["FN-8145", "pr:2398", "#2400", "PR-12", "  ", "fn-8145"])).toEqual({
      taskIds: ["FN-8145"],
    });
  });
});

describe("classifyBlockedExit", () => {
  it("classifies empty blockers as repairable plan defects without routing authority", () => {
    const c = classifyBlockedExit("requirements contradict each other", []);
    expect(c).toEqual({ class: "plan-defect", thrashSignature: "plan-defect" });
    expect(c).not.toHaveProperty("allowAutoReplan");
  });

  it("ignores file-claim / PR language — reason prose never makes a block durable", () => {
    const reason =
      "Required SQL finding packages/core/src/task-store/reads.ts:619 is actively claimed by PR #2398. " +
      "check-file-claimed reports collision policy.";
    const c = classifyBlockedExit(reason, []);
    expect(c.class).toBe("plan-defect");
    expect(c).not.toHaveProperty("allowAutoReplan");
  });

  it("classifies task dependencies as durable external waits", () => {
    const c = classifyBlockedExit("waiting on upstream", ["FN-8145"]);
    expect(c.class).toBe("external");
    expect(c.thrashSignature).toBe("tasks:FN-8145");
  });

  it("discards pr: refs in blockedBy — a PR-only block is a plan defect", () => {
    const c = classifyBlockedExit("files claimed", ["pr:2398"]);
    expect(c.class).toBe("plan-defect");
    expect(c).not.toHaveProperty("allowAutoReplan");
  });
});

describe("isDurableBlockedTask", () => {
  it("honors only metadata-classed external (task-dependency) parks", () => {
    expect(
      isDurableBlockedTask({
        status: "failed",
        error: "BLOCKED: waiting on FN-8145",
        sourceMetadata: { blockedClass: "external" },
      }),
    ).toBe(true);
    // Legacy FN-8700 file-claim parks are deliberately NOT durable anymore.
    expect(
      isDurableBlockedTask({
        status: "failed",
        error: "BLOCKED: actively claimed by PR #2398",
        sourceMetadata: {
          blockedClass: "file-claim",
          externalBlockers: [{ kind: "github-pr", number: 2398 }],
        },
      }),
    ).toBe(false);
    expect(
      isDurableBlockedTask({ status: "failed", error: "BLOCKED: actively claimed by PR #2398" }),
    ).toBe(false);
  });
});

describe("countBlockedThrashHits", () => {
  it("counts recent BLOCKED log rows matching the task-dependency signature", () => {
    const now = Date.parse("2026-08-02T01:30:00.000Z");
    const log = [
      { action: "BLOCKED: waiting on FN-8145", timestamp: "2026-08-02T01:00:00.000Z" },
      { action: "BLOCKED: still waiting on FN-8145", timestamp: "2026-08-02T01:10:00.000Z" },
      { action: "BLOCKED: waiting on FN-8145", timestamp: "2026-08-02T01:20:00.000Z" },
      { action: "unrelated progress", timestamp: "2026-08-02T01:25:00.000Z" },
    ];
    const sig = classifyBlockedExit("waiting on upstream", ["FN-8145"]).thrashSignature;
    expect(countBlockedThrashHits(log, sig, now)).toBeGreaterThanOrEqual(BLOCKED_THRASH_LIMIT);
  });

  it("never counts hits for the plan-defect signature", () => {
    const now = Date.parse("2026-08-02T01:30:00.000Z");
    const log = [{ action: "BLOCKED: anything", timestamp: "2026-08-02T01:20:00.000Z" }];
    expect(countBlockedThrashHits(log, "plan-defect", now)).toBe(0);
  });
});
