import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import plugin from "../index.js";

// ── Mock Context ───────────────────────────────────────────────────────────────

interface MockLogger {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
}

interface MockContext {
  pluginId: string;
  settings: Record<string, unknown>;
  logger: MockLogger;
  emitEvent: ReturnType<typeof vi.fn>;
  taskStore: {
    getTask: ReturnType<typeof vi.fn>;
    taskColumnHasLaneRole?: ReturnType<typeof vi.fn>;
  };
}

function createMockContext(overrides: Partial<MockContext> = {}): MockContext {
  return {
    pluginId: "fusion-plugin-ci-status",
    settings: {
      ciUrl: "https://ci.example.com/api",
      pollIntervalMs: 60000,
      branchPrefix: "fusion/",
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    emitEvent: vi.fn(),
    taskStore: {
      getTask: vi.fn(),
    },
    ...overrides,
  };
}

/**
 * A context for a board whose lanes were renamed: `building` and `verifying` are working lanes and
 * `vault` is the archive lane. The store answers the lane-role lookup the way a Fusion host does.
 */
function createRenamedBoardContext(overrides: Partial<MockContext> = {}): MockContext {
  return createMockContext({
    taskStore: {
      getTask: vi.fn(),
      taskColumnHasLaneRole: vi.fn(
        async (_taskId: string, columnId: string, role: string) =>
          (role === "wip" && (columnId === "building" || columnId === "verifying")) ||
          (role === "archived" && columnId === "vault"),
      ),
    },
    ...overrides,
  });
}

// ── Mock Request/Response ──────────────────────────────────────────────────────

function createMockRequest(overrides: Partial<{ params: Record<string, string>; method: string; url: string }> = {}): {
  params: Record<string, string>;
  method: string;
  url: string;
} {
  return {
    params: {},
    method: "GET",
    url: "/status",
    ...overrides,
  };
}

function createMockResponse() {
  const json = vi.fn();
  const status = vi.fn().mockReturnThis();
  return { json, status };
}

const mockTask = {
  id: "FN-001",
  title: "Test Task",
  description: "A test task",
  column: "in-progress" as const,
  dependencies: [],
  steps: [],
  currentStep: 0,
  size: "M" as const,
  reviewLevel: "full" as const,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

function getFetchMock(): ReturnType<typeof vi.fn> {
  return globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
}

async function drainDetachedPoll(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** The tracked branches as the plugin's own GET /status route reports them. */
async function trackedBranches(ctx: MockContext): Promise<Array<{ branch: string; status: string }>> {
  const route = plugin.routes!.find((r) => r.method === "GET" && r.path === "/status")!;
  const result = await route.handler(createMockRequest() as any, ctx as any) as {
    branches: Array<{ branch: string; status: string }>;
  };
  return result.branches.map(({ branch, status }) => ({ branch, status }));
}

// ── Test Suite ─────────────────────────────────────────────────────────────────

describe("ci-status plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // FNXC:PluginTesting 2026-06-21-00:00: ci-status suite must mock global.fetch — postRefreshHandler and the onLoad poll call pollCIStatus(), and an unmocked real fetch to ci.example.com caused a load-sensitive POST /refresh timeout (FN-6714/FN-6898). Keep zero real-network calls; assert the mock catches both the route and timer-driven polls.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ statuses: [] }),
      }),
    );
  });

  afterEach(async () => {
    await plugin.hooks.onUnload?.({} as any);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("plugin export", () => {
    it("should export a valid FusionPlugin with correct manifest fields", () => {
      expect(plugin.manifest.id).toBe("fusion-plugin-ci-status");
      expect(plugin.manifest.name).toBe("CI Status Plugin");
      expect(plugin.manifest.version).toBe("0.1.0");
      expect(plugin.state).toBe("installed");
    });

    it("should have routes array with 3 routes", () => {
      expect(plugin.routes).toBeDefined();
      expect(plugin.routes!.length).toBe(3);
    });

    it("should have GET /status route", () => {
      const route = plugin.routes!.find(
        (r) => r.method === "GET" && r.path === "/status",
      );
      expect(route).toBeDefined();
      expect(route!.description).toBe("Get status of all tracked branches");
    });

    it("should have GET /status/:branch route", () => {
      const route = plugin.routes!.find(
        (r) => r.method === "GET" && r.path === "/status/:branch",
      );
      expect(route).toBeDefined();
      expect(route!.description).toBe("Get status of a specific branch");
    });

    it("should have POST /refresh route", () => {
      const route = plugin.routes!.find(
        (r) => r.method === "POST" && r.path === "/refresh",
      );
      expect(route).toBeDefined();
      expect(route!.description).toBe("Trigger an immediate CI status refresh");
    });

    it("should have onLoad, onUnload, onTaskMoved, and onTaskCompleted hooks", () => {
      expect(plugin.hooks.onLoad).toBeDefined();
      expect(plugin.hooks.onUnload).toBeDefined();
      expect(plugin.hooks.onTaskMoved).toBeDefined();
      expect(plugin.hooks.onTaskCompleted).toBeDefined();
    });

    it("should have settings schema defined", () => {
      expect(plugin.manifest.settingsSchema).toBeDefined();
      expect(plugin.manifest.settingsSchema!.ciUrl).toBeDefined();
      expect(plugin.manifest.settingsSchema!.pollIntervalMs).toBeDefined();
      expect(plugin.manifest.settingsSchema!.branchPrefix).toBeDefined();
    });

    describe("uiSlots", () => {
      it("should have uiSlots array with 2 entries", () => {
        expect(plugin.uiSlots).toBeDefined();
        expect(plugin.uiSlots!.length).toBe(2);
      });

      it("should have task-card-badge slot", () => {
        const slot = plugin.uiSlots!.find((s) => s.slotId === "task-card-badge");
        expect(slot).toBeDefined();
        expect(slot!.label).toBe("CI Status");
        expect(slot!.icon).toBe("circle-check");
        expect(slot!.componentPath).toBe("./components/ci-badge.js");
      });

      it("should have task-detail-tab slot", () => {
        const slot = plugin.uiSlots!.find((s) => s.slotId === "task-detail-tab");
        expect(slot).toBeDefined();
        expect(slot!.label).toBe("CI History");
        expect(slot!.icon).toBe("history");
        expect(slot!.componentPath).toBe("./components/ci-history-tab.js");
      });

      it("should have required fields for each slot", () => {
        for (const slot of plugin.uiSlots!) {
          expect(typeof slot.slotId).toBe("string");
          expect(slot.slotId.length).toBeGreaterThan(0);
          expect(typeof slot.label).toBe("string");
          expect(slot.label.length).toBeGreaterThan(0);
          expect(typeof slot.componentPath).toBe("string");
          expect(slot.componentPath.length).toBeGreaterThan(0);
        }
      });
    });
  });

  describe("hooks.onLoad", () => {
    it("should log startup message", async () => {
      const ctx = createMockContext();
      await plugin.hooks.onLoad?.(ctx as any);
      expect(ctx.logger.info).toHaveBeenCalledWith("CI Status plugin loaded");
    });

    it("should start an interval for polling", async () => {
      const ctx = createMockContext();
      await plugin.hooks.onLoad?.(ctx as any);

      // The interval should be set
      expect(ctx.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("CI polling started"),
      );
    });
  });

  describe("hooks.onUnload", () => {
    it("should log shutdown message", async () => {
      const ctx = createMockContext();
      await plugin.hooks.onLoad?.(ctx as any);
      vi.clearAllMocks();

      await plugin.hooks.onUnload?.(ctx as any);

      expect(ctx.logger.info).toHaveBeenCalledWith("CI Status plugin unloaded");
    });
  });

  describe("hooks.onTaskMoved", () => {
    it("should track branch when task moves to in-progress", async () => {
      const ctx = createMockContext();
      await plugin.hooks.onTaskMoved?.(
        mockTask as any,
        "todo",
        "in-progress",
        ctx as any,
      );
      expect(ctx.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Tracking branch for task FN-001"),
      );
      expect(await trackedBranches(ctx)).toEqual([{ branch: "fusion/fn-001", status: "pending" }]);
    });

    it("should keep one entry when the task moves to in-progress twice", async () => {
      const ctx = createMockContext();
      await plugin.hooks.onTaskMoved?.(mockTask as any, "todo", "in-progress", ctx as any);
      await plugin.hooks.onTaskMoved?.(mockTask as any, "in-review", "in-progress", ctx as any);

      expect(await trackedBranches(ctx)).toEqual([{ branch: "fusion/fn-001", status: "pending" }]);
    });

    it("should keep tracking when the task moves to done without a completion report", async () => {
      // Fusion reports completion through onTaskCompleted, so a move to a column named "done" is not the signal.
      const ctx = createMockContext();
      await plugin.hooks.onTaskMoved?.(mockTask as any, "todo", "in-progress", ctx as any);
      vi.clearAllMocks();

      await plugin.hooks.onTaskMoved?.(mockTask as any, "in-progress", "done", ctx as any);

      expect(await trackedBranches(ctx)).toEqual([{ branch: "fusion/fn-001", status: "pending" }]);
      expect(ctx.logger.info).not.toHaveBeenCalledWith(expect.stringContaining("Stopped tracking"));
    });

    it("should stop tracking branch when task moves to archived", async () => {
      const ctx = createMockContext();
      await plugin.hooks.onTaskMoved?.(mockTask as any, "todo", "in-progress", ctx as any);
      vi.clearAllMocks();

      await plugin.hooks.onTaskMoved?.(mockTask as any, "in-progress", "archived", ctx as any);

      expect(await trackedBranches(ctx)).toEqual([]);
      expect(ctx.logger.info).toHaveBeenCalledWith("Stopped tracking branch for task FN-001");
    });

    it("should use configured branch prefix", async () => {
      const ctx = createMockContext({
        settings: {
          ciUrl: "https://ci.example.com/api",
          pollIntervalMs: 60000,
          branchPrefix: "custom/",
        },
      });

      await plugin.hooks.onTaskMoved?.(
        mockTask as any,
        "todo",
        "in-progress",
        ctx as any,
      );

      expect(ctx.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("custom/fn-001"),
      );
      expect(await trackedBranches(ctx)).toEqual([{ branch: "custom/fn-001", status: "pending" }]);
    });
  });

  // FNXC:PluginExamples 2026-10-12-08:27:
  // Tracking must follow the role of a lane and not its id. On a board with renamed lanes the plugin starts when a card enters a working lane and stops when it enters the archive lane, and the default board's ids mean nothing there.
  describe("hooks.onTaskMoved on a board with renamed lanes", () => {
    it("should track the branch when the task enters a working lane", async () => {
      const ctx = createRenamedBoardContext();

      await plugin.hooks.onTaskMoved?.(mockTask as any, "backlog", "building", ctx as any);

      expect(await trackedBranches(ctx)).toEqual([{ branch: "fusion/fn-001", status: "pending" }]);
      expect(ctx.taskStore.taskColumnHasLaneRole).toHaveBeenCalledWith("FN-001", "building", "wip");
      expect(ctx.logger.info).toHaveBeenCalledWith("Tracking branch for task FN-001: fusion/fn-001");
    });

    it("should not track when the task enters a column that only shares the default working id", async () => {
      const ctx = createRenamedBoardContext();

      await plugin.hooks.onTaskMoved?.(mockTask as any, "backlog", "in-progress", ctx as any);

      expect(await trackedBranches(ctx)).toEqual([]);
    });

    it("should stop tracking when the task enters the archive lane", async () => {
      // The branch is seeded through a host without the lookup, so this case does not depend on how tracking starts on the renamed board.
      await plugin.hooks.onTaskMoved?.(mockTask as any, "todo", "in-progress", createMockContext() as any);
      const ctx = createRenamedBoardContext();
      expect(await trackedBranches(ctx)).toEqual([{ branch: "fusion/fn-001", status: "pending" }]);

      await plugin.hooks.onTaskMoved?.(mockTask as any, "building", "vault", ctx as any);

      expect(await trackedBranches(ctx)).toEqual([]);
      expect(ctx.logger.info).toHaveBeenCalledWith("Stopped tracking branch for task FN-001");
    });

    it("should keep tracking when the task enters a column that only shares the default archive id", async () => {
      const ctx = createRenamedBoardContext();
      await plugin.hooks.onTaskMoved?.(mockTask as any, "backlog", "building", ctx as any);

      await plugin.hooks.onTaskMoved?.(mockTask as any, "building", "archived", ctx as any);

      expect(await trackedBranches(ctx)).toEqual([{ branch: "fusion/fn-001", status: "pending" }]);
    });

    it("should keep one entry when the task moves between two working lanes", async () => {
      const ctx = createRenamedBoardContext();
      await plugin.hooks.onTaskMoved?.(mockTask as any, "backlog", "building", ctx as any);

      await plugin.hooks.onTaskMoved?.(mockTask as any, "building", "verifying", ctx as any);

      expect(await trackedBranches(ctx)).toEqual([{ branch: "fusion/fn-001", status: "pending" }]);
    });

    it("should stop tracking when Fusion reports the task completed", async () => {
      const ctx = createRenamedBoardContext();
      await plugin.hooks.onTaskMoved?.(mockTask as any, "backlog", "building", ctx as any);

      await plugin.hooks.onTaskCompleted?.(mockTask as any, ctx as any);

      expect(await trackedBranches(ctx)).toEqual([]);
    });

    it("should reject and track nothing when the lane-role lookup fails", async () => {
      const ctx = createRenamedBoardContext();
      ctx.taskStore.taskColumnHasLaneRole!.mockRejectedValue(new Error("store offline"));

      await expect(
        Promise.resolve(plugin.hooks.onTaskMoved?.(mockTask as any, "backlog", "building", ctx as any)),
      ).rejects.toThrow("store offline");

      expect(await trackedBranches(ctx)).toEqual([]);
    });

    it("should use configured branch prefix", async () => {
      const ctx = createRenamedBoardContext({
        settings: {
          ciUrl: "https://ci.example.com/api",
          pollIntervalMs: 60000,
          branchPrefix: "custom/",
        },
      });

      await plugin.hooks.onTaskMoved?.(mockTask as any, "backlog", "building", ctx as any);

      expect(await trackedBranches(ctx)).toEqual([{ branch: "custom/fn-001", status: "pending" }]);
    });
  });

  describe("hooks.onTaskCompleted", () => {
    it("should stop tracking branch when the task is completed", async () => {
      const ctx = createMockContext();
      await plugin.hooks.onTaskMoved?.(mockTask as any, "todo", "in-progress", ctx as any);
      vi.clearAllMocks();

      await plugin.hooks.onTaskCompleted?.(mockTask as any, ctx as any);

      expect(await trackedBranches(ctx)).toEqual([]);
      expect(ctx.logger.info).toHaveBeenCalledWith("Stopped tracking branch for task FN-001");
    });

    it("should stop tracking when the board's complete column has another id", async () => {
      const ctx = createMockContext();
      await plugin.hooks.onTaskMoved?.(mockTask as any, "todo", "in-progress", ctx as any);

      await plugin.hooks.onTaskMoved?.(mockTask as any, "qa", "shipped", ctx as any);
      expect(await trackedBranches(ctx)).toEqual([{ branch: "fusion/fn-001", status: "pending" }]);

      await plugin.hooks.onTaskCompleted?.(mockTask as any, ctx as any);
      expect(await trackedBranches(ctx)).toEqual([]);
    });

    it("should do nothing for a task that was never tracked", async () => {
      const ctx = createMockContext();
      const other = { ...mockTask, id: "FN-002" };
      await plugin.hooks.onTaskMoved?.(mockTask as any, "todo", "in-progress", ctx as any);
      vi.clearAllMocks();

      await plugin.hooks.onTaskCompleted?.(other as any, ctx as any);

      expect(await trackedBranches(ctx)).toEqual([{ branch: "fusion/fn-001", status: "pending" }]);
      expect(ctx.logger.info).not.toHaveBeenCalledWith(expect.stringContaining("Stopped tracking"));
    });

    it("should use configured branch prefix", async () => {
      const ctx = createMockContext({
        settings: {
          ciUrl: "https://ci.example.com/api",
          pollIntervalMs: 60000,
          branchPrefix: "custom/",
        },
      });
      await plugin.hooks.onTaskMoved?.(mockTask as any, "todo", "in-progress", ctx as any);
      expect(await trackedBranches(ctx)).toEqual([{ branch: "custom/fn-001", status: "pending" }]);

      await plugin.hooks.onTaskCompleted?.(mockTask as any, ctx as any);

      expect(await trackedBranches(ctx)).toEqual([]);
    });
  });

  describe("route handlers", () => {
    describe("GET /status", () => {
      it("should return branches array", async () => {
        const ctx = createMockContext();
        const req = createMockRequest();
        const res = createMockResponse();

        const route = plugin.routes!.find(
          (r) => r.method === "GET" && r.path === "/status",
        )!;

        const result = await route.handler(req as any, ctx as any) as { branches?: unknown[] };

        expect(result).toHaveProperty("branches");
        expect(Array.isArray(result.branches)).toBe(true);
      });
    });

    describe("GET /status/:branch", () => {
      it("should return specific branch data", async () => {
        const ctx = createMockContext();
        const req = createMockRequest({
          params: { branch: "fusion/fn-001" },
        });

        // First add the branch via onTaskMoved
        await plugin.hooks.onTaskMoved?.(
          mockTask as any,
          "todo",
          "in-progress",
          ctx as any,
        );

        const route = plugin.routes!.find(
          (r) => r.method === "GET" && r.path === "/status/:branch",
        )!;

        const result = await route.handler(req as any, ctx as any) as { branch?: string; status?: string };

        expect(result).toHaveProperty("branch", "fusion/fn-001");
        expect(result).toHaveProperty("status", "pending");
      });

      it("should throw 404 for unknown branch", async () => {
        const ctx = createMockContext();
        const req = createMockRequest({
          params: { branch: "unknown/branch" },
        });

        const route = plugin.routes!.find(
          (r) => r.method === "GET" && r.path === "/status/:branch",
        )!;

        expect(() => route.handler(req as any, ctx as any)).toThrow(
          "Branch not found",
        );

        try {
          route.handler(req as any, ctx as any);
        } catch (error) {
          expect((error as { statusCode?: number }).statusCode).toBe(404);
        }
      });
    });

    describe("POST /refresh", () => {
      it("should trigger refresh for tracked branches through the mocked fetch", async () => {
        const ctx = createMockContext();
        const req = createMockRequest({ method: "POST" });
        const fetchMock = getFetchMock();

        await plugin.hooks.onTaskMoved?.(
          mockTask as any,
          "todo",
          "in-progress",
          ctx as any,
        );
        fetchMock.mockClear();

        const route = plugin.routes!.find(
          (r) => r.method === "POST" && r.path === "/refresh",
        )!;

        const result = await route.handler(req as any, ctx as any) as { refreshed?: boolean; branches?: unknown[] };
        await drainDetachedPoll();

        expect(result).toHaveProperty("refreshed", true);
        expect(result).toHaveProperty("branches");
        expect(Array.isArray(result.branches)).toBe(true);
        expect(vi.isMockFunction(globalThis.fetch)).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith(
          "https://ci.example.com/api/status",
          expect.objectContaining({
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ branches: ["fusion/fn-001"] }),
          }),
        );
      });

      it("should return refreshed without fetch when no branches are tracked", async () => {
        const ctx = createMockContext();
        const req = createMockRequest({ method: "POST" });
        const fetchMock = getFetchMock();

        const route = plugin.routes!.find(
          (r) => r.method === "POST" && r.path === "/refresh",
        )!;

        const result = await route.handler(req as any, ctx as any) as { refreshed?: boolean; branches?: unknown[] };
        await drainDetachedPoll();

        expect(result).toHaveProperty("refreshed", true);
        expect(result).toHaveProperty("branches", []);
        expect(vi.isMockFunction(globalThis.fetch)).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
      });
    });

    describe("onLoad polling interval", () => {
      it("should poll tracked branches through the mocked fetch when timers advance", async () => {
        const ctx = createMockContext();
        const fetchMock = getFetchMock();

        await plugin.hooks.onTaskMoved?.(
          mockTask as any,
          "todo",
          "in-progress",
          ctx as any,
        );
        await plugin.hooks.onLoad?.(ctx as any);
        fetchMock.mockClear();

        await vi.advanceTimersByTimeAsync(60000);

        expect(vi.isMockFunction(globalThis.fetch)).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith(
          "https://ci.example.com/api/status",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ branches: ["fusion/fn-001"] }),
          }),
        );
      });

      it("should skip fetch on interval ticks when no branches are tracked", async () => {
        const ctx = createMockContext();
        const fetchMock = getFetchMock();

        await plugin.hooks.onLoad?.(ctx as any);
        fetchMock.mockClear();

        await vi.advanceTimersByTimeAsync(60000);

        expect(vi.isMockFunction(globalThis.fetch)).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
      });
    });
  });
});
