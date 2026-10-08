import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { AgentStore } from "../agents/agent-store.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";

/*
FNXC:AgentHeartbeat 2026-10-08-02:00:
KB-015: updateAgentStateIfCurrent is the compare-and-set the heartbeat skip
restore relies on. A mismatch must never write or emit, so a concurrent pause wins.
*/
pgDescribe("AgentStore.updateAgentStateIfCurrent (KB-015)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_conditional_state",
    projectId: "proj_conditional_state",
  });
  let agentStore: AgentStore;

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => {
    await h.beforeEach();
    agentStore = new AgentStore({ rootDir: h.rootDir(), asyncLayer: h.layer(), taskStore: h.store() });
    await agentStore.init();
  });
  afterEach(async () => {
    try { agentStore?.close(); } catch { /* best-effort */ }
    await h.afterEach();
  });

  it("writes the new state when the current state matches", async () => {
    const agent = await agentStore.createAgent({ name: "Running Agent", role: "engineer" });
    await agentStore.updateAgentState(agent.id, "active");
    await agentStore.updateAgentState(agent.id, "running");

    const updated = await agentStore.updateAgentStateIfCurrent(agent.id, "running", "active");

    expect(updated?.state).toBe("active");
    await expect(agentStore.getAgent(agent.id)).resolves.toMatchObject({ state: "active" });
  });

  it("returns null without writing or emitting when the state differs", async () => {
    const agent = await agentStore.createAgent({ name: "Paused Agent", role: "engineer" });
    await agentStore.updateAgentState(agent.id, "active");
    await agentStore.updateAgent(agent.id, { pauseReason: "user-requested" });
    await agentStore.updateAgentState(agent.id, "paused");

    const stateChanges: unknown[][] = [];
    agentStore.on("agent:stateChanged", (...args: unknown[]) => { stateChanges.push(args); });

    const result = await agentStore.updateAgentStateIfCurrent(agent.id, "running", "active");

    expect(result).toBeNull();
    expect(stateChanges).toEqual([]);
    await expect(agentStore.getAgent(agent.id)).resolves.toMatchObject({
      state: "paused",
      pauseReason: "user-requested",
    });
  });

  it("returns null for a missing agent", async () => {
    await expect(agentStore.updateAgentStateIfCurrent("agent-missing", "running", "active")).resolves.toBeNull();
  });

  it("throws the same invalid-transition error as updateAgentState when the state matches", async () => {
    const agent = await agentStore.createAgent({ name: "Paused Agent", role: "engineer" });
    await agentStore.updateAgentState(agent.id, "active");
    await agentStore.updateAgentState(agent.id, "paused");

    await expect(agentStore.updateAgentStateIfCurrent(agent.id, "paused", "running"))
      .rejects.toThrow("Invalid state transition: paused -> running");
    await expect(agentStore.updateAgentState(agent.id, "running"))
      .rejects.toThrow("Invalid state transition: paused -> running");
    await expect(agentStore.getAgent(agent.id)).resolves.toMatchObject({ state: "paused" });
  });
});
