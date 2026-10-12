import type { TaskStep } from "../types.js";

/*
FNXC:DecisionGate 2026-10-12-06:16:
An executor may declare a decision wait only while a plan-marked decision-gate step is open.
Open means the gate is the work in front of the executor: it is in progress, or it is pending and every predecessor is done or skipped.
Predecessors are the step's `dependsOn` when that is an array (an empty array is a ready root), otherwise every lower index, the same rule the store applies before a step may start.
A finished gate, or one still behind unfinished work, does not authorize a park, so the exit cannot be used to leave repairable work in an earlier or later step.
*/
export function findOpenDecisionGateStep(
  steps: readonly Pick<TaskStep, "status" | "dependsOn" | "decisionGate">[] | undefined,
): number | undefined {
  if (!steps) return undefined;
  const isFinished = (index: number): boolean => {
    const status = steps[index]?.status;
    return status === "done" || status === "skipped";
  };
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!;
    if (step.decisionGate !== true) continue;
    if (step.status === "in-progress") return index;
    if (step.status !== "pending") continue;
    const predecessors = Array.isArray(step.dependsOn)
      ? step.dependsOn
      : Array.from({ length: index }, (_, lower) => lower);
    if (predecessors.every(isFinished)) return index;
  }
  return undefined;
}
