import { beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

vi.mock("../provider.js", () => ({
  streamViaCli: vi.fn(),
}));

import { streamViaCli } from "../provider.js";
import { DroidRuntimeAdapter } from "../runtime-adapter.js";

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "droid-cli",
    provider: "droid-cli",
    model: "droid-pro",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  } as AssistantMessage;
}

function newStream(): AssistantMessageEventStream {
  // @ts-expect-error pi-ai's re-export chain hides the constructor from tsc; it exists at runtime.
  return new AssistantMessageEventStream();
}

describe("DroidRuntimeAdapter", () => {
  beforeEach(() => {
    vi.mocked(streamViaCli).mockReset();
  });

  it("createSession uses configured model and callbacks", async () => {
    const onText = vi.fn();
    const adapter = new DroidRuntimeAdapter({ droidModel: "droid-pro" });
    const result = await adapter.createSession({ cwd: process.cwd(), systemPrompt: "sys", onText });

    expect(result.session.model).toBe("droid-pro");
    expect(result.session.callbacks.onText).toBe(onText);
    expect(adapter.describeModel(result.session)).toBe("droid/droid-pro");
  });

  it("consumes the real pi-ai stream, forwarding text and thinking deltas and settling on done", async () => {
    const stream = newStream();
    vi.mocked(streamViaCli).mockReturnValue(stream);
    const onText = vi.fn();
    const onThinking = vi.fn();
    const adapter = new DroidRuntimeAdapter({ droidModel: "droid-pro" });
    const { session } = await adapter.createSession({ cwd: "/work/task", systemPrompt: "sys", onText, onThinking });

    const pending = adapter.promptWithFallback(session, "hello");
    const partial = message();
    stream.push({ type: "text_delta", contentIndex: 0, delta: "a", partial });
    stream.push({ type: "thinking_delta", contentIndex: 1, delta: "b", partial });
    stream.push({ type: "done", reason: "stop", message: message() });
    stream.end();
    await expect(pending).resolves.toBeUndefined();

    expect(onText).toHaveBeenCalledWith("a");
    expect(onThinking).toHaveBeenCalledWith("b");
    expect(streamViaCli).toHaveBeenCalledWith(
      expect.objectContaining({ id: "droid-pro", provider: "droid-cli" }),
      expect.objectContaining({ systemPrompt: "sys" }),
      expect.objectContaining({ sessionId: "" }),
    );
  });

  it("settles an empty completion", async () => {
    const stream = newStream();
    vi.mocked(streamViaCli).mockReturnValue(stream);
    const adapter = new DroidRuntimeAdapter();
    const { session } = await adapter.createSession({ cwd: "/work/task", systemPrompt: "sys" });
    const pending = adapter.promptWithFallback(session, "hello");
    stream.push({ type: "done", reason: "stop", message: message() });
    await expect(pending).resolves.toBeUndefined();
  });

  it("rejects a terminal error, whether pushed as an error event or as a done message carrying errorMessage", async () => {
    const adapter = new DroidRuntimeAdapter();
    const { session } = await adapter.createSession({ cwd: "/work/task", systemPrompt: "sys" });

    const errored = newStream();
    vi.mocked(streamViaCli).mockReturnValueOnce(errored);
    const first = adapter.promptWithFallback(session, "hello");
    errored.push({ type: "error", reason: "error", error: message({ stopReason: "error", errorMessage: "boom" }) });
    await expect(first).rejects.toThrow("boom");

    const doneWithError = newStream();
    vi.mocked(streamViaCli).mockReturnValueOnce(doneWithError);
    const second = adapter.promptWithFallback(session, "hello");
    doneWithError.push({ type: "done", reason: "stop", message: message({ errorMessage: "Droid CLI exited with code 1" }) });
    await expect(second).rejects.toThrow("Droid CLI exited with code 1");
  });

  it("settles when the stream ends without a terminal event", async () => {
    const stream = newStream();
    vi.mocked(streamViaCli).mockReturnValue(stream);
    const adapter = new DroidRuntimeAdapter();
    const { session } = await adapter.createSession({ cwd: "/work/task", systemPrompt: "sys" });
    const pending = adapter.promptWithFallback(session, "hello");
    stream.end();
    await expect(pending).resolves.toBeUndefined();
  });

  it("launches every turn in its own session's working directory, not the host's", async () => {
    const adapter = new DroidRuntimeAdapter();
    const a = await adapter.createSession({ cwd: "C:\\worktrees\\task-a", systemPrompt: "sys" });
    const b = await adapter.createSession({ cwd: "/worktrees/task-b", systemPrompt: "sys" });
    for (const session of [a.session, b.session, a.session]) {
      const stream = newStream();
      vi.mocked(streamViaCli).mockReturnValueOnce(stream);
      const pending = adapter.promptWithFallback(session, "turn");
      stream.push({ type: "done", reason: "stop", message: message() });
      await pending;
    }
    const cwds = vi.mocked(streamViaCli).mock.calls.map((call) => (call[2] as { cwd?: string }).cwd);
    expect(cwds).toEqual(["C:\\worktrees\\task-a", "/worktrees/task-b", "C:\\worktrees\\task-a"]);
    expect(cwds).not.toContain(process.cwd());
  });

  it("aborts the active turn when the session is disposed", async () => {
    const stream = newStream();
    vi.mocked(streamViaCli).mockReturnValue(stream);
    const adapter = new DroidRuntimeAdapter();
    const { session } = await adapter.createSession({ cwd: "/work/task", systemPrompt: "sys" });
    const pending = adapter.promptWithFallback(session, "hello");
    const signal = (vi.mocked(streamViaCli).mock.calls[0][2] as { signal?: AbortSignal }).signal;
    expect(signal?.aborted).toBe(false);
    session.dispose();
    expect(signal?.aborted).toBe(true);
    stream.push({ type: "done", reason: "stop", message: message() });
    await expect(pending).resolves.toBeUndefined();
  });
});
