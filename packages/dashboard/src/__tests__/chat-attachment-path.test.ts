// @vitest-environment node

import express from "express";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "../test-request.js";
import { ApiError } from "../api-error.js";
import { resolveChatAttachmentPath } from "../chat-attachment-path.js";
import { registerChatRoutes } from "../routes/register-chat-routes.js";
import { registerChatRoomRoutes } from "../routes/register-chat-room-routes.js";

/*
FNXC:ChatAttachments 2026-10-07-17:59:
Attachment reads and deletes must work with the host's own path separator (Windows resolves backslash paths, so a "/" containment check refused every attachment) and must refuse any owner id or filename that is not a single path segment.
*/

const { mockResolveProjectChatContext } = vi.hoisted(() => ({ mockResolveProjectChatContext: vi.fn() }));
vi.mock("../chat-project-services.js", () => ({
  resolveProjectChatContext: mockResolveProjectChatContext,
  getOrCreateScopedChatManager: vi.fn(),
  createProjectScopedChatManager: vi.fn(),
}));

describe("resolveChatAttachmentPath", () => {
  it.each([
    ["win32", path.win32, "C:\\Users\\op\\project"],
    ["posix", path.posix, "/home/op/project"],
  ] as const)("accepts a plain attachment name with %s paths", (_name, pathModule, rootDir) => {
    const { ownerDir, filePath } = resolveChatAttachmentPath(rootDir, "chat-attachments", "chat-1", "1700000000-photo.png", pathModule);
    expect(ownerDir).toBe(pathModule.resolve(rootDir, ".fusion", "chat-attachments", "chat-1"));
    expect(filePath).toBe(pathModule.join(ownerDir, "1700000000-photo.png"));
  });

  it.each([
    ["win32", path.win32, "C:\\Users\\op\\project"],
    ["posix", path.posix, "/home/op/project"],
  ] as const)("refuses traversal through the owner id or filename with %s paths", (_name, pathModule, rootDir) => {
    for (const [owner, filename] of [
      ["..", "settings.json"],
      ["../..", "package.json"],
      ["chat-1", ".."],
      ["chat-1", "../escape.txt"],
      ["chat-1", "..\\escape.txt"],
      ["chat-1", "C:escape.txt"],
      ["chat-1", ""],
      ["", "photo.png"],
      [".", "photo.png"],
    ]) {
      expect(() => resolveChatAttachmentPath(rootDir, "chat-room-attachments", owner, filename, pathModule), `${owner} / ${filename}`)
        .toThrow("Invalid attachment path");
    }
  });
});

describe("chat attachment routes on the host platform", () => {
  let rootDir: string;
  const chatStore = { getRoom: vi.fn(async (id: string) => (id === "room-1" ? { id } : undefined)) };

  function makeApp() {
    const router = express.Router();
    const app = express();
    app.use(express.json());
    app.use("/api", router);
    const ctx = {
      router,
      store: {} as never,
      options: { chatStore, chatManager: {} } as never,
      runtimeLogger: {} as never,
      planningLogger: {} as never,
      chatLogger: { error: vi.fn(), warn: vi.fn(), log: vi.fn() },
      getProjectIdFromRequest: () => undefined,
      getScopedStore: vi.fn(),
      getProjectContext: vi.fn().mockResolvedValue({ store: { getRootDir: () => rootDir }, projectId: undefined, engine: undefined }),
      rethrowAsApiError: (error: unknown): never => { throw error; },
    } as never;
    const upload = {
      single: () => (_req: unknown, _res: unknown, next: () => void) => next(),
      array: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    } as never;
    registerChatRoutes(ctx, {
      parseLastEventId: () => undefined,
      replayBufferedSSE: () => false,
      validateOptionalModelField: () => undefined,
      upload,
    } as never);
    registerChatRoomRoutes(ctx, { upload } as never);
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(err instanceof ApiError ? err.statusCode : 500).json({ error: (err as Error).message });
    });
    return app;
  }

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), "fusion-chat-attachments-"));
    mockResolveProjectChatContext.mockResolvedValue({ store: {}, chatStore });
    mkdirSync(path.join(rootDir, ".fusion", "chat-attachments", "chat-1"), { recursive: true });
    mkdirSync(path.join(rootDir, ".fusion", "chat-room-attachments", "room-1"), { recursive: true });
    writeFileSync(path.join(rootDir, ".fusion", "chat-attachments", "chat-1", "1-photo.png"), "session-bytes");
    writeFileSync(path.join(rootDir, ".fusion", "chat-room-attachments", "room-1", "1-photo.png"), "room-bytes");
    writeFileSync(path.join(rootDir, ".fusion", "settings.json"), "{}");
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("serves a session attachment", async () => {
    const response = await request(makeApp(), "GET", "/api/chat/sessions/chat-1/attachments/1-photo.png");
    expect(response.status).toBe(200);
    expect(response.body).toBe("session-bytes");
  });

  it("serves a room attachment", async () => {
    const response = await request(makeApp(), "GET", "/api/chat/rooms/room-1/attachments/1-photo.png");
    expect(response.status).toBe(200);
    expect(response.body).toBe("room-bytes");
  });

  it("deletes a session attachment", async () => {
    const response = await request(makeApp(), "DELETE", "/api/chat/sessions/chat-1/attachments/1-photo.png");
    expect(response.status).toBe(200);
    expect(existsSync(path.join(rootDir, ".fusion", "chat-attachments", "chat-1", "1-photo.png"))).toBe(false);
  });

  it.each([
    ["GET", "/api/chat/sessions/%2E%2E/attachments/settings.json"],
    ["DELETE", "/api/chat/sessions/%2E%2E/attachments/settings.json"],
    ["GET", "/api/chat/sessions/chat-1/attachments/..%2F..%2Fsettings.json"],
    ["GET", "/api/chat/sessions/chat-1/attachments/..%5C..%5Csettings.json"],
    ["GET", "/api/chat/rooms/room-1/attachments/..%2F..%2Fsettings.json"],
    ["GET", "/api/chat/rooms/room-1/attachments/..%5C..%5Csettings.json"],
  ])("%s %s is refused", async (method, url) => {
    const response = await request(makeApp(), method, url);
    expect(response.status).toBe(400);
    expect(existsSync(path.join(rootDir, ".fusion", "settings.json"))).toBe(true);
  });
});
