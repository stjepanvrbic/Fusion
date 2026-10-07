/*
FNXC:AiMerge 2026-10-07-15:11:
AI-merge sessions were disposed fire-and-forget, so the clean-room cleanup ran while the agent's child
processes still held handles and every AI merge logged "Directory not empty". Disposal is now awaited
but bounded: a hung or failing dispose must never wedge or fail the merge.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_SESSION_DISPOSE_TIMEOUT_MS, disposeAgentSessionBounded } from "../agents/dispose-agent-session.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("disposeAgentSessionBounded", () => {
  it("waits for an asynchronous dispose to finish", async () => {
    let release!: () => void;
    const dispose = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    let settled = false;
    const pending = disposeAgentSessionBounded({ dispose }).then((outcome) => { settled = true; return outcome; });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(pending).resolves.toBe("disposed");
  });

  it("gives up after the bound when dispose never settles", async () => {
    vi.useFakeTimers();
    const pending = disposeAgentSessionBounded({ dispose: () => new Promise<void>(() => undefined) });

    await vi.advanceTimersByTimeAsync(AGENT_SESSION_DISPOSE_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe("timed-out");
  });

  it("absorbs synchronous throws and rejections", async () => {
    await expect(disposeAgentSessionBounded({ dispose: () => { throw new Error("boom"); } })).resolves.toBe("failed");
    await expect(disposeAgentSessionBounded({ dispose: () => Promise.reject(new Error("boom")) })).resolves.toBe("failed");
  });

  it("treats a synchronous dispose as finished", async () => {
    const dispose = vi.fn();
    await expect(disposeAgentSessionBounded({ dispose })).resolves.toBe("disposed");
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
