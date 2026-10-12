import { describe, expect, it, vi } from "vitest";
import {
  PLUGIN_DESTRUCTIVE_TASK_STORE_METHODS,
  createPluginGatedTaskStore,
} from "../plugin-task-store-gate.js";
import { TaskStore } from "../store.js";
import { taskColumnHasLaneRole } from "../task-lane-role.js";

/*
FNXC:PluginTaskStoreGate 2026-07-26-12:20:
Plugins must not be able to delete/bypass/bulk-archive tasks unless their manifest
declares permissions.destructiveTaskOps. These tests exercise the gate through a
fake plugin-context store: denylisted call without declaration throws, with
declaration passes through, and non-destructive methods are unaffected.
*/

function makeFakeStore() {
  return {
    deleteTask: vi.fn().mockResolvedValue({ id: "FN-1" }),
    deleteTaskIf: vi.fn().mockResolvedValue({ id: "FN-1" }),
    deleteTaskById: vi.fn().mockResolvedValue(undefined),
    deleteTaskBackend: vi.fn().mockResolvedValue(undefined),
    bypassFailedPreMergeReviewStep: vi.fn().mockResolvedValue({ id: "FN-1" }),
    archiveAllDone: vi.fn().mockResolvedValue({ archived: [], skipped: [] }),
    cleanupArchivedTasks: vi.fn().mockResolvedValue(0),
    getDatabase: vi.fn().mockReturnValue({ raw: "sync-db" }),
    getAsyncLayer: vi.fn().mockReturnValue({ raw: "async-layer" }),
    getTask: vi.fn().mockResolvedValue({ id: "FN-1", column: "todo" }),
    moveTask: vi.fn().mockResolvedValue({ id: "FN-1", column: "todo" }),
    someCounter: 7,
  };
}

describe("createPluginGatedTaskStore", () => {
  it.each(PLUGIN_DESTRUCTIVE_TASK_STORE_METHODS)(
    "throws for %s without a destructiveTaskOps declaration",
    (method) => {
      const raw = makeFakeStore();
      const gated = createPluginGatedTaskStore(raw as unknown as TaskStore, {
        pluginId: "fusion-plugin-test",
      }) as unknown as Record<string, (...args: unknown[]) => unknown>;

      expect(() => gated[method]("FN-1")).toThrow(
        `Plugin fusion-plugin-test is not permitted to call ${method}; ` +
          `declare permissions.destructiveTaskOps in the plugin manifest`,
      );
      expect((raw as unknown as Record<string, ReturnType<typeof vi.fn>>)[method]).not.toHaveBeenCalled();
    },
  );

  /*
  FNXC:PluginTaskStoreGate 2026-07-26-18:25:
  Hardcoded raw-handle expectations (NOT derived from the denylist constant, so a
  constant regression cannot self-adjust these): the sync getDatabase handle is
  denied (raw SQL around the denylist), while getAsyncLayer deliberately passes
  through — four in-repo plugins depend on it for plugin-scoped schema; the
  residual is documented on the denylist in plugin-task-store-gate.ts.
  */
  it("denies the raw getDatabase handle without a declaration (hardcoded)", () => {
    const raw = makeFakeStore();
    const gated = createPluginGatedTaskStore(raw as unknown as TaskStore, {
      pluginId: "fusion-plugin-test",
    }) as unknown as typeof raw;

    expect(() => gated.getDatabase()).toThrow(
      "Plugin fusion-plugin-test is not permitted to call getDatabase; declare permissions.destructiveTaskOps in the plugin manifest",
    );
    expect(raw.getDatabase).not.toHaveBeenCalled();
  });

  it("keeps getAsyncLayer passing through (documented residual; plugins rely on it)", () => {
    const raw = makeFakeStore();
    const gated = createPluginGatedTaskStore(raw as unknown as TaskStore, {
      pluginId: "fusion-plugin-test",
    }) as unknown as typeof raw;

    expect(gated.getAsyncLayer()).toEqual({ raw: "async-layer" });
  });

  it("passes destructive calls through when the manifest declares destructiveTaskOps", async () => {
    const raw = makeFakeStore();
    const gated = createPluginGatedTaskStore(raw as unknown as TaskStore, {
      pluginId: "fusion-plugin-test",
      permissions: { destructiveTaskOps: true },
    }) as unknown as typeof raw;

    await gated.deleteTask("FN-1");
    await gated.archiveAllDone();
    expect(raw.deleteTask).toHaveBeenCalledWith("FN-1");
    expect(raw.archiveAllDone).toHaveBeenCalledOnce();
  });

  it("leaves non-destructive methods and plain properties untouched", async () => {
    const raw = makeFakeStore();
    const gated = createPluginGatedTaskStore(raw as unknown as TaskStore, {
      pluginId: "fusion-plugin-test",
    }) as unknown as typeof raw;

    await expect(gated.getTask("FN-1")).resolves.toEqual({ id: "FN-1", column: "todo" });
    await gated.moveTask("FN-1", "todo");
    expect(raw.moveTask).toHaveBeenCalledWith("FN-1", "todo");
    expect(gated.someCounter).toBe(7);
  });

  it("binds pass-through methods to the raw store so store-identity seams survive", async () => {
    const raw = makeFakeStore();
    let observedThis: unknown;
    (raw as Record<string, unknown>).whoAmI = function (this: unknown) {
      observedThis = this;
      return "ok";
    };
    const gated = createPluginGatedTaskStore(raw as unknown as TaskStore, {
      pluginId: "fusion-plugin-test",
    }) as unknown as Record<string, () => unknown>;

    expect(gated.whoAmI()).toBe("ok");
    expect(observedThis).toBe(raw);
    // Bound method identity is stable across property reads.
    expect(gated.whoAmI).toBe(gated.whoAmI);
  });

  it("rejects when a denylisted method is awaited", async () => {
    const raw = makeFakeStore();
    const gated = createPluginGatedTaskStore(raw as unknown as TaskStore, {
      pluginId: "fusion-plugin-test",
    }) as unknown as typeof raw;

    await expect(async () => gated.bypassFailedPreMergeReviewStep("FN-1")).rejects.toThrow(
      "not permitted to call bypassFailedPreMergeReviewStep",
    );
  });

  /*
  FNXC:PluginTaskStoreGate 2026-10-12-08:27:
  A plugin asks which lane role a column carries through `ctx.taskStore`, which is this gated handle. The lookup is a read, so a plugin without `destructiveTaskOps` must reach the real store method and get the board's own answer.
  */
  it("answers a lane-role lookup through the gate without a destructiveTaskOps declaration", async () => {
    const selection = { workflowId: "wf", stepIds: [] as string[] };
    const ir = {
      version: "v2", id: "wf", name: "wf", nodes: [], edges: [],
      columns: [
        { id: "in-progress", name: "Not a working lane", traits: [] },
        { id: "building", name: "Building", traits: [{ trait: "wip" }] },
        { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
      ],
    };
    const raw = {
      getTaskWorkflowSelection: () => selection,
      getTaskWorkflowSelectionAsync: async () => selection,
      getWorkflowDefinition: async () => ({ id: "wf", ir }),
      taskColumnHasLaneRole: TaskStore.prototype.taskColumnHasLaneRole,
    };
    const gated = createPluginGatedTaskStore(raw as unknown as TaskStore, {
      pluginId: "fusion-plugin-test",
    });

    await expect(taskColumnHasLaneRole(gated, "FN-1", "building", "wip")).resolves.toBe(true);
    await expect(taskColumnHasLaneRole(gated, "FN-1", "in-progress", "wip")).resolves.toBe(false);
  });
});
