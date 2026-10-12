/*
FNXC:WorkflowLifecycleColumns 2026-10-12-08:27:
A plugin must be able to ask what a column is for, so a lane guard keeps working on a board whose columns were renamed. The question is "does this column carry this lane role for this task", and the Fusion host answers it.

The host computes the answer because trait resolution reads the trait registry, and a plugin's copy of core has its own registry that holds the built-in traits only. A lane whose role comes from a plugin-contributed trait is visible in the host's registry and nowhere else.

The answer has three states:
  the task's workflow declares lifecycle traits: the answer is what the workflow declares, alone. A legacy id the board keeps as an ordinary column does not carry the role.
  the workflow resolved and declares no trait on any column (a v1 graph upgraded with untraited default columns): the legacy ids.
  the workflow could not be read: the legacy ids.

`review` is the broad set, every lane where review happens (merge orchestration, merge blocker, human review). Use it to observe a card. It is too wide for deciding where to move one.

A role can be carried by several columns, so the answer is membership and never "the first column with the role".

The lookup keeps no cache. Each call reads the task's workflow selection and its definition, so the next call sees a workflow edit or a selection change.
*/

import "./builtin-traits.js";
import { LEGACY_COLUMN_IDS_BY_ROLE, REVIEW_ROLES } from "./project-lane-vocabulary.js";
import type { TraitFlags } from "./workflows/trait-types.js";
import { resolveWorkflowIrForTask, type WorkflowIrResolverStore } from "./workflows/workflow-ir-resolver.js";
import { columnsWithFlag, declaresAnyLifecycleTrait, type LifecycleColumns } from "./workflows/workflow-lifecycle-traits.js";

/** The lane roles a plugin can ask about. They are the keys of `LifecycleColumns`. */
export const TASK_LANE_ROLES = ["intake", "hold", "wip", "review", "complete", "archived"] as const satisfies ReadonlyArray<keyof LifecycleColumns>;

export type TaskLaneRole = (typeof TASK_LANE_ROLES)[number];

type LaneRoleTraitFlags = ReadonlyArray<keyof TraitFlags & string>;

/*
The trait flags that carry each role. The annotation and the `satisfies` clause together make the compiler reject a role that `LifecycleColumns` lacks and a `LifecycleColumns` key that has no role here.
*/
const TRAIT_FLAGS_BY_LANE_ROLE: Record<TaskLaneRole, LaneRoleTraitFlags> = {
  intake: ["intake"],
  hold: ["hold"],
  wip: ["countsTowardWip"],
  review: REVIEW_ROLES,
  complete: ["complete"],
  archived: ["archived"],
} satisfies Record<keyof LifecycleColumns, LaneRoleTraitFlags>;

/** The host object a plugin holds. `PluginContext.taskStore` satisfies it. */
export interface TaskLaneRoleHost {
  /** Absent on a Fusion host older than this lookup and on a plain fake in a plugin's unit test. */
  taskColumnHasLaneRole?(taskId: string, columnId: string, role: TaskLaneRole): Promise<boolean>;
}

function assertTaskLaneRole(role: unknown): asserts role is TaskLaneRole {
  if (!(TASK_LANE_ROLES as readonly unknown[]).includes(role)) {
    throw new Error(`Unknown lane role '${String(role)}'. Expected one of: ${TASK_LANE_ROLES.join(", ")}.`);
  }
}

function legacyColumnCarriesRole(columnId: string, role: TaskLaneRole): boolean {
  return TRAIT_FLAGS_BY_LANE_ROLE[role].some((flag) => (LEGACY_COLUMN_IDS_BY_ROLE[flag] ?? []).includes(columnId));
}

/**
 * Host-side answer to "does `columnId` carry `role` for this task". It must run in the host process, against the host's trait registry.
 *
 * Rejects only for an unknown `role`. An unreadable workflow yields the legacy-id answer.
 */
export async function resolveTaskColumnHasLaneRole(
  store: WorkflowIrResolverStore,
  taskId: string,
  columnId: string,
  role: TaskLaneRole,
): Promise<boolean> {
  assertTaskLaneRole(role);
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId);
    if (ir && declaresAnyLifecycleTrait(ir)) {
      return TRAIT_FLAGS_BY_LANE_ROLE[role].some((flag) => columnsWithFlag(ir, flag).includes(columnId));
    }
  } catch {
    /* An unreadable workflow is the third state and gets the legacy-id answer below. */
  }
  return legacyColumnCarriesRole(columnId, role);
}

/**
 * Plugin-facing predicate. It asks the host and returns the host's answer. A rejection from the host propagates.
 *
 * A host without the lookup yields the legacy-id answer, which is correct for the default board. This function never resolves traits itself.
 */
export async function taskColumnHasLaneRole(
  host: TaskLaneRoleHost,
  taskId: string,
  columnId: string,
  role: TaskLaneRole,
): Promise<boolean> {
  assertTaskLaneRole(role);
  if (typeof host.taskColumnHasLaneRole !== "function") return legacyColumnCarriesRole(columnId, role);
  return host.taskColumnHasLaneRole(taskId, columnId, role);
}
