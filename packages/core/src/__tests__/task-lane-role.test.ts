import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskStore } from "../store.js";
import {
  TASK_LANE_ROLES,
  resolveTaskColumnHasLaneRole,
  taskColumnHasLaneRole,
  type TaskLaneRole,
  type TaskLaneRoleHost,
} from "../task-lane-role.js";
import { getTraitRegistry } from "../workflows/trait-registry.js";
import {
  __resetWorkflowExtensionRegistryForTests,
  getWorkflowExtensionRegistry,
} from "../workflows/workflow-extension-registry.js";
import { WORKFLOW_EXTENSION_SCHEMA_VERSION } from "../workflows/workflow-extension-types.js";

/*
FNXC:WorkflowLifecycleColumns 2026-10-12-08:27:
A plugin asks "does this column carry this lane role for this task" and the host answers. These cases pin the host's answer in each of its three states (traits declared, no trait anywhere, unreadable workflow) and the plugin-facing predicate's rule: return the host's answer, or the default-board answer when the host has no lookup.
*/

type Pair = readonly [columnId: string, role: TaskLaneRole];

/* A stored definition is validated when it is parsed from a string, so each board carries the one start and one end node a workflow needs. */
const graphAcross = (startColumn: string, endColumn: string) => ({
  nodes: [
    { id: "start", kind: "start", column: startColumn },
    { id: "end", kind: "end", column: endColumn },
  ],
  edges: [{ from: "start", to: "end", condition: "success" }],
});

const RENAMED = {
  version: "v2", id: "wf", name: "wf", ...graphAcross("backlog", "shipped"),
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }, { trait: "hold" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip" }] },
    { id: "verifying", name: "Verifying", traits: [{ trait: "wip" }] },
    { id: "signoff", name: "Sign-off", traits: [{ trait: "human-review" }] },
    { id: "merging", name: "Merging", traits: [{ trait: "merge" }] },
    { id: "in-progress", name: "Not a working lane", traits: [] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    { id: "vault", name: "Vault", traits: [{ trait: "archived" }] },
  ],
};

const V1_GRAPH = {
  version: "v1", name: "pure-v1",
  nodes: [
    { id: "start", kind: "start" },
    { id: "execute", kind: "prompt", config: { seam: "execute", prompt: "Do the work" } },
    { id: "end", kind: "end" },
  ],
  edges: [
    { from: "start", to: "execute", condition: "success" },
    { from: "execute", to: "end", condition: "success" },
    { from: "execute", to: "end", condition: "failure" },
  ],
};

const storeFor = (ir: unknown) => {
  const selection = { workflowId: "wf", stepIds: [] as string[] };
  return {
    getTaskWorkflowSelection: () => selection,
    getTaskWorkflowSelectionAsync: async () => selection,
    getWorkflowDefinition: async () => (ir === undefined ? undefined : { id: "wf", ir }),
  } as never;
};

const RENAMED_TRUE: Pair[] = [
  ["building", "wip"], ["verifying", "wip"], ["signoff", "review"], ["merging", "review"],
  ["shipped", "complete"], ["vault", "archived"], ["backlog", "intake"], ["backlog", "hold"],
];
const RENAMED_FALSE: Pair[] = [
  ["in-progress", "wip"], ["in-review", "review"], ["done", "complete"], ["archived", "archived"],
  ["todo", "hold"], ["no-such-column", "wip"], ["", "wip"],
];

describe("resolveTaskColumnHasLaneRole on a board that declares lifecycle traits", () => {
  it.each(RENAMED_TRUE)("answers true for %s / %s", async (columnId, role) => {
    expect(await resolveTaskColumnHasLaneRole(storeFor(RENAMED), "FN-1", columnId, role)).toBe(true);
  });

  it.each(RENAMED_FALSE)("answers false for '%s' / %s", async (columnId, role) => {
    expect(await resolveTaskColumnHasLaneRole(storeFor(RENAMED), "FN-1", columnId, role)).toBe(false);
  });

  it("gives the same answers when the definition is stored as a JSON string", async () => {
    const store = storeFor(JSON.stringify(RENAMED));
    for (const [columnId, role] of RENAMED_TRUE) {
      expect(await resolveTaskColumnHasLaneRole(store, "FN-1", columnId, role), `${columnId}/${role}`).toBe(true);
    }
    for (const [columnId, role] of RENAMED_FALSE) {
      expect(await resolveTaskColumnHasLaneRole(store, "FN-1", columnId, role), `${columnId}/${role}`).toBe(false);
    }
  });

  it("sees a lane whose role comes only from a plugin-contributed trait", async () => {
    const traitId = "lane-role-test-build-slot";
    const board = {
      version: "v2", id: "wf", name: "wf", ...graphAcross("assembly", "shipped"),
      columns: [
        { id: "assembly", name: "Assembly", traits: [{ trait: traitId }] },
        { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
      ],
    };
    getTraitRegistry().register({ id: traitId, name: "Build slot", flags: { countsTowardWip: true } });
    try {
      expect(await resolveTaskColumnHasLaneRole(storeFor(board), "FN-1", "assembly", "wip")).toBe(true);
      expect(await resolveTaskColumnHasLaneRole(storeFor(board), "FN-1", "shipped", "wip")).toBe(false);
    } finally {
      expect(getTraitRegistry().unregisterTrait(traitId)).toBe(true);
    }
  });
});

describe("resolveTaskColumnHasLaneRole when the workflow gives no lifecycle answer", () => {
  it.each<Pair>([
    ["in-progress", "wip"], ["in-review", "review"], ["done", "complete"], ["archived", "archived"],
    ["todo", "hold"], ["todo", "intake"], ["triage", "intake"],
  ])("answers true for %s / %s on a v1 graph", async (columnId, role) => {
    expect(await resolveTaskColumnHasLaneRole(storeFor(V1_GRAPH), "FN-1", columnId, role)).toBe(true);
  });

  it.each<Pair>([["building", "wip"], ["shipped", "complete"], ["vault", "archived"]])(
    "answers false for %s / %s on a v1 graph",
    async (columnId, role) => {
      expect(await resolveTaskColumnHasLaneRole(storeFor(V1_GRAPH), "FN-1", columnId, role)).toBe(false);
    },
  );

  it.each<Pair>([["in-progress", "wip"], ["in-review", "review"], ["done", "complete"], ["archived", "archived"]])(
    "answers true for %s / %s when the definition is missing",
    async (columnId, role) => {
      expect(await resolveTaskColumnHasLaneRole(storeFor(undefined), "FN-1", columnId, role)).toBe(true);
    },
  );

  it.each<Pair>([["building", "wip"], ["shipped", "complete"], ["vault", "archived"]])(
    "answers false for %s / %s when the definition is missing",
    async (columnId, role) => {
      expect(await resolveTaskColumnHasLaneRole(storeFor(undefined), "FN-1", columnId, role)).toBe(false);
    },
  );

  it("resolves with the default-board answer when both workflow reads throw", async () => {
    const store = {
      getTaskWorkflowSelection: () => { throw new Error("selection unreadable"); },
      getTaskWorkflowSelectionAsync: async () => { throw new Error("selection unreadable"); },
      getWorkflowDefinition: async () => { throw new Error("definition unreadable"); },
    } as never;

    await expect(resolveTaskColumnHasLaneRole(store, "FN-1", "in-progress", "wip")).resolves.toBe(true);
    await expect(resolveTaskColumnHasLaneRole(store, "FN-1", "building", "wip")).resolves.toBe(false);
  });

  it("answers for the default board when the task has no workflow selection", async () => {
    const store = {
      getTaskWorkflowSelection: () => undefined,
      getTaskWorkflowSelectionAsync: async () => undefined,
      getWorkflowDefinition: async () => undefined,
    } as never;

    expect(await resolveTaskColumnHasLaneRole(store, "FN-unknown", "in-progress", "wip")).toBe(true);
    expect(await resolveTaskColumnHasLaneRole(store, "FN-unknown", "building", "wip")).toBe(false);
  });
});

describe("an unknown lane role is a programming error", () => {
  it("rejects from the resolver with the offending value", async () => {
    await expect(
      resolveTaskColumnHasLaneRole(storeFor(RENAMED), "FN-1", "building", "working" as never),
    ).rejects.toThrow(/working/);
  });

  it("rejects from the predicate with the offending value, without asking the host", async () => {
    const host = { taskColumnHasLaneRole: vi.fn(async () => true) };
    await expect(taskColumnHasLaneRole(host, "FN-1", "building", "working" as never)).rejects.toThrow(/working/);
    expect(host.taskColumnHasLaneRole).not.toHaveBeenCalled();
  });
});

describe("taskColumnHasLaneRole asks the host", () => {
  it("passes the task, column and role through and returns the host's answer", async () => {
    const host = {
      taskColumnHasLaneRole: vi.fn(async (_taskId: string, columnId: string, role: TaskLaneRole) =>
        columnId === "building" && role === "wip"),
    };

    expect(await taskColumnHasLaneRole(host, "FN-7", "building", "wip")).toBe(true);
    expect(host.taskColumnHasLaneRole).toHaveBeenCalledTimes(1);
    expect(host.taskColumnHasLaneRole).toHaveBeenCalledWith("FN-7", "building", "wip");
  });

  it("does not override a host that says a default-board id does not carry the role", async () => {
    const host: TaskLaneRoleHost = { taskColumnHasLaneRole: async () => false };
    expect(await taskColumnHasLaneRole(host, "FN-7", "in-progress", "wip")).toBe(false);
  });

  it.each<Pair>([
    ["in-progress", "wip"], ["in-review", "review"], ["done", "complete"], ["archived", "archived"],
    ["todo", "hold"], ["triage", "intake"],
  ])("answers true for %s / %s when the host has no lookup", async (columnId, role) => {
    expect(await taskColumnHasLaneRole({}, "FN-7", columnId, role)).toBe(true);
  });

  it("answers false for a renamed lane when the host has no lookup", async () => {
    expect(await taskColumnHasLaneRole({}, "FN-7", "building", "wip")).toBe(false);
  });

  it("propagates a rejection from the host", async () => {
    const host: TaskLaneRoleHost = {
      taskColumnHasLaneRole: async () => { throw new Error("store offline"); },
    };
    await expect(taskColumnHasLaneRole(host, "FN-7", "in-progress", "wip")).rejects.toThrow("store offline");
  });
});

describe("TASK_LANE_ROLES", () => {
  it("lists the six lane roles", () => {
    expect([...TASK_LANE_ROLES]).toEqual(["intake", "hold", "wip", "review", "complete", "archived"]);
  });

  it("gives every role at least one default-board column", async () => {
    const defaultBoardColumns = ["triage", "todo", "in-progress", "in-review", "done", "archived"];
    for (const role of TASK_LANE_ROLES) {
      const answers = await Promise.all(defaultBoardColumns.map((columnId) => taskColumnHasLaneRole({}, "FN-7", columnId, role)));
      expect(answers.some(Boolean), role).toBe(true);
    }
  });
});

describe("TaskStore.taskColumnHasLaneRole", () => {
  it("answers from the task's real workflow", async () => {
    const store = storeFor(RENAMED);
    expect(await TaskStore.prototype.taskColumnHasLaneRole.call(store, "FN-1", "building", "wip")).toBe(true);
    expect(await TaskStore.prototype.taskColumnHasLaneRole.call(store, "FN-1", "in-progress", "wip")).toBe(false);
  });
});

describe("a move policy that decides by lane role", () => {
  afterEach(() => {
    __resetWorkflowExtensionRegistryForTests();
  });

  it("rejects a non-human move into a renamed complete lane and leaves other moves alone", async () => {
    const host: TaskLaneRoleHost = {
      taskColumnHasLaneRole: (taskId, columnId, role) =>
        TaskStore.prototype.taskColumnHasLaneRole.call(storeFor(RENAMED), taskId, columnId, role),
    };
    getWorkflowExtensionRegistry().register("lane-role-sample", {
      extensionId: "human-completes",
      name: "Only a human completes a card",
      kind: "move-policy",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "failClosed",
      evaluate: async ({ task, toColumn, actor }) => {
        const entersCompleteLane = await taskColumnHasLaneRole(host, task.id, toColumn, "complete");
        if (entersCompleteLane && actor?.kind !== "human") {
          return { allowed: false, reason: "human-required", message: `Only a human can move a card to '${toColumn}'` };
        }
        return { allowed: true };
      },
    });
    const evaluate = (toColumn: string, kind: "human" | "agent") =>
      TaskStore.prototype.evaluateWorkflowMovePolicies.call({} as never, {
        task: { id: "FN-1" } as never,
        workflow: RENAMED as never,
        fromColumn: "merging",
        toColumn,
        actor: { kind },
      });

    await expect(evaluate("shipped", "agent")).rejects.toThrow("Only a human can move a card to 'shipped'");
    await expect(evaluate("shipped", "human")).resolves.toBeUndefined();
    await expect(evaluate("done", "agent")).resolves.toBeUndefined();
  });
});
