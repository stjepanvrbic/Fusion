import type { Task, TaskStore } from "@fusion/core";
import { requestExternalBlockResume, type ExternalBlockLifecycleStore } from "@fusion/engine";
import { conflict, notFound } from "../api-error.js";

export type ResumeExternallyBlockedTaskResult =
  | { kind: "not-blocked" }
  | { kind: "resumed"; task: Task; nodeId: string };

/*
FNXC:ExternalBlockResume 2026-08-28-04:56:
Retry for an external block is a continuation publication, never a stage restart. It retains every
implementation artifact, keeps the durable pause raised until the successor continuation exists,
and refuses a duplicate request while that continuation is still pending so rapid operator clicks
cannot replay or discard the interrupted step.

FNXC:ExternalBlockResume 2026-10-08-08:29:
Operator Retry delegates to the engine's single resume owner. A frozen card holds no running-agent slot, so Retry records the request and
the card stays frozen until project admission grants its resumed run a slot; Retry also clears the automatic-resume budget.

FNXC:ExternalBlockResume 2026-10-08-12:10:
With a free running-agent slot the engine admits the Retry synchronously, so the card is unfrozen in the response; only a full cap leaves
it queued behind admission.
*/
export async function resumeExternallyBlockedTask(params: {
  store: TaskStore;
  taskId: string;
}): Promise<ResumeExternallyBlockedTaskResult> {
  const result = await requestExternalBlockResume({
    store: params.store as unknown as ExternalBlockLifecycleStore,
    taskId: params.taskId,
    trigger: "operator",
  });
  switch (result.kind) {
    case "not-found":
      throw notFound(`Task ${params.taskId} not found`);
    case "not-blocked":
      if (result.resumePending) throw conflict("External-block Retry has already resumed this task");
      return { kind: "not-blocked" };
    case "no-resume-node":
      throw conflict(`External-block Retry cannot resolve a workflow node for column ${result.column}`);
    case "already-requested":
      throw conflict("External-block Retry has already been requested; the task resumes when a running-agent slot is free");
    case "not-due":
      // Only an automatic trigger is ever not due; an operator request always proceeds.
      throw conflict("External-block Retry was not accepted");
    case "requested":
      return { kind: "resumed", task: result.task, nodeId: result.nodeId };
  }
}
