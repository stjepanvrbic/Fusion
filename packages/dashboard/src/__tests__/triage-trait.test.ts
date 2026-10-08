/*
FNXC:LifecycleContainment 2026-10-08-05:43:
KB-045 requires automatic triage routing to name the engine source so lifecycle containment judges it, and requires an F1 refusal on a custom board to park the card in triage with a diagnostic instead of dropping it.
*/
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { TransitionRejectionError, makeTransitionRejection } from "@fusion/core";
import { runTriageOnEnter } from "../triage-trait.js";

function makeTask(id: string, title: string, sourceMetadata: Record<string, unknown> = {}): Task {
  return {
    id,
    title,
    description: title,
    column: "triage",
    source: { sourceType: "automation", sourceMetadata },
  } as unknown as Task;
}

function makeStore(overrides: Partial<Record<keyof TaskStore, unknown>> = {}) {
  const store = {
    updateTask: vi.fn(async () => undefined),
    moveTask: vi.fn(async () => undefined),
    createTask: vi.fn(async () => ({ id: "FN-follow-up" })),
    getPrEntity: vi.fn(async () => null),
    getActivePrEntityBySource: vi.fn(async () => null),
    ...overrides,
  };
  return store as typeof store & TaskStore;
}

describe("runTriageOnEnter move source", () => {
  it("routes a signal or issue forward to the ready lane as an engine move", async () => {
    const store = makeStore();
    const outcome = await runTriageOnEnter(makeTask("FN-1", "Crash on save", { signalSource: "sentry" }), { store });
    expect(outcome).toEqual({ kind: "passthrough", taskId: "FN-1", routedColumn: "todo" });
    expect(store.moveTask).toHaveBeenCalledWith("FN-1", "todo", { moveSource: "engine" });
  });

  it("routes a dependency-bump PR to review as an engine move", async () => {
    const store = makeStore();
    const task = makeTask("FN-2", "Bump lodash from 4.17.20 to 4.17.21", {
      triageItemKind: "pull_request",
      prInbound: true,
      prAuthor: "dependabot[bot]",
    });
    const outcome = await runTriageOnEnter(task, { store });
    expect(outcome).toEqual({ kind: "pr-review", taskId: "FN-2", routedColumn: "in-review" });
    expect(store.moveTask).toHaveBeenCalledWith("FN-2", "in-review", { moveSource: "engine" });
  });

  it("opens a follow-up for a feature PR and routes the PR to review as an engine move", async () => {
    const store = makeStore();
    const task = makeTask("FN-3", "Add dark mode support", { triageItemKind: "pull_request", prInbound: true });
    const outcome = await runTriageOnEnter(task, { store });
    expect(outcome).toEqual({ kind: "pr-follow-up", followUpTaskId: "FN-follow-up", routedColumn: "in-review" });
    expect(store.createTask).toHaveBeenCalledTimes(1);
    expect(store.moveTask).toHaveBeenCalledWith("FN-3", "in-review", { moveSource: "engine" });
  });

  it("parks the card in triage with a diagnostic when containment refuses the route", async () => {
    const rejection = makeTransitionRejection(
      "guard-rejected",
      "transition.rejected.forbiddenLifecyclePath",
      false,
      "F1: automatic moves may not target intake",
    );
    const store = makeStore({
      moveTask: vi.fn(async () => {
        throw new TransitionRejectionError(rejection, "Cannot move FN-4 to 'todo': Forbidden lifecycle path");
      }),
    });
    const outcome = await runTriageOnEnter(makeTask("FN-4", "Crash on load", { signalSource: "sentry" }), { store });
    expect(outcome.kind).toBe("parked");
    expect(store.moveTask).toHaveBeenCalledWith("FN-4", "todo", { moveSource: "engine" });
    expect(store.updateTask).toHaveBeenLastCalledWith(
      "FN-4",
      expect.objectContaining({
        sourceMetadataPatch: expect.objectContaining({
          triageError: expect.stringContaining("Forbidden lifecycle path"),
          triageErrorPhase: "passthrough",
        }),
      }),
    );
  });
});
