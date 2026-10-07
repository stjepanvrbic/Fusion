/**
 * FNXC:CodeOrganization 2026-08-03-13:50:
 * blockOuterDispatchWhenEphemeralDisabled peeled from TaskExecutor (U4).
 *
 * FNXC:EphemeralAgents 2026-07-01-00:00:
 * `ephemeralAgentsEnabled: false` means "never spawn short-lived executor-FN-XXXX workers; only permanent agents run work" (see types.ts ephemeralAgentsEnabled). The legacy spawn refusal lives in EphemeralWorkerManager.onTaskStart (ephemeral-worker-manager.ts), but that runs as a fire-and-forget bookkeeping callback AFTER execution has already begun, so it cannot stop a run. The workflow-engine dispatch paths (executeWorkflowGraph, maybeDispatchWorkflowWorkEngine) execute tasks in-process without ever consulting the toggle. Any task that reaches execute() without a permanent assignment via a non-scheduler path (resume-after-restart, heartbeat re-entry, mission/autopilot, work-engine claim) therefore ran despite the operator disabling ephemeral agents.
 *
 * This guard is the executor's last line of defense, mirroring the scheduler cutover gate and the spawn refusal. It runs once at the top of the outer dispatch — before all three workflow paths — so a single check covers every workflow dispatch entry point. A task explicitly assigned to a permanent (non-ephemeral) agent is exactly how ephemeral-off mode is meant to run, so those are allowed through; everything else is re-queued for the scheduler to auto-assign a permanent agent or hold.
 */
import type { Task, TaskStore, AgentStore } from "@fusion/core";
import { isEphemeralAgent } from "@fusion/core";
import type { EngineRunContext } from "../util/run-audit.js";
import { executorLog } from "../logger.js";
import { clearDispatchBlockedLogState, logDispatchBlockedOnce } from "./dispatch-block-log.js";

export type BlockOuterDispatchWhenEphemeralDisabledDeps = {
  store: TaskStore;
  agentStore?: AgentStore | null;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
};

export async function blockOuterDispatchWhenEphemeralDisabled(
  deps: BlockOuterDispatchWhenEphemeralDisabledDeps,
  task: Task,
): Promise<boolean> {
    const settings = await deps.store.getSettings();
    if (settings.ephemeralAgentsEnabled !== false) {
      clearDispatchBlockedLogState(task.id);
      return false;
    }

    // A permanent (non-ephemeral) assignment is the sanctioned executor when
    // ephemeral workers are off. `assignedAgentId` is only ever set by permanent
    // assignment — default ephemeral mode never sets it — so when we cannot
    // resolve the agent (no agentStore) we trust the presence of the id and allow
    // the run rather than starving a legitimately-assigned task.
    const assignedId = task.assignedAgentId?.trim();
    if (assignedId) {
      if (!deps.agentStore) {
        clearDispatchBlockedLogState(task.id);
        return false;
      }
      const agent = await deps.agentStore.getAgent(assignedId).catch(() => null);
      if (agent && !isEphemeralAgent(agent)) {
        clearDispatchBlockedLogState(task.id);
        return false;
      }
    }

    const liveTask = (await deps.store.getTask(task.id).catch(() => null)) ?? task;
    /*
    FNXC:LifecycleContainment 2026-10-07-18:04:
    The dispatch block is an in-place hold. The former WIP-to-hold move used the same-role-only
    `self-healing-session-recovery` reason, which the FN-207 direction policy rejects, so the throw
    skipped the queued write and left the card unexplained. Assigning a permanent agent or enabling
    ephemeral workers updates the card, and the WIP resume path re-dispatches it from this lane.
    */
    await deps.store.updateTask(liveTask.id, { status: "queued" }, deps.getRunContextFor(liveTask.id));
    await deps.store.logEntry(
      liveTask.id,
      "queued — ephemeral agents disabled; no permanent executor assigned",
      "Executor pre-dispatch ephemeral gate blocked workflow/authoritative execution.",
      deps.getRunContextFor(liveTask.id),
    );
    logDispatchBlockedOnce(
      executorLog,
      liveTask.id,
      "ephemeral-disabled",
      `${liveTask.id}: executor dispatch blocked — ephemeralAgentsEnabled=false and no permanent agent assigned`,
    );
    return true;
}
