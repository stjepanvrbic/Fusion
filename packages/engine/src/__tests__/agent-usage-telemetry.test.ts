import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { AgentLogger } from "../agents/agent-logger.js";
import { AGENT_SESSION_USAGE_CATEGORY, attachAgentUsageTelemetry, emitAgentSessionStart } from "../agents/agent-usage-telemetry.js";

/**
 * FNXC:CommandCenterActivity 2026-08-09-11:12:
 * Durable lanes attach telemetry after resolving their model, so this seam must update identity
 * without making tool callbacks or session boundaries depend on telemetry persistence.
 */
describe("agent usage telemetry", () => {
  it("attaches and refreshes tool identity without requiring a task log", async () => {
    const emitUsageEvent = vi.fn().mockResolvedValue(undefined);
    const logger = new AgentLogger({ appendLog: vi.fn().mockResolvedValue(undefined) });
    const store = { emitUsageEvent } as unknown as TaskStore;
    attachAgentUsageTelemetry(logger, { store, agentId: "durable-agent", taskId: null, nodeId: "node-1", model: "first", provider: "provider-a", lane: "heartbeat" });
    logger.onToolStart("Bash", { command: "secret command" });
    attachAgentUsageTelemetry(logger, { store, agentId: "durable-agent", taskId: null, nodeId: "node-1", model: "resolved", provider: "provider-b", lane: "heartbeat" });
    logger.onToolEnd("Bash", false, "secret result");
    await Promise.resolve();

    expect(emitUsageEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: "tool_call", taskId: null, agentId: "durable-agent", nodeId: "node-1", model: "first", provider: "provider-a" }));
    expect(emitUsageEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: "tool_result", taskId: null, agentId: "durable-agent", model: "resolved", provider: "provider-b" }));
  });

  it("emits content-free agent session boundaries fail-soft", async () => {
    const emitUsageEvent = vi.fn().mockRejectedValue(new Error("offline"));
    const store = { emitUsageEvent } as unknown as TaskStore;
    expect(() => emitAgentSessionStart({ store, agentId: "reviewer", taskId: "FN-8868", nodeId: null, model: "validator", provider: "test", lane: "reviewer", ephemeral: false, runId: "run-1" }, null)).not.toThrow();
    expect(emitUsageEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "session_start", category: AGENT_SESSION_USAGE_CATEGORY, meta: { lane: "reviewer", ephemeral: false, runId: "run-1" } }));
    expect(() => attachAgentUsageTelemetry(null, { store, lane: "reviewer" })).not.toThrow();
  });

  it("makes the lane logger's flush wait for its session boundary write", async () => {
    let settle!: (value: boolean) => void;
    const emitUsageEvent = vi.fn(() => new Promise<boolean>((resolve) => { settle = resolve; }));
    const store = { emitUsageEvent } as unknown as TaskStore;
    const logger = new AgentLogger({ appendLog: vi.fn().mockResolvedValue(undefined) });
    emitAgentSessionStart({ store, agentId: "durable-agent", taskId: null, lane: "heartbeat" }, logger);

    let flushed = false;
    const flushing = logger.flush().then(() => { flushed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(flushed).toBe(false);

    settle(true);
    await flushing;
    expect(flushed).toBe(true);
  });

  it("keeps a logger-tracked session boundary fail-soft and its payload unchanged", async () => {
    const emitUsageEvent = vi.fn().mockRejectedValue(new Error("offline"));
    const store = { emitUsageEvent } as unknown as TaskStore;
    const logger = new AgentLogger({ appendLog: vi.fn().mockResolvedValue(undefined) });
    expect(() => emitAgentSessionStart({ store, agentId: "merger", taskId: "FN-1", nodeId: "node-1", model: "m", provider: "p", lane: "merger", runId: "run-2" }, logger)).not.toThrow();
    await expect(logger.flush()).resolves.toBeUndefined();
    expect(emitUsageEvent).toHaveBeenCalledWith({ kind: "session_start", taskId: "FN-1", agentId: "merger", nodeId: "node-1", model: "m", provider: "p", category: AGENT_SESSION_USAGE_CATEGORY, meta: { lane: "merger", runId: "run-2" } });
  });

  it("emits a detached boundary without a logger even when the store throws synchronously", () => {
    const emitUsageEvent = vi.fn(() => { throw new Error("no sink"); });
    const store = { emitUsageEvent } as unknown as TaskStore;
    expect(() => emitAgentSessionStart({ store, lane: "reviewer" }, undefined)).not.toThrow();
    expect(emitUsageEvent).toHaveBeenCalledTimes(1);
  });
});
