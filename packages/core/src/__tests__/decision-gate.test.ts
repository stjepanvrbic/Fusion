import { describe, expect, it } from "vitest";

import { findOpenDecisionGateStep } from "../tasks/decision-gate.js";
import type { TaskStep } from "../types.js";

const step = (status: TaskStep["status"], extra: Partial<TaskStep> = {}): TaskStep => ({ name: "Step", status, ...extra });
const gate = (status: TaskStep["status"], extra: Partial<TaskStep> = {}): TaskStep => step(status, { decisionGate: true, ...extra });

describe("findOpenDecisionGateStep", () => {
  it.each([
    ["an undefined step list", undefined],
    ["an empty step list", []],
    ["a plan without a gate", [step("done"), step("in-progress"), step("pending")]],
    ["a finished gate", [step("done"), gate("done"), step("in-progress")]],
    ["a skipped gate", [step("done"), gate("skipped"), step("pending")]],
    ["a pending gate behind an in-progress step", [step("in-progress"), gate("pending")]],
    ["a pending gate behind a pending step", [step("done"), step("pending"), gate("pending")]],
    ["a pending gate whose declared dependency is unfinished", [step("done"), step("in-progress"), gate("pending", { dependsOn: [1] })]],
  ])("finds no open gate in %s", (_label, steps) => {
    expect(findOpenDecisionGateStep(steps as TaskStep[] | undefined)).toBeUndefined();
  });

  it("opens a gate that is in progress", () => {
    expect(findOpenDecisionGateStep([step("done"), gate("in-progress"), step("pending")])).toBe(1);
  });

  it("opens an in-progress gate even when an earlier step is unfinished", () => {
    expect(findOpenDecisionGateStep([step("pending"), gate("in-progress")])).toBe(1);
  });

  it("opens a pending gate once every earlier step is done or skipped", () => {
    expect(findOpenDecisionGateStep([step("done"), step("skipped"), gate("pending"), step("pending")])).toBe(2);
  });

  it("opens a pending first-step gate", () => {
    expect(findOpenDecisionGateStep([gate("pending"), step("pending")])).toBe(0);
  });

  it("uses declared dependencies instead of document order", () => {
    const steps = [step("done"), step("in-progress"), gate("pending", { dependsOn: [0] })];

    expect(findOpenDecisionGateStep(steps)).toBe(2);
  });

  it("treats an explicit empty dependency list as a ready root", () => {
    expect(findOpenDecisionGateStep([step("in-progress"), gate("pending", { dependsOn: [] })])).toBe(1);
  });

  it("returns the lowest open gate when two are open", () => {
    const steps = [step("done"), gate("pending", { dependsOn: [0] }), gate("in-progress")];

    expect(findOpenDecisionGateStep(steps)).toBe(1);
  });

  it("skips a finished gate and returns the next open one", () => {
    expect(findOpenDecisionGateStep([gate("done"), step("done"), gate("pending")])).toBe(2);
  });

  it("ignores a truthy attribute that is not the stored marker value", () => {
    const steps = [step("in-progress", { decisionGate: "yes" as unknown as true })];

    expect(findOpenDecisionGateStep(steps)).toBeUndefined();
  });
});
