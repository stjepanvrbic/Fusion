// @vitest-environment node

import express from "express";
import { DASHBOARD_USER_ID, type Message, type MessageFilter, type TaskStore } from "@fusion/core";
import { describe, expect, it, vi } from "vitest";
import { request } from "../../test-request.js";
import { ApiError } from "../../api-error.js";
import { registerMessagingScriptRoutes } from "../register-messaging-scripts.js";
import type { ApiRoutesContext } from "../types.js";

/*
FNXC:Mailbox 2026-10-07-20:17:
Inbox and outbox responses report the real filtered total and whether another page exists, so a message beyond the first page stays reachable.
total was previously the returned page length, which made the 51st message look like it did not exist.
*/

function makeMessages(count: number, direction: "in" | "out", archived = false): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${direction}-${archived ? "archived-" : ""}${index}`,
    fromId: direction === "in" ? "agent-1" : DASHBOARD_USER_ID, fromType: direction === "in" ? "agent" : "user",
    toId: direction === "in" ? DASHBOARD_USER_ID : "agent-1", toType: direction === "in" ? "user" : "agent",
    content: `message ${index}`, type: direction === "in" ? "agent-to-user" : "user-to-agent", read: false, archived,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, count - index)).toISOString(), updatedAt: "2026-10-01T00:00:00.000Z",
  })) as Message[];
}

function setup(inbox: Message[], outbox: Message[]) {
  const app = express();
  app.use(express.json());
  const select = (rows: Message[], filter?: MessageFilter) => rows.filter((row) => (row.archived === true) === (filter?.archived === true));
  const messageStore = {
    getInbox: vi.fn(async (_id: string, _type: string, filter?: MessageFilter) => select(inbox, filter).slice(filter?.offset ?? 0, (filter?.offset ?? 0) + (filter?.limit ?? 100))),
    getOutbox: vi.fn(async (_id: string, _type: string, filter?: MessageFilter) => select(outbox, filter).slice(filter?.offset ?? 0, (filter?.offset ?? 0) + (filter?.limit ?? 100))),
    countInbox: vi.fn(async (_id: string, _type: string, filter?: MessageFilter) => select(inbox, filter).length),
    countOutbox: vi.fn(async (_id: string, _type: string, filter?: MessageFilter) => select(outbox, filter).length),
    getMailbox: vi.fn(async () => ({ unreadCount: inbox.filter((row) => !row.archived && !row.read).length })),
  };
  const store = { getRootDir: () => "/test" } as unknown as TaskStore;
  const context = {
    router: express.Router(), store,
    getProjectContext: async () => ({ store, engine: { getMessageStore: () => messageStore }, projectId: undefined }),
    rethrowAsApiError: (error: unknown): never => { throw error; }, runtimeLogger: { warn: vi.fn() }, planningLogger: {}, chatLogger: {},
  } as unknown as ApiRoutesContext;
  registerMessagingScriptRoutes(context);
  app.use("/api", context.router);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = error instanceof ApiError ? error.statusCode : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
  });
  return { app, messageStore };
}

describe.each(["inbox", "outbox"] as const)("GET /messages/%s pagination", (box) => {
  const build = (count: number, archivedCount = 0) => {
    const direction = box === "inbox" ? "in" : "out";
    const rows = [...makeMessages(count, direction), ...makeMessages(archivedCount, direction, true)];
    return box === "inbox" ? setup(rows, []) : setup([], rows);
  };

  it.each([
    { count: 0, offset: 0, returned: 0, hasMore: false },
    { count: 50, offset: 0, returned: 50, hasMore: false },
    { count: 51, offset: 0, returned: 50, hasMore: true },
    { count: 51, offset: 50, returned: 1, hasMore: false },
    { count: 120, offset: 50, returned: 50, hasMore: true },
    { count: 120, offset: 100, returned: 20, hasMore: false },
  ])("reports total $count and hasMore $hasMore at offset $offset", async ({ count, offset, returned, hasMore }) => {
    const { app } = build(count, 3);
    const response = await request(app, "GET", `/api/messages/${box}?limit=50&offset=${offset}`);
    expect(response.status).toBe(200);
    const body = response.body as { messages: Message[]; total: number; hasMore: boolean };
    expect(body.messages).toHaveLength(returned);
    expect(body.total).toBe(count);
    expect(body.hasMore).toBe(hasMore);
  });

  it("counts archived mail separately from the active list", async () => {
    const { app } = build(5, 60);
    const response = await request(app, "GET", `/api/messages/${box}?limit=50&archived=true`);
    const body = response.body as { messages: Message[]; total: number; hasMore: boolean };
    expect(body.messages.every((message) => message.archived)).toBe(true);
    expect(body.total).toBe(60);
    expect(body.hasMore).toBe(true);
  });
});
