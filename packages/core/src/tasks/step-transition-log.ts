import type { StepStatus } from "../types.js";

/*
FNXC:TaskHistory 2026-10-12-00:50:
A step status transition is recorded in the task log as one engine-formatted action line.
Readers that need "a step really changed status" (execution-activity evidence, step timing) must recognize exactly that line and nothing that merely mentions a step, so the format and its recognizer live together next to the only writer.
The step name is free text and may contain parentheses or the arrow, so the recognizer anchors on the last `) → <status>` in the line.
*/
const STEP_TRANSITION_ACTION = /^Step (\d+) \(([\s\S]*)\) → (pending|in-progress|done|skipped)$/;

export interface StepTransitionLogAction {
  stepIndex: number;
  stepName: string;
  status: StepStatus;
}

/** Builds the task-log action recorded for a step status transition. */
export function formatStepTransitionLogAction(stepIndex: number, stepName: string, status: StepStatus): string {
  return `Step ${stepIndex} (${stepName}) → ${status}`;
}

/** Returns the transition a task-log action records, or `null` when the action is anything else. */
export function parseStepTransitionLogAction(action: string): StepTransitionLogAction | null {
  const match = STEP_TRANSITION_ACTION.exec(action);
  if (!match) return null;
  return { stepIndex: Number.parseInt(match[1], 10), stepName: match[2], status: match[3] as StepStatus };
}
