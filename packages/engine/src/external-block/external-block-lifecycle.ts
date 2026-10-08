/*
FNXC:ExternalBlock 2026-10-08-08:29:
One owner for the external-block (FN-209) lifecycle after a freeze: the park write with its automatic-resume schedule, the resume request
(operator Retry or automatic), the admitted clear, and the due-resume sweep.

A frozen card is not running and holds no running-agent slot; its retained checkout still counts toward maxWorktrees. A resume therefore
never makes the card live directly. It publishes a continuation behind the still-raised freeze and records a `resumeRequest`; the
continuation enters the project admission coordinator like any other lane, and only the admitted run clears the freeze, so a resumed card
waits for a slot instead of over-admitting.

A provider rate limit is transient: once the executor's bounded in-session retries are spent, the park schedules an automatic resume with
5, 15, 30, 60, 120, 120 minute backoff for at most six automatic resumes. Operator Retry works at any time and clears that budget.
Every other obstacle code keeps the freeze until an operator acts.
*/
import {
  EXTERNAL_BLOCK_AUTO_RESUME_BUDGET,
  TRANSIENT_EXTERNAL_BLOCK_CODES,
  buildTaskExternalBlockClearPatch,
  buildTaskExternalBlockPatch,
  computeWorkflowIrPin,
  isTaskExternallyBlocked,
  planExternalBlockAutoResume,
  resolveWorkflowIrForTask,
  type Task,
  type TaskExternalBlock,
  type TaskStore,
  type WorkflowWorkItem,
} from "@fusion/core";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import { generateSyntheticRunId } from "../util/run-audit.js";
import { resolveColumnResumeNode } from "../workflows/workflow-graph-executor.js";

/** Run-id segment that marks a continuation published by an external-block resume. */
export const EXTERNAL_BLOCK_RESUME_RUN_SEGMENT = ":external-block-resume:";

type RunContext = Parameters<TaskStore["logEntry"]>[3];
type TaskUpdates = Parameters<TaskStore["updateTask"]>[1];

export type ExternalBlockLifecycleStore = Pick<
  TaskStore,
  "getTask" | "updateTask" | "logEntry" | "withPlanningLifecycleLock" | "replaceActiveTaskWorkflowContinuation"
> & Partial<Pick<TaskStore, "recordRunAuditEvent" | "getTaskWorkflowSelectionAsync" | "getTaskWorkflowSelection" | "getWorkflowDefinition">> & {
  listWorkflowWorkItemsForTask(taskId: string): Promise<WorkflowWorkItem[]>;
};

/*
FNXC:ExternalBlockResume 2026-10-08-17:40:
A frozen card whose resume was just requested (operator Retry or a due automatic resume) must not wait for the next periodic drain tick:
the runtime kicks the continuation drain on the task update that records the request, so a free slot clears the card within about one
tick through the same admission every continuation uses.
*/
/** A freeze whose resume continuation is published and waiting for project admission. */
export function isQueuedExternalBlockResume(task: Pick<Task, "status" | "externalBlock">): boolean {
  return isTaskExternallyBlocked(task) && task.externalBlock?.resumeRequest !== undefined;
}

/** A continuation published by an external-block resume. */
export function isExternalBlockResumeWorkItem(item: Pick<WorkflowWorkItem, "kind" | "runId">): boolean {
  return item.kind === "task" && typeof item.runId === "string" && item.runId.includes(EXTERNAL_BLOCK_RESUME_RUN_SEGMENT);
}

function isPendingExternalBlockResume(item: WorkflowWorkItem): boolean {
  return isExternalBlockResumeWorkItem(item) && (item.state === "runnable" || item.state === "running" || item.state === "held");
}

function formatMinutes(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes % 60 === 0 && minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`;
}

/**
 * Writes an external-block freeze and, for a transient code, its automatic-resume schedule. Shared by the session-failure park and the
 * agent-declared park so both freeze the same way.
 */
export async function parkTaskOnExternalObstacle(input: {
  store: Pick<TaskStore, "updateTask" | "logEntry"> & Partial<Pick<TaskStore, "recordRunAuditEvent">>;
  task: Pick<Task, "id" | "column" | "externalBlockAutoResumeCount">;
  externalBlock: TaskExternalBlock;
  extraUpdates?: TaskUpdates;
  runContext?: RunContext;
  /** Run context for the patch write; the session-failure park writes without one. */
  writeRunContext?: RunContext;
  logMessage: string;
  nowMs?: number;
  /**
   * FNXC:ProviderRateLimitDeferral 2026-10-08-16:05:
   * Run-audit attribution for the freeze rows. Defaults to `executor`; KB-077 review and merge freezes pass `reviewer` / `merger`.
   */
  agentId?: string;
}): Promise<void> {
  const { store, task } = input;
  const agentId = input.agentId ?? "executor";
  const nowMs = input.nowMs ?? Date.now();
  const plan = planExternalBlockAutoResume(input.externalBlock, task.externalBlockAutoResumeCount, nowMs);
  const externalBlock: TaskExternalBlock = plan
    ? { ...input.externalBlock, autoResume: { attempt: plan.attempt, budget: plan.budget, resumeAt: plan.resumeAt } }
    : input.externalBlock;
  await store.updateTask(
    task.id,
    { ...buildTaskExternalBlockPatch(externalBlock), ...(input.extraUpdates ?? {}) } as TaskUpdates,
    input.writeRunContext,
  );
  await store.logEntry(task.id, input.logMessage, undefined, input.runContext);
  await emitBoundedRunAudit(store, {
    taskId: task.id,
    agentId,
    runId: generateSyntheticRunId("external-block", task.id),
    domain: "database",
    mutationType: "task:external-block-parked",
    target: task.id,
    metadata: {
      taskId: task.id,
      origin: externalBlock.origin,
      code: externalBlock.code,
      source: externalBlock.source,
      column: task.column,
      resumeNodeId: externalBlock.resume.nodeId,
    },
  });
  if (!TRANSIENT_EXTERNAL_BLOCK_CODES.has(externalBlock.code)) return;
  const spent = Math.max(0, Math.floor(task.externalBlockAutoResumeCount ?? 0));
  await store.logEntry(
    task.id,
    plan
      ? `Automatic resume ${plan.attempt}/${plan.budget} scheduled in ${formatMinutes(plan.delayMs)} (${externalBlock.origin}/${externalBlock.code}); Retry resumes now`
      : `Automatic resume budget spent (${EXTERNAL_BLOCK_AUTO_RESUME_BUDGET}/${EXTERNAL_BLOCK_AUTO_RESUME_BUDGET}); waiting for operator Retry`,
    undefined,
    input.runContext,
  );
  await emitBoundedRunAudit(store, {
    taskId: task.id,
    agentId,
    runId: generateSyntheticRunId("external-block-auto-resume", task.id),
    domain: "database",
    mutationType: "task:external-block-auto-resume-scheduled",
    target: task.id,
    metadata: {
      taskId: task.id,
      code: externalBlock.code,
      attempt: plan?.attempt ?? spent,
      budget: EXTERNAL_BLOCK_AUTO_RESUME_BUDGET,
      delayMs: plan?.delayMs ?? null,
      outcome: plan ? "scheduled" : "budget-exhausted",
    },
  });
}

export type ExternalBlockResumeTrigger = "operator" | "automatic";

export type ExternalBlockResumeRequestResult =
  | { kind: "not-found" }
  | { kind: "not-blocked"; resumePending: boolean }
  | { kind: "no-resume-node"; column: string }
  | { kind: "not-due" }
  | { kind: "already-requested"; task: Task }
  | { kind: "requested"; task: Task; nodeId: string };

/*
FNXC:ExternalBlockResume 2026-08-28-04:56:
Retry for an external block is a continuation publication, never a stage restart. It retains every implementation artifact, keeps the
durable pause raised until the successor continuation exists, and refuses a duplicate request while that continuation is still pending
so rapid operator clicks cannot replay or discard the interrupted step.

FNXC:ExternalBlockResume 2026-10-08-08:29:
The freeze now stays raised until project admission grants the resumed run a slot (`clearExternalBlockForAdmittedResume`); the request
only publishes the continuation and records `resumeRequest`. Operator Retry clears the automatic-resume budget and takes over a pending
automatic request; an automatic request is refused unless its scheduled time has passed.
*/
export async function requestExternalBlockResume(input: {
  store: ExternalBlockLifecycleStore;
  taskId: string;
  trigger: ExternalBlockResumeTrigger;
  nowMs?: number;
  agentId?: string;
}): Promise<ExternalBlockResumeRequestResult> {
  const { store, taskId, trigger } = input;
  const nowMs = input.nowMs ?? Date.now();
  return store.withPlanningLifecycleLock(taskId, async () => {
    const task = await store.getTask(taskId);
    if (!task) return { kind: "not-found" } as const;
    const existingItems = await store.listWorkflowWorkItemsForTask(taskId);
    if (!isTaskExternallyBlocked(task) || !task.externalBlock) {
      return { kind: "not-blocked", resumePending: existingItems.some(isPendingExternalBlockResume) } as const;
    }
    const externalBlock = task.externalBlock;

    if (externalBlock.resumeRequest) {
      if (trigger === "automatic" || externalBlock.resumeRequest.trigger === "operator") {
        return { kind: "already-requested", task } as const;
      }
      // Operator Retry takes over a pending automatic resume and clears the automatic budget.
      await store.updateTask(taskId, {
        externalBlock: { ...externalBlock, autoResume: undefined, resumeRequest: { requestedAt: new Date(nowMs).toISOString(), trigger } },
        externalBlockAutoResumeCount: 0,
      });
      await store.logEntry(taskId, "External block Retry took over the pending automatic resume; automatic-resume budget cleared");
      const updated = await store.getTask(taskId);
      return { kind: "requested", task: updated, nodeId: pendingResumeNodeId(existingItems) ?? externalBlock.resume.nodeId ?? "" } as const;
    }

    const spent = Math.max(0, Math.floor(task.externalBlockAutoResumeCount ?? 0));
    if (trigger === "automatic") {
      const scheduled = externalBlock.autoResume;
      if (!scheduled || Date.parse(scheduled.resumeAt) > nowMs || spent >= EXTERNAL_BLOCK_AUTO_RESUME_BUDGET) {
        return { kind: "not-due" } as const;
      }
    }

    const ir = await resolveWorkflowIrForTask(store as never, task.id);
    const resumeNode = externalBlock.resume.nodeId
      ? ir.nodes.find((node) => node.id === externalBlock.resume.nodeId)
      : resolveColumnResumeNode(ir, externalBlock.resume.column);
    if (!resumeNode) return { kind: "no-resume-node", column: externalBlock.resume.column } as const;

    const continuationSequence = existingItems.length;
    // Publish the successor behind the still-intact external-block fence; admission clears the fence later.
    await store.replaceActiveTaskWorkflowContinuation({
      taskId,
      nodeId: resumeNode.id,
      kind: "task",
      state: "runnable",
      waitReason: null,
      blockedReason: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      retryAfter: null,
      sourceColumn: task.column,
      targetColumn: task.column,
      continuationSequence,
      stableWorkflowRunId: `${taskId}:${ir.name}`,
      runId: `${taskId}${EXTERNAL_BLOCK_RESUME_RUN_SEGMENT}${resumeNode.id}:${continuationSequence}`,
      irHash: computeWorkflowIrPin(ir, resumeNode.id).irHash,
    });

    const attempt = spent + 1;
    await store.updateTask(taskId, {
      externalBlock: { ...externalBlock, autoResume: undefined, resumeRequest: { requestedAt: new Date(nowMs).toISOString(), trigger } },
      externalBlockAutoResumeCount: trigger === "operator" ? 0 : attempt,
    });
    await store.logEntry(
      taskId,
      trigger === "operator"
        ? `External block Retry requested; resuming workflow at ${resumeNode.id} when a running-agent slot is free`
        : `External block automatic resume ${attempt}/${EXTERNAL_BLOCK_AUTO_RESUME_BUDGET} requested; resuming workflow at ${resumeNode.id} when a running-agent slot is free`,
    );
    if (trigger === "automatic") {
      await emitBoundedRunAudit(store, {
        taskId,
        agentId: input.agentId ?? "scheduler",
        runId: generateSyntheticRunId("external-block-auto-resume", taskId),
        domain: "database",
        mutationType: "task:external-block-auto-resume-executed",
        target: taskId,
        metadata: {
          taskId,
          origin: externalBlock.origin,
          code: externalBlock.code,
          attempt,
          budget: EXTERNAL_BLOCK_AUTO_RESUME_BUDGET,
          column: task.column,
          resumeNodeId: resumeNode.id,
        },
      });
    }
    const updated = await store.getTask(taskId);
    return { kind: "requested", task: updated, nodeId: resumeNode.id } as const;
  });
}

function pendingResumeNodeId(items: readonly WorkflowWorkItem[]): string | undefined {
  return [...items].reverse().find(isPendingExternalBlockResume)?.nodeId;
}

/**
 * Clears the freeze for a resume the admission coordinator has just granted a slot, right before the resumed run starts. Returns the
 * task to run, or null when the freeze has no pending resume request (the run must not start).
 */
export async function clearExternalBlockForAdmittedResume(input: {
  store: Pick<TaskStore, "getTask" | "updateTask" | "logEntry" | "withPlanningLifecycleLock"> & Partial<Pick<TaskStore, "recordRunAuditEvent">>;
  taskId: string;
  nodeId: string;
}): Promise<Task | null> {
  const { store, taskId, nodeId } = input;
  return store.withPlanningLifecycleLock(taskId, async () => {
    const task = await store.getTask(taskId);
    if (!task) return null;
    if (!isTaskExternallyBlocked(task) || !task.externalBlock) return task;
    const externalBlock = task.externalBlock;
    const request = externalBlock.resumeRequest;
    if (!request) return null;
    await store.updateTask(taskId, buildTaskExternalBlockClearPatch());
    await store.logEntry(
      taskId,
      `External block cleared by ${request.trigger === "operator" ? "operator Retry" : "automatic resume"}; resuming workflow at ${nodeId}`,
    );
    await emitBoundedRunAudit(store, {
      taskId,
      agentId: "engine",
      runId: generateSyntheticRunId("external-block-resume", taskId),
      domain: "database",
      mutationType: "task:external-block-cleared",
      target: taskId,
      metadata: {
        taskId,
        origin: externalBlock.origin,
        code: externalBlock.code,
        source: externalBlock.source,
        column: task.column,
        resumeNodeId: nodeId,
        trigger: request.trigger,
      },
    });
    return await store.getTask(taskId);
  });
}

/**
 * Requests every automatic resume whose scheduled time has passed. `tasks` may be slim rows: candidates are re-read in full under the
 * planning lifecycle lock before any write. Returns the task ids whose resume was requested.
 */
export async function resumeDueExternalBlocks(input: {
  store: ExternalBlockLifecycleStore;
  tasks: readonly Pick<Task, "id" | "status">[];
  nowMs?: number;
}): Promise<string[]> {
  const nowMs = input.nowMs ?? Date.now();
  const requested: string[] = [];
  for (const candidate of input.tasks) {
    if (candidate.status !== "blocked") continue;
    const task = await input.store.getTask(candidate.id).catch(() => undefined);
    const scheduled = task?.externalBlock?.autoResume;
    if (!task || !isTaskExternallyBlocked(task) || !scheduled || task.externalBlock?.resumeRequest) continue;
    if (Date.parse(scheduled.resumeAt) > nowMs) continue;
    const result = await requestExternalBlockResume({ store: input.store, taskId: task.id, trigger: "automatic", nowMs });
    if (result.kind === "requested") requested.push(task.id);
  }
  return requested;
}
