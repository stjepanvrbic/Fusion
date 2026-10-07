/**
 * FNXC:AgentRowConcurrency 2026-10-07-21:40:
 * Two AgentStore instances on one database stand in for the dashboard engine and a CLI process. Store A is held right after
 * its agent read; store B commits an operator change in that window. A's write must keep B's change, re-run when both
 * changed the same field, and never resurrect an agent B deleted.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { AgentStore } from "../../agents/agent-store.js";

/** Hold the first `getAgent` resolution of `store` until `release()` is called. */
function holdAfterNextRead(store: AgentStore): { reached: Promise<void>; release: () => void; restore: () => void } {
  let signalReached!: () => void;
  const reached = new Promise<void>((resolve) => { signalReached = resolve; });
  let releaseRead!: () => void;
  const released = new Promise<void>((resolve) => { releaseRead = resolve; });
  const original = store.getAgent.bind(store);
  let held = false;
  (store as unknown as { getAgent: AgentStore["getAgent"] }).getAgent = async (agentId: string) => {
    const agent = await original(agentId);
    if (!held) {
      held = true;
      signalReached();
      await released;
    }
    return agent;
  };
  return {
    reached,
    release: () => releaseRead(),
    restore: () => { delete (store as unknown as { getAgent?: unknown }).getAgent; },
  };
}

pgDescribe("AgentStore writers preserve concurrent writers' fields (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_agent_concurrent",
    projectId: "proj_agent_concurrent",
  });
  let storeA: AgentStore;
  let storeB: AgentStore;

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    storeA = new AgentStore({ rootDir: h.rootDir(), asyncLayer: h.layer() });
    storeB = new AgentStore({ rootDir: h.rootDir(), asyncLayer: h.layer() });
    await storeA.init();
    await storeB.init();
  });
  afterEach(async () => {
    for (const store of [storeA, storeB]) {
      try { store.close(); } catch { /* best-effort */ }
    }
    await h.afterEach();
  });
  afterAll(h.afterAll);

  async function interleave(writerA: () => Promise<unknown>, writerB: () => Promise<unknown>): Promise<unknown> {
    const hold = holdAfterNextRead(storeA);
    try {
      const pendingA = writerA().then((value) => ({ value }), (error: unknown) => ({ error }));
      await hold.reached;
      await writerB();
      hold.release();
      return await pendingA;
    } finally {
      hold.release();
      hold.restore();
    }
  }

  const fresh = async (agentId: string) => {
    const reader = new AgentStore({ rootDir: h.rootDir(), asyncLayer: h.layer() });
    return reader.getAgent(agentId);
  };

  it("a heartbeat keeps a pause and a runtime toggle committed by another store", async () => {
    const agent = await storeA.createAgent({ name: "heartbeat-target", role: "executor", runtimeConfig: { enabled: true } });
    await storeA.updateAgentState(agent.id, "active");

    await interleave(
      () => storeA.recordHeartbeat(agent.id, "ok", "run-a"),
      async () => {
        await storeB.updateAgentState(agent.id, "paused");
        await storeB.updateAgent(agent.id, { runtimeConfig: { enabled: false } });
      },
    );

    const after = await fresh(agent.id);
    expect(after?.state).toBe("paused");
    expect(after?.runtimeConfig?.enabled).toBe(false);
    expect(after?.lastHeartbeatAt).toBeTruthy();
  });

  it("updateAgent keeps a state change committed by another store", async () => {
    const agent = await storeA.createAgent({ name: "edit-target", role: "executor" });
    await storeA.updateAgentState(agent.id, "active");

    await interleave(
      () => storeA.updateAgent(agent.id, { title: "title from A" }),
      () => storeB.updateAgentState(agent.id, "paused"),
    );

    const after = await fresh(agent.id);
    expect(after?.title).toBe("title from A");
    expect(after?.state).toBe("paused");
  });

  it("updateAgentState keeps a configuration edit and re-runs against a concurrent state change", async () => {
    const agent = await storeA.createAgent({ name: "state-target", role: "executor" });
    await storeA.updateAgentState(agent.id, "active");

    await interleave(
      () => storeA.updateAgentState(agent.id, "idle"),
      async () => {
        await storeB.updateAgent(agent.id, { title: "title from B", runtimeConfig: { enabled: false } });
        await storeB.updateAgentState(agent.id, "paused");
      },
    );

    const after = await fresh(agent.id);
    expect(after?.title).toBe("title from B");
    expect(after?.runtimeConfig?.enabled).toBe(false);
    // A re-ran from the operator's paused state, so paused -> idle is the serial outcome.
    expect(after?.state).toBe("idle");
  });

  it("resetBudgetUsage and a runtime toggle on different runtimeConfig keys both persist", async () => {
    const agent = await storeA.createAgent({ name: "budget-target", role: "executor", runtimeConfig: { enabled: true } });

    await interleave(
      () => storeA.resetBudgetUsage(agent.id),
      () => storeB.updateAgent(agent.id, { runtimeConfig: { enabled: false } }),
    );

    const after = await fresh(agent.id);
    expect(after?.runtimeConfig?.enabled).toBe(false);
    expect(typeof after?.runtimeConfig?.budgetResetAt).toBe("string");
  });

  it("syncExecutionTaskLink keeps another store's pause", async () => {
    const agent = await storeA.createAgent({ name: "link-target", role: "executor" });
    await storeA.updateAgentState(agent.id, "active");

    await interleave(
      () => storeA.syncExecutionTaskLink(agent.id, "FN-1"),
      () => storeB.updateAgentState(agent.id, "paused"),
    );

    const after = await fresh(agent.id);
    expect(after?.state).toBe("paused");
  });

  it("a mutation never resurrects an agent another store deleted", async () => {
    const agent = await storeA.createAgent({ name: "delete-target", role: "executor" });

    const outcome = await interleave(
      () => storeA.updateAgent(agent.id, { title: "late edit" }),
      () => storeB.deleteAgent(agent.id),
    ) as { error?: unknown };

    expect(outcome.error).toBeInstanceOf(Error);
    expect(await fresh(agent.id)).toBeNull();
  });
});
