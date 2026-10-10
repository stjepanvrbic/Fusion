/*
FNXC:ClaudeCliRateLimit 2026-10-10-17:54:
A review step that hits a Claude CLI 429 retries in place on the shared ladder, opening a new session (and so a fresh `claude` process) each time.
Recovery inside the ladder records a normal verdict with no provider failure, so the step neither freezes nor parks failed.
A 429 that outlasts the ladder records the provider failure that sends the card into the external-block freeze.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, mockedCreateFnAgent, mockedExecSync, resetExecutorMocks } from "./executor-test-helpers.js";
import { buildStepFailureContextPatch } from "../executor/run-graph-custom-node.js";
import {
  CLAUDE_CLI_FAILURE_MARKER,
  CLAUDE_CLI_RATE_LIMIT_RETRY_DELAYS_MS,
  withRateLimitRetry,
} from "../errors/rate-limit-retry.js";

const actualRateLimitRetry = await vi.importActual<typeof import("../errors/rate-limit-retry.js")>("../errors/rate-limit-retry.js");

const CLI_429 = `${CLAUDE_CLI_FAILURE_MARKER}Claude CLI result success (is_error) (HTTP 429): You've hit your limit · resets 3pm`;
const APPROVE = '{"verdict":"APPROVE","notes":"Checked the diff and its tests; the change meets the task.","findings":[]}';

function baseTask() {
  const now = new Date().toISOString();
  return {
    id: "FN-CLI-429",
    title: "Review under a CLI rate limit",
    description: "Review under a CLI rate limit",
    column: "in-progress" as const,
    worktree: "/tmp/fn-cli-429-wt",
    branch: "fusion/fn-cli-429",
    baseCommitSha: "abc123",
    dependencies: [],
    steps: [{ name: "Implement", status: "done" as const }],
    currentStep: 0,
    log: [],
    createdAt: now,
    updatedAt: now,
  };
}

function codeReviewStep() {
  const now = new Date().toISOString();
  return {
    id: "graph:code-review-step",
    name: "Code Review",
    description: "",
    mode: "prompt" as const,
    phase: "pre-merge" as const,
    gateMode: "gate" as const,
    prompt: "Review the implementation.",
    toolMode: "readonly" as const,
    optionalGroupId: "code-review",
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

/** One session per reply; an Error reply rejects that session's prompt, a string streams as the reviewer's text. */
function installSessions(replies: Array<string | Error>) {
  let created = 0;
  mockedCreateFnAgent.mockImplementation(async () => {
    const reply = replies[Math.min(created++, replies.length - 1)];
    const listeners: Array<(event: unknown) => void> = [];
    const session = {
      state: {},
      subscribe: (listener: (event: unknown) => void) => {
        listeners.push(listener);
        return () => {};
      },
      prompt: vi.fn(async () => {
        if (reply instanceof Error) throw reply;
        for (const listener of listeners) {
          listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: reply } });
        }
      }),
      dispose: vi.fn(),
    };
    return { session } as never;
  });
}

function startReview() {
  const store = createMockStore();
  const executor = new TaskExecutor(store as never, "/tmp/test", {
    agentStore: { getAgent: vi.fn().mockResolvedValue(null), createAgent: vi.fn() },
  } as never);
  const outcome = (executor as unknown as { executeWorkflowStep: (...args: unknown[]) => Promise<Record<string, unknown>> })
    .executeWorkflowStep(baseTask(), codeReviewStep(), "/tmp/fn-cli-429-wt", { workflowStepTimeoutMs: 600_000 }, undefined);
  return { outcome, store };
}

describe("workflow review step under a Claude CLI rate limit", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.mocked(withRateLimitRetry).mockImplementation(actualRateLimitRetry.withRateLimitRetry);
    mockedExecSync.mockImplementation(() => Buffer.from(""));
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("retries in place with a new session and records the verdict without a provider failure", async () => {
    installSessions([new Error(CLI_429), APPROVE]);
    const { outcome, store } = startReview();

    await vi.advanceTimersByTimeAsync(CLAUDE_CLI_RATE_LIMIT_RETRY_DELAYS_MS[0]);
    const result = await outcome;

    expect(result).toMatchObject({ success: true, verdict: "APPROVE" });
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);
    expect(buildStepFailureContextPatch("code-review", result as never, "prompt")).toEqual({});
    expect(store.logEntry).toHaveBeenCalledWith(baseTask().id, expect.stringContaining("rate limited by the Claude CLI — retry 1 in 20s"), undefined, undefined);
  });

  it("records the rate-limit provider failure that freezes the card once the ladder is spent", async () => {
    installSessions([new Error(CLI_429)]);
    const { outcome } = startReview();

    for (const delay of CLAUDE_CLI_RATE_LIMIT_RETRY_DELAYS_MS) await vi.advanceTimersByTimeAsync(delay);
    const result = await outcome;

    expect(result).toMatchObject({ success: false, error: CLI_429 });
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(CLAUDE_CLI_RATE_LIMIT_RETRY_DELAYS_MS.length + 1);
    expect(buildStepFailureContextPatch("code-review", result as never, "prompt")).toMatchObject({
      providerFailure: { origin: "model-provider", code: "RATE_LIMIT" },
    });
  });

  it("does not retry a rate limit from another provider in place", async () => {
    installSessions([new Error("429 too many requests")]);
    const { outcome } = startReview();
    await vi.advanceTimersByTimeAsync(0);

    expect(await outcome).toMatchObject({ success: false, error: "429 too many requests" });
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
  });
});
