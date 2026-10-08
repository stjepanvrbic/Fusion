// @vitest-environment node
//
// U4: the default-workflow side effects are resolved THROUGH the trait registry
// (the DI seam, KTD-2/U2). This pins:
//   - registerDefaultWorkflowHooks() wires the impls so resolution finds them
//     (no missing-hook-impl warning on the happy path);
//   - a missing registration degrades to a no-op + audit warning (not a crash);
//   - applyDefaultWorkflowMoveEffects mutates the task per the legacy contract.

import { describe, it, expect, beforeEach } from "vitest";
import {
  __resetTraitRegistryForTests,
  getTraitRegistry,
} from "../workflows/trait-registry.js";
import { registerBuiltinTraits } from "../workflows/builtin-traits.js";
import {
  __resetDefaultWorkflowHooksForTests,
  applyDefaultWorkflowMoveEffects,
  holdsOperatorPause,
  registerDefaultWorkflowHooks,
  type DefaultWorkflowMoveContext,
} from "../workflows/default-workflow-hooks.js";
import type { Task } from "../types.js";

function makeCtx(overrides: Partial<DefaultWorkflowMoveContext> = {}): DefaultWorkflowMoveContext {
  const task = {
    id: "FN-1",
    column: "in-progress",
    columnMovedAt: new Date().toISOString(),
    steps: [],
    dependencies: [],
  } as unknown as Task;
  return {
    task,
    fromColumn: "todo",
    toColumn: "in-progress",
    moveSource: "user",
    bypassGuards: false,
    movedAt: new Date().toISOString(),
    settings: undefined,
    options: {},
    resetSteps: () => {},
    ...overrides,
  };
}

describe("default-workflow-hooks registry wiring", () => {
  beforeEach(() => {
    __resetTraitRegistryForTests();
    __resetDefaultWorkflowHooksForTests();
    registerBuiltinTraits();
  });

  it("resolves all default-workflow hooks without a missing-impl warning once registered", () => {
    registerDefaultWorkflowHooks();
    const ctx = makeCtx({ fromColumn: "todo", toColumn: "in-progress" });
    const { warnings } = applyDefaultWorkflowMoveEffects(ctx);
    expect(warnings).toHaveLength(0);
    // timing.onEnter stamped cumulativeActiveMs on entry to in-progress.
    expect(ctx.task.cumulativeActiveMs).toBe(0);
  });

  it("degrades to a no-op + audit warning when a hook impl is not registered", () => {
    // Built-in DEFINITIONS are registered (so the trait declares the hook) but
    // we deliberately do NOT call registerDefaultWorkflowHooks() — no impls.
    const registry = getTraitRegistry();
    // sanity: the trait declares the hook descriptor
    expect(registry.getTrait("timing")?.hooks?.onEnter).toBe(true);
    const ctx = makeCtx({ fromColumn: "todo", toColumn: "in-progress" });
    const { warnings } = applyDefaultWorkflowMoveEffects(ctx);
    // Every declared hook with no impl yields a degraded-no-op warning.
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.every((w) => w.kind === "missing-hook-impl")).toBe(true);
    // No crash; task unmutated by the (no-op) hooks.
    expect(ctx.task.cumulativeActiveMs).toBeUndefined();
  });

  it("applies userPaused only for user-source reopen to todo", () => {
    registerDefaultWorkflowHooks();
    const userCtx = makeCtx({ fromColumn: "in-progress", toColumn: "todo", moveSource: "user" });
    applyDefaultWorkflowMoveEffects(userCtx);
    expect(userCtx.task.userPaused).toBe(true);

    const engineCtx = makeCtx({ fromColumn: "in-progress", toColumn: "todo", moveSource: "engine" });
    applyDefaultWorkflowMoveEffects(engineCtx);
    expect(engineCtx.task.userPaused).toBeUndefined();
  });

  // FN-7851 pause-bounce regression: the executor's pause teardown re-queues a
  // user-paused in-progress task to todo. Without preservePause the reopen
  // block wiped the pause flags, leaving the row dispatchable — the scheduler
  // re-dispatched it seconds after the user paused it.
  it("preservePause keeps the pause park across an engine reopen to todo", () => {
    registerDefaultWorkflowHooks();
    const ctx = makeCtx({ fromColumn: "in-progress", toColumn: "todo", moveSource: "engine", options: { preservePause: true } });
    ctx.task.paused = true;
    ctx.task.pausedByAgentId = "agent-1";
    ctx.task.pausedReason = "operator pause";
    ctx.task.userPaused = true;
    applyDefaultWorkflowMoveEffects(ctx);
    expect(ctx.task.paused).toBe(true);
    expect(ctx.task.pausedByAgentId).toBe("agent-1");
    expect(ctx.task.pausedReason).toBe("operator pause");
    expect(ctx.task.userPaused).toBe(true);
  });

  /*
  FNXC:SelfHealing 2026-08-21-16:06:
  FN-9186 writes the no-progress backoff immediately before its engine wip-to-todo
  rebound. Only review-origin moves clear this display mirror, so this pins the
  move-hook contract that keeps the scheduler from immediately redispatching it.
  */
  it("preserves no-progress recovery backoff on an engine wip-to-rebound move", () => {
    registerDefaultWorkflowHooks();
    const ctx = makeCtx({ fromColumn: "in-progress", toColumn: "todo", moveSource: "engine", options: { recoveryRehome: true } });
    ctx.task.recoveryRetryCount = 1;
    ctx.task.nextRecoveryAt = "2026-08-21T16:07:00.000Z";

    applyDefaultWorkflowMoveEffects(ctx);

    expect(ctx.task.recoveryRetryCount).toBe(1);
    expect(ctx.task.nextRecoveryAt).toBe("2026-08-21T16:07:00.000Z");
  });

  it("preservePause never SETS a pause on an unpaused reopen, and default reopen still clears an engine-owned park", () => {
    registerDefaultWorkflowHooks();
    // preservePause on an unpaused task: nothing appears.
    const unpausedCtx = makeCtx({ fromColumn: "in-progress", toColumn: "todo", moveSource: "engine", options: { preservePause: true } });
    applyDefaultWorkflowMoveEffects(unpausedCtx);
    expect(unpausedCtx.task.paused).toBeUndefined();
    expect(unpausedCtx.task.userPaused).toBeUndefined();

    // Default (no preservePause) engine reopen still clears an ENGINE-owned park
    // (agent + reason, no userPaused); KB-013 leaves engine-park semantics unchanged.
    const defaultCtx = makeCtx({ fromColumn: "in-progress", toColumn: "todo", moveSource: "engine" });
    defaultCtx.task.paused = true;
    defaultCtx.task.pausedByAgentId = "agent-1";
    defaultCtx.task.pausedReason = "awaiting-approval";
    applyDefaultWorkflowMoveEffects(defaultCtx);
    expect(defaultCtx.task.paused).toBeUndefined();
    expect(defaultCtx.task.pausedByAgentId).toBeUndefined();
    expect(defaultCtx.task.pausedReason).toBeUndefined();

    // The operator-pause shape on the same engine reopen is preserved (KB-013).
    const operatorCtx = makeCtx({ fromColumn: "in-progress", toColumn: "todo", moveSource: "engine" });
    operatorCtx.task.paused = true;
    operatorCtx.task.userPaused = true;
    applyDefaultWorkflowMoveEffects(operatorCtx);
    expect(operatorCtx.task.paused).toBe(true);
    expect(operatorCtx.task.userPaused).toBe(true);
  });
});

/*
KB-013: a non-user move never clears an operator pause; only a user move or an
explicit unpause does. Engine-owned parks keep their reopen-clears semantics.
*/
describe("operator pause survives non-user moves (KB-013)", () => {
  beforeEach(() => {
    __resetTraitRegistryForTests();
    __resetDefaultWorkflowHooksForTests();
    registerBuiltinTraits();
    registerDefaultWorkflowHooks();
  });

  type PauseState = Partial<Pick<Task, "paused" | "userPaused" | "pausedReason" | "pausedByAgentId">>;

  function run(
    state: PauseState,
    overrides: Partial<DefaultWorkflowMoveContext>,
  ): Task {
    const ctx = makeCtx(overrides);
    Object.assign(ctx.task, state, { status: "failed", error: "boom" });
    applyDefaultWorkflowMoveEffects(ctx);
    return ctx.task;
  }

  const NON_USER_SOURCES = ["engine", "scheduler"] as const;
  const REOPENS = [
    ["in-progress", "todo"],
    ["in-review", "todo"],
    ["done", "todo"],
    ["in-progress", "triage"],
    ["in-review", "triage"],
    ["done", "triage"],
  ] as const;

  for (const source of NON_USER_SOURCES) {
    for (const [from, to] of REOPENS) {
      it(`${source} ${from} -> ${to} keeps an operator pause and still clears status/error`, () => {
        const task = run(
          { paused: true, userPaused: true },
          { fromColumn: from, toColumn: to, moveSource: source },
        );
        expect(task.paused).toBe(true);
        expect(task.userPaused).toBe(true);
        expect(task.pausedReason).toBeUndefined();
        expect(task.pausedByAgentId).toBeUndefined();
        expect(task.status).toBeUndefined();
        expect(task.error).toBeUndefined();
        // The scheduler's parked predicate stays true.
        expect(Boolean(task.paused || task.userPaused)).toBe(true);
      });
    }
  }

  it("keeps a userPaused-only (hold-lane drag) park on an engine reopen", () => {
    const task = run({ userPaused: true }, { fromColumn: "in-review", toColumn: "todo", moveSource: "engine" });
    expect(task.userPaused).toBe(true);
    expect(task.paused).toBeUndefined();
  });

  it("keeps the legacy bare pause (paused, no reason, no agent) on an engine reopen", () => {
    const task = run({ paused: true }, { fromColumn: "in-progress", toColumn: "triage", moveSource: "engine" });
    expect(task.paused).toBe(true);
  });

  it("keeps an operator pause carrying an engine reason, including the reason", () => {
    const task = run(
      { paused: true, userPaused: true, pausedReason: "in-review-stall-deadlock" },
      { fromColumn: "in-review", toColumn: "todo", moveSource: "engine" },
    );
    expect(task.paused).toBe(true);
    expect(task.userPaused).toBe(true);
    expect(task.pausedReason).toBe("in-review-stall-deadlock");
  });

  it("still clears an engine-owned park on an engine reopen, and keeps it with preservePause", () => {
    const cleared = run(
      { paused: true, pausedReason: "branch-conflict-unrecoverable" },
      { fromColumn: "in-review", toColumn: "todo", moveSource: "engine" },
    );
    expect(cleared.paused).toBeUndefined();
    expect(cleared.pausedReason).toBeUndefined();

    const kept = run(
      { paused: true, pausedReason: "branch-conflict-unrecoverable" },
      { fromColumn: "in-review", toColumn: "todo", moveSource: "engine", options: { preservePause: true } },
    );
    expect(kept.paused).toBe(true);
    expect(kept.pausedReason).toBe("branch-conflict-unrecoverable");
  });

  it("still clears an agent approval park on an engine reopen", () => {
    const task = run(
      { paused: true, pausedByAgentId: "agent-7", pausedReason: "awaiting-approval" },
      { fromColumn: "in-progress", toColumn: "todo", moveSource: "engine" },
    );
    expect(task.paused).toBeUndefined();
    expect(task.pausedByAgentId).toBeUndefined();
    expect(task.pausedReason).toBeUndefined();
  });

  it("never sets a pause on an unpaused engine reopen", () => {
    const task = run({}, { fromColumn: "in-progress", toColumn: "todo", moveSource: "engine" });
    expect(task.paused).toBeUndefined();
    expect(task.userPaused).toBeUndefined();
  });

  it("a user reopen to hold re-parks; a user reopen to intake clears all four fields", () => {
    const held = run(
      { paused: true, userPaused: true, pausedByAgentId: "agent-1", pausedReason: "x" },
      { fromColumn: "in-progress", toColumn: "todo", moveSource: "user" },
    );
    expect(held.userPaused).toBe(true);
    expect(held.paused).toBeUndefined();
    expect(held.pausedByAgentId).toBeUndefined();
    expect(held.pausedReason).toBeUndefined();

    const intake = run(
      { paused: true, userPaused: true, pausedByAgentId: "agent-1", pausedReason: "x" },
      { fromColumn: "in-progress", toColumn: "triage", moveSource: "user" },
    );
    expect(intake.userPaused).toBeUndefined();
    expect(intake.paused).toBeUndefined();
    expect(intake.pausedByAgentId).toBeUndefined();
    expect(intake.pausedReason).toBeUndefined();
  });

  it("WIP entry keeps userPaused for non-user sources and clears it for a user move", () => {
    for (const source of NON_USER_SOURCES) {
      for (const from of ["todo", "in-review"]) {
        const task = run({ userPaused: true }, { fromColumn: from, toColumn: "in-progress", moveSource: source });
        expect(task.userPaused).toBe(true);
      }
    }
    for (const from of ["todo", "in-review"]) {
      const task = run({ userPaused: true }, { fromColumn: from, toColumn: "in-progress", moveSource: "user" });
      expect(task.userPaused).toBeUndefined();
    }
  });

  it("holdsOperatorPause classifies the pause shapes", () => {
    expect(holdsOperatorPause({ userPaused: true })).toBe(true);
    expect(holdsOperatorPause({ paused: true })).toBe(true);
    expect(holdsOperatorPause({ paused: true, userPaused: true, pausedReason: "r" })).toBe(true);
    expect(holdsOperatorPause({ paused: true, pausedReason: "r" })).toBe(false);
    expect(holdsOperatorPause({ paused: true, pausedByAgentId: "a" })).toBe(false);
    expect(holdsOperatorPause({})).toBe(false);
  });
});

/*
FNXC:WorkflowReviewGates 2026-07-26-14:40:
The pre-merge review gates (Code Review, Browser Verification) run with the card in `in-review`, so
the graph's crossing into the paired remediation node is a routine `in-review -> in-progress` move
that lands immediately after the gate wrote its `failed` result. The reopen clear used to wipe
`workflowStepResults` on every such move, destroying the remediation input — and, worse, making
`getTaskMergeBlocker`'s pending/failed branches vacuously false so a card could return to
`in-review` and be mergeable with its gate never re-run.

These cases pin BOTH directions of the gate, because a fix that simply stopped clearing on
`in-progress` would silently change operator-reopen semantics that other recovery paths depend on
(`executor.performWorkflowRerunBounce` documents that `moveTask(in-review -> todo)` clears results
for it). Only a graph-owned in-review -> in-progress crossing is exempt.
*/
describe("applyReopenFieldClears — graph-owned review-gate remediation crossing", () => {
  beforeEach(() => {
    __resetTraitRegistryForTests();
    __resetDefaultWorkflowHooksForTests();
    registerBuiltinTraits();
    registerDefaultWorkflowHooks();
  });

  function withResults(overrides: Partial<DefaultWorkflowMoveContext>): DefaultWorkflowMoveContext {
    const ctx = makeCtx(overrides);
    ctx.task.workflowStepResults = [
      { workflowStepId: "code-review", workflowStepName: "Code Review", status: "failed", phase: "pre-merge" },
      { workflowStepId: "browser-verification", workflowStepName: "Browser Verification", status: "passed", phase: "pre-merge" },
    ] as Task["workflowStepResults"];
    return ctx;
  }

  it("RETAINS workflowStepResults on the graph's in-review -> in-progress remediation crossing", () => {
    const ctx = withResults({
      fromColumn: "in-review",
      toColumn: "in-progress",
      moveSource: "engine",
      workflowMoveSource: "workflow-graph",
      options: { preserveProgress: true },
    });
    applyDefaultWorkflowMoveEffects(ctx);
    expect(ctx.task.workflowStepResults).toHaveLength(2);
    expect(ctx.task.workflowStepResults?.find((r) => r.workflowStepId === "code-review")?.status).toBe("failed");
  });

  it("retains only review evidence for remediation-owned review -> planning bounce", () => {
    const ctx = withResults({
      fromColumn: "in-review",
      toColumn: "todo",
      moveSource: "engine",
      workflowMoveSource: "workflow-remediation",
    });
    ctx.task.branch = "fusion/FN-1";
    applyDefaultWorkflowMoveEffects(ctx);
    expect(ctx.task.workflowStepResults).toHaveLength(2);
    expect(ctx.task.branch).toBeUndefined();
  });

  it("still CLEARS on an operator reopen in-review -> in-progress (no graph provenance)", () => {
    const ctx = withResults({
      fromColumn: "in-review",
      toColumn: "in-progress",
      moveSource: "user",
    });
    applyDefaultWorkflowMoveEffects(ctx);
    expect(ctx.task.workflowStepResults).toBeUndefined();
  });

  it("still CLEARS on in-review -> todo even when the graph owns the move (bounce invariant)", () => {
    const ctx = withResults({
      fromColumn: "in-review",
      toColumn: "todo",
      moveSource: "engine",
      workflowMoveSource: "workflow-graph",
      options: { preserveProgress: true },
    });
    applyDefaultWorkflowMoveEffects(ctx);
    expect(ctx.task.workflowStepResults).toBeUndefined();
  });

  it("still CLEARS on done -> todo reopen", () => {
    const ctx = withResults({ fromColumn: "done", toColumn: "todo", moveSource: "user" });
    applyDefaultWorkflowMoveEffects(ctx);
    expect(ctx.task.workflowStepResults).toBeUndefined();
  });
});
