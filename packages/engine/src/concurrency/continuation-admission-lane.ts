import {
  REVIEW_ROLES,
  classifyWorkflowAgentNode,
  resolveColumnFlags,
  resolveWorkflowIrForTask,
  type WorkflowIr,
  type WorkflowIrColumn,
  type WorkflowIrNode,
  type WorkflowIrNodeKind,
  type WorkflowIrResolverStore,
  type WorkflowSelectionCache,
} from "@fusion/core";

import type { AdmissionLane } from "./concurrency.js";

/** Graph node kinds that only ever run merge or pull-request delivery work. */
const MERGE_DELIVERY_NODE_KINDS: ReadonlySet<WorkflowIrNodeKind> = new Set<WorkflowIrNodeKind>([
  "merge-gate",
  "merge-attempt",
  "manual-merge-hold",
  "branch-group-member-integration",
  "branch-group-promotion",
  "pr-create",
  "pr-respond",
  "pr-merge",
]);

interface LocatedNode {
  node: WorkflowIrNode;
  /** The node's own column, else the nearest container's column. */
  column: string | undefined;
  /** Containers from outermost to innermost. */
  ancestors: WorkflowIrNode[];
}

function templateNodesOf(node: WorkflowIrNode): WorkflowIrNode[] | undefined {
  return (node.config as { template?: { nodes?: WorkflowIrNode[] } } | undefined)?.template?.nodes;
}

/**
 * Find a work item's node anywhere in the graph. Accepts a bare id, an optional-group instance
 * (`<group>::<node>`), and a foreach instance (`<foreach>#<index>:<node>`); template nodes inherit
 * the column of the container they run inside.
 */
function locateNode(
  nodes: readonly WorkflowIrNode[],
  nodeId: string,
  inheritedColumn: string | undefined,
  ancestors: WorkflowIrNode[],
): LocatedNode | undefined {
  const direct = nodes.find((node) => node.id === nodeId);
  if (direct) return { node: direct, column: direct.column ?? inheritedColumn, ancestors };
  for (const container of nodes) {
    const templateNodes = templateNodesOf(container);
    if (!templateNodes) continue;
    let innerId = nodeId;
    const optionalPrefix = `${container.id}::`;
    const iterationPrefix = `${container.id}#`;
    if (nodeId.startsWith(optionalPrefix)) {
      innerId = nodeId.slice(optionalPrefix.length);
    } else if (nodeId.startsWith(iterationPrefix)) {
      const separator = nodeId.indexOf(":", iterationPrefix.length);
      if (separator > 0) innerId = nodeId.slice(separator + 1);
    }
    const nested = locateNode(templateNodes, innerId, container.column ?? inheritedColumn, [...ancestors, container]);
    if (nested) return nested;
  }
  return undefined;
}

function columnLane(column: WorkflowIrColumn | undefined): AdmissionLane | undefined {
  if (!column) return undefined;
  const flags = resolveColumnFlags(column);
  if (flags.intake === true || flags.hold === true) return "planning";
  if (flags.complete === true || REVIEW_ROLES.some((role) => flags[role] === true)) return "review";
  return undefined;
}

/*
FNXC:ConcurrencyAdmission 2026-10-08-06:59:
Every resumed `kind:"task"` continuation enters project capacity in the lane its node's lifecycle role owns, so a freed slot finishes review and post-merge work before any new executor starts (FN-8705 lane priority).
Hard-coding "execute" for every continuation let a post-merge verification, browser verification, or merge resume lose a freed slot to an older hold-release executor; the review lane filled and nothing landed.
Classification is by role, never by node id, because custom workflows rename nodes and columns:
1. The node's column (its own, or its container's) decides first: an intake or hold column is planning; a review-role column (merge orchestration, merge blocker, human review) or the complete column is review.
2. Otherwise the node decides: a plan-kind review is planning; an optional-group (a pre- or post-merge gate) is review; a reviewer or merger principal seam is review; a triage seam is planning; merge and pull-request delivery kinds are review.
3. Anything else, including an unknown node or no workflow, keeps the execute lane, which is the pre-fix behaviour.
*/
/**
 * The admission lane for a workflow continuation parked at `nodeId`. Pure: the provider and the
 * drain's own one-shot admission both call this so they can never disagree about priority.
 */
export function resolveContinuationAdmissionLane(ir: WorkflowIr | undefined, nodeId: string): AdmissionLane {
  if (!ir) return "execute";
  const located = locateNode(ir.nodes, nodeId, undefined, []);
  if (!located) return "execute";
  const columns: WorkflowIrColumn[] = ir.version === "v2" ? ir.columns : [];
  const byColumn = columnLane(columns.find((column) => column.id === located.column));
  if (byColumn) return byColumn;
  const chain = [...located.ancestors, located.node];
  if (chain.some((node) => node.config?.reviewKind === "plan")) return "planning";
  if (chain.some((node) => node.kind === "optional-group")) return "review";
  for (const node of [...chain].reverse()) {
    const role = classifyWorkflowAgentNode(node);
    if (role === "reviewer" || role === "merger") return "review";
    if (role === "triage") return "planning";
    if (MERGE_DELIVERY_NODE_KINDS.has(node.kind)) return "review";
  }
  return "execute";
}

/**
 * Store-aware form: resolve the task's own workflow, then classify. A failed resolution keeps the
 * execute lane rather than blocking admission.
 */
export async function resolveContinuationAdmissionLaneForTask(
  store: WorkflowIrResolverStore,
  taskId: string,
  nodeId: string,
  irCache?: Map<string, WorkflowIr>,
  selectionCache?: WorkflowSelectionCache,
): Promise<AdmissionLane> {
  try {
    return resolveContinuationAdmissionLane(await resolveWorkflowIrForTask(store, taskId, irCache, selectionCache), nodeId);
  } catch {
    return "execute";
  }
}
