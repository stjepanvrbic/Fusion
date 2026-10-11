import { describe, expect, it, vi } from "vitest";

vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn(),
  wrapToolsWithOutputBudget: vi.fn((tools: unknown[]) => tools),
  wrapToolsWithRtkRewrite: vi.fn((tools: unknown[]) => tools),
  wrapToolsWithPermanentAgentGating: vi.fn((tools: unknown[]) => tools),
  wrapToolsWithActionGate: vi.fn((tools: unknown[]) => tools),
  describeModel: vi.fn().mockReturnValue("mock-provider/mock-model"),
  formatModelMarkerDetails: vi.fn((model: string) => model),
  promptWithFallback: vi.fn(),
}));

import { reviewStep } from "../execution/reviewer.js";
import { createFnAgent, promptWithFallback } from "../pi.js";
import { QUOTED_DECOY_PATH, plannedPromptWithQuotedScope } from "./_quoted-file-scope-prompt.js";

/*
FNXC:FileScope 2026-10-11-14:50:
After a context-limit failure the reviewer retries with a reduced prompt summary that quotes the File Scope section.
That section must be the plan's, never a File Scope list quoted in the Original Description.
*/
describe("reviewStep compacted retry", () => {
  it("quotes the plan's File Scope, not a list quoted in the Original Description", async () => {
    const subscribers: Array<(event: unknown) => void> = [];
    vi.mocked(createFnAgent).mockResolvedValue({
      session: {
        prompt: vi.fn(async () => {
          for (const subscriber of subscribers) {
            subscriber({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "### Verdict: APPROVE\n### Summary\nok" } });
          }
        }),
        subscribe: vi.fn((cb: (event: unknown) => void) => subscribers.push(cb)),
        dispose: vi.fn(),
      },
    } as never);
    vi.mocked(promptWithFallback)
      .mockImplementationOnce(async () => {
        throw new Error("exceeded model token limit: 262144 (requested: 262879)");
      })
      .mockImplementationOnce(async (session, prompt) => {
        await session.prompt(prompt);
      });
    const task = { id: "KB-1", column: "in-progress", steps: [], log: [], reviewerContextRetryCount: 0 };
    const store = {
      getSettings: vi.fn().mockResolvedValue({ maxReviewerContextRetries: 2, maxTotalRetriesBeforeFail: 25 }),
      getTask: vi.fn(async () => task),
      updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => Object.assign(task, patch)),
      logEntry: vi.fn().mockResolvedValue(undefined),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
    };

    await reviewStep("worktree", "KB-1", 1, "Work", "code", plannedPromptWithQuotedScope(), "abc123", { store: store as never, taskId: "KB-1" });

    const retryRequest = vi.mocked(promptWithFallback).mock.calls[1]?.[1] as string;
    expect(retryRequest).toContain("- `packages/engine/src/real.ts`");
    expect(retryRequest).not.toContain(QUOTED_DECOY_PATH);
  });
});
