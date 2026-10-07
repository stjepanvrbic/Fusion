/*
FNXC:RunAudit 2026-10-07-21:40:
Run-audit metadata is ids, counts and fixed outcomes only. The plugin trait-hook degradation emitter copied the registry
warning text and a hook's raw thrown-error message, which can carry credential-bearing URLs or task content, into the
durable audit row. Both branches must record only the trait id, hook kind and a fixed classification.
*/
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../task-store/async/async-persistence.js", () => ({
  readTaskRow: vi.fn(async () => undefined),
}));
vi.mock("../task-store/async/async-transition-pending.js", () => ({
  writeTransitionPendingAsync: vi.fn(async () => undefined),
}));

import { runPluginColumnTransitionHooksImpl } from "../task-store/audit-ops.js";
import { getTraitRegistry } from "../workflows/trait-registry.js";

const SECRET = "postgresql://operator:hunter2-SENTINEL@db.internal/fusion";
const TRAIT_ID = "plugin:fn-audit-prose";

function ownerRecording(events: Array<{ mutationType: string; metadata?: Record<string, unknown> }>) {
  return {
    asyncLayer: { db: {} },
    rowToTask: (value: unknown) => value,
    pgRowToTaskRow: (value: unknown) => value,
    recordRunAuditEvent: vi.fn(async (event: { mutationType: string; metadata?: Record<string, unknown> }) => { events.push(event); }),
  };
}

const ir = {
  version: 1, nodes: [], edges: [],
  columns: [{ id: "todo", name: "Todo", traits: [{ trait: TRAIT_ID }] }],
};

describe("plugin trait-hook degradation audit metadata", () => {
  const registry = getTraitRegistry();
  try { registry.register({ id: TRAIT_ID, name: "audit prose", flags: {}, hooks: { onEnter: true } } as never); } catch { /* singleton may retain the trait */ }

  afterEach(() => { registry.deregisterTraitHookImpl(TRAIT_ID, "onEnter"); });

  it("records a missing implementation as a fixed reason without the warning text", async () => {
    const events: Array<{ mutationType: string; metadata?: Record<string, unknown> }> = [];
    await runPluginColumnTransitionHooksImpl(ownerRecording(events) as never, "FN-1", ir as never, "other", "todo");

    const degraded = events.find((event) => event.mutationType === "plugin:trait-hook-degraded");
    expect(degraded?.metadata).toEqual({ traitId: TRAIT_ID, hookKind: "onEnter", reason: "no-impl" });
  });

  it("records a throwing hook as a fixed reason and failure class without the error message", async () => {
    class HookCrashError extends Error {}
    HookCrashError.prototype.name = "HookCrashError";
    registry.registerTraitHookImpl(TRAIT_ID, "onEnter", () => { throw new HookCrashError(`could not reach ${SECRET}`); });
    const events: Array<{ mutationType: string; metadata?: Record<string, unknown> }> = [];

    await runPluginColumnTransitionHooksImpl(ownerRecording(events) as never, "FN-1", ir as never, "other", "todo");

    const degraded = events.find((event) => event.mutationType === "plugin:trait-hook-degraded");
    expect(degraded?.metadata).toEqual({ traitId: TRAIT_ID, hookKind: "onEnter", reason: "threw", failureClass: "HookCrashError" });
    expect(JSON.stringify(events)).not.toContain("SENTINEL");
  });

  it("collapses an arbitrary error name to a fixed class", async () => {
    registry.registerTraitHookImpl(TRAIT_ID, "onEnter", () => {
      throw Object.assign(new Error("boom"), { name: `leak ${SECRET}` });
    });
    const events: Array<{ mutationType: string; metadata?: Record<string, unknown> }> = [];

    await runPluginColumnTransitionHooksImpl(ownerRecording(events) as never, "FN-1", ir as never, "other", "todo");

    expect(events.find((event) => event.mutationType === "plugin:trait-hook-degraded")?.metadata?.failureClass).toBe("Error");
    expect(JSON.stringify(events)).not.toContain("SENTINEL");
  });
});
