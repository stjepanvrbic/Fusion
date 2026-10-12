import { describe, expect, it, vi } from "vitest";
import { createNotificationRoutes } from "../routes/notification-routes.js";

function route(method: string, path: string) {
  return createNotificationRoutes((ctx) => (ctx as any).notifier).find((r) => r.method === method && r.path === path)!;
}

function ctx(notifier?: any) {
  return {
    pluginId: "p1",
    notifier,
    settings: { apiKey: "secret" },
    logger: { error: vi.fn() },
    taskStore: { getTask: vi.fn(async (id: string) => ({ id, description: id, column: "in-review", updatedAt: "2026-01-01T00:00:00.000Z", dependencies: [], steps: [], currentStep: 1, log: [] })) },
  } as any;
}

describe("notification routes", () => {
  it("401 on missing auth", async () => {
    const res: any = await route("GET", "/notifications").handler({}, ctx());
    expect(res.status).toBe(401);
  });

  it("503 when notifier missing", async () => {
    const res: any = await route("GET", "/notifications").handler({ headers: { authorization: "Bearer secret" } }, ctx(undefined));
    expect(res).toMatchObject({ status: 503, body: { error: "notifier not running" } });
  });

  it("gets events and drains", async () => {
    const notifier = {
      peekPending: vi.fn(() => [{ taskId: "FN-1", reason: "new-task", column: "in-review", previousColumn: null, updatedAt: "2026-01-01T00:00:00.000Z" }]),
      drainPending: vi.fn(() => [{ taskId: "FN-1", reason: "new-task", column: "in-review", previousColumn: null, updatedAt: "2026-01-01T00:00:00.000Z" }]),
      lastPolledAt: vi.fn(() => "2026-01-01T00:00:10.000Z"),
    };
    const getRes: any = await route("GET", "/notifications").handler({ headers: { authorization: "Bearer secret" }, query: { limit: "999" } }, ctx(notifier));
    expect(getRes.status).toBe(200);
    expect((getRes.body as any).cards).toHaveLength(1);

    const drainRes: any = await route("GET", "/notifications").handler({ headers: { authorization: "Bearer secret" }, query: { drain: "true" } }, ctx(notifier));
    expect(drainRes.status).toBe(200);
    expect(notifier.drainPending).toHaveBeenCalled();
  });

  describe("review lane in the card title", () => {
    const renamedBoardIr = {
      version: "v2", id: "wf-custom", name: "custom", nodes: [], edges: [],
      columns: [
        { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
        { id: "qa", name: "QA", traits: [{ trait: "merge-blocker" }] },
      ],
    };

    async function cardTitleFor(column: string, taskStoreExtras: Record<string, unknown>) {
      const event = { taskId: "FN-1", reason: "entered-column", column, previousColumn: "backlog", updatedAt: "2026-01-01T00:00:00.000Z" };
      const context = ctx({ peekPending: vi.fn(() => [event]), lastPolledAt: vi.fn(() => null) });
      context.taskStore = {
        getTask: vi.fn(async (id: string) => ({ id, description: id, column, updatedAt: "2026-01-01T00:00:00.000Z", dependencies: [], steps: [], currentStep: 1, log: [] })),
        ...taskStoreExtras,
      };
      const res: any = await route("GET", "/notifications").handler({ headers: { authorization: "Bearer secret" } }, context);
      expect(res.status).toBe(200);
      expect(res.body.cards).toHaveLength(1);
      return res.body.cards[0].title as string;
    }

    it("titles entry into a declared review lane as in review", async () => {
      const title = await cardTitleFor("qa", { listWorkflowDefinitions: async () => [{ id: "wf-custom", ir: renamedBoardIr }] });
      expect(title.startsWith("In review ·")).toBe(true);
    });

    it("titles entry into a lane no workflow declares as a review lane as moved in", async () => {
      const title = await cardTitleFor("backlog", { listWorkflowDefinitions: async () => [{ id: "wf-custom", ir: renamedBoardIr }] });
      expect(title.startsWith("Moved in ·")).toBe(true);
    });

    it("keeps the in-review title on a store that lists no workflow definitions", async () => {
      expect((await cardTitleFor("in-review", {})).startsWith("In review ·")).toBe(true);
      expect((await cardTitleFor("qa", {})).startsWith("Moved in ·")).toBe(true);
    });
  });

  it("acks matching task ids", async () => {
    const notifier = { ack: vi.fn(() => 2) };
    const res: any = await route("POST", "/notifications/ack").handler({ headers: { authorization: "Bearer secret" }, body: { taskIds: ["FN-1", "FN-2"] } }, ctx(notifier));
    expect(res).toMatchObject({ status: 200, body: { acked: 2 } });
  });

  it("400 for invalid ack body", async () => {
    const notifier = { ack: vi.fn(() => 0) };
    const res: any = await route("POST", "/notifications/ack").handler({ headers: { authorization: "Bearer secret" }, body: { taskIds: "FN-1" } }, ctx(notifier));
    expect(res.status).toBe(400);
  });

  it("poll-now calls notifier", async () => {
    const notifier = {
      pollOnce: vi.fn(async () => [{ taskId: "FN-1", reason: "new-task", column: "in-review", previousColumn: null, updatedAt: "2026-01-01T00:00:00.000Z" }]),
      lastPolledAt: vi.fn(() => "2026-01-01T00:00:05.000Z"),
    };
    const res: any = await route("POST", "/notifications/poll-now").handler({ headers: { authorization: "Bearer secret" } }, ctx(notifier));
    expect(res).toMatchObject({ status: 200 });
    expect(notifier.pollOnce).toHaveBeenCalled();
  });

  it("omits cards when task missing", async () => {
    const notifier = {
      peekPending: vi.fn(() => [{ taskId: "FN-9", reason: "new-task", column: "in-review", previousColumn: null, updatedAt: "2026-01-01T00:00:00.000Z" }]),
      drainPending: vi.fn(() => []),
      lastPolledAt: vi.fn(() => null),
    };
    const context = ctx(notifier);
    context.taskStore.getTask = vi.fn(async () => undefined);
    const res: any = await route("GET", "/notifications").handler({ headers: { authorization: "Bearer secret" } }, context);
    expect((res.body as any).events).toHaveLength(1);
    expect((res.body as any).cards).toHaveLength(0);
  });
});
