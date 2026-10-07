import { describe, expect, it, vi } from "vitest";
import type { Message, MessageCreateInput, MessageFilter, ParticipantType } from "@fusion/core";
import { createSendMessageTool } from "../agent-tools.js";

/**
 * FNXC:OperatorMailDedup 2026-10-07-12:56:
 * A durable heartbeat agent re-sent the same unread operator report every tick.
 * fn_send_message must suppress an exact (whitespace/case-normalized) agent->user duplicate
 * still unread by the same recipient within the window, and leave every other send untouched.
 */

const HOUR_MS = 60 * 60 * 1000;

function createFakeMessageStore(seed: Message[] = []) {
  const messages = [...seed];
  let counter = 0;
  const getOutbox = vi.fn(async (ownerId: string, ownerType: ParticipantType, filter?: MessageFilter) =>
    messages
      .filter((m) => m.fromId === ownerId && m.fromType === ownerType)
      .filter((m) => !filter?.type || m.type === filter.type)
      .filter((m) => filter?.read === undefined || m.read === filter.read)
      .filter((m) => !m.archived)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, filter?.limit ?? 100));
  const sendMessage = vi.fn(async (input: MessageCreateInput) => {
    const now = new Date().toISOString();
    const message: Message = {
      id: `msg-new-${++counter}`,
      fromId: input.fromId ?? "system",
      fromType: input.fromType ?? "system",
      toId: input.toId,
      toType: input.toType,
      content: input.content,
      type: input.type,
      read: false,
      archived: false,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };
    messages.push(message);
    return message;
  });
  return { store: { getOutbox, sendMessage, getMessage: vi.fn(async () => null) }, getOutbox, sendMessage, messages };
}

function priorOperatorMessage(overrides: Partial<Message> = {}): Message {
  const createdAt = new Date(Date.now() - HOUR_MS).toISOString();
  return {
    id: "msg-prior",
    fromId: "agent-ceo",
    fromType: "agent",
    toId: "dashboard",
    toType: "user",
    content: "Board blocker: landed work not pushed.\nPlease run git push origin main.",
    type: "agent-to-user",
    read: false,
    archived: false,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

const text = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0]!.text;

async function send(store: unknown, params: Record<string, unknown>) {
  const tool = createSendMessageTool(store as never, "agent-ceo");
  return tool.execute("1", params as never, undefined, undefined, {});
}

describe("fn_send_message duplicate operator mail guard", () => {
  it("suppresses a normalized duplicate of an unread operator message and names the earlier id", async () => {
    const fake = createFakeMessageStore([priorOperatorMessage()]);

    const result = await send(fake.store, {
      to_id: "dashboard",
      type: "agent-to-user",
      content: "  board blocker:   landed work not pushed.\n\nPlease run GIT push origin main. ",
    });

    expect(text(result)).toContain("msg-prior");
    expect(text(result)).toMatch(/not sent/i);
    expect((result as { details: Record<string, unknown> }).details).toMatchObject({ suppressed: true, duplicateOfMessageId: "msg-prior" });
    expect(fake.sendMessage).not.toHaveBeenCalled();
  });

  it("suppresses the second of two identical back-to-back operator sends", async () => {
    const fake = createFakeMessageStore();
    const params = { to_id: "dashboard", type: "agent-to-user", content: "Decision needed: push main" };

    const first = await send(fake.store, params);
    const second = await send(fake.store, params);

    expect(text(first)).toContain("Message sent to dashboard (ID: msg-new-1)");
    expect(text(second)).toContain("msg-new-1");
    expect(fake.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the earlier message was read", [priorOperatorMessage({ read: true })], {}],
    ["the earlier message is outside the window", [priorOperatorMessage({ createdAt: new Date(Date.now() - 7 * HOUR_MS).toISOString() })], {}],
    ["the content differs", [priorOperatorMessage()], { content: "Board blocker: landed work not pushed. FN-12 merged since." }],
    ["the recipient differs", [priorOperatorMessage()], { to_id: "cli" }],
    ["the earlier message came from another agent", [priorOperatorMessage({ fromId: "agent-other" })], {}],
  ])("sends when %s", async (_label, seed, overrides) => {
    const fake = createFakeMessageStore(seed);

    const result = await send(fake.store, {
      to_id: "dashboard",
      type: "agent-to-user",
      content: priorOperatorMessage().content,
      ...overrides,
    });

    expect(text(result)).toContain("Message sent to");
    expect(fake.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("treats a different report payload as new content and an identical report as a duplicate", async () => {
    const report = { title: "Board blocker", sections: [{ heading: "Push", body: "main is ahead of origin" }] };
    const fake = createFakeMessageStore([priorOperatorMessage({ content: "See report", metadata: { mailKind: "report", report } })]);

    const changed = await send(fake.store, {
      to_id: "dashboard", type: "agent-to-user", content: "See report", mail_kind: "report",
      report: { ...report, sections: [{ heading: "Push", body: "main is ahead of origin by 3 commits" }] },
    });
    const repeated = await send(fake.store, {
      to_id: "dashboard", type: "agent-to-user", content: "See report", mail_kind: "report", report,
    });

    expect(text(changed)).toContain("Message sent to dashboard");
    expect(text(repeated)).toContain("msg-prior");
    expect(fake.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("never applies to agent-to-agent messages", async () => {
    const fake = createFakeMessageStore();
    const params = { to_id: "agent-b", type: "agent-to-agent", content: "same text" };

    await send(fake.store, params);
    await send(fake.store, params);

    expect(fake.sendMessage).toHaveBeenCalledTimes(2);
    expect(fake.getOutbox).not.toHaveBeenCalled();
  });

  it("still delivers when the duplicate lookup fails", async () => {
    const fake = createFakeMessageStore();
    fake.getOutbox.mockRejectedValueOnce(new Error("db unavailable"));

    const result = await send(fake.store, { to_id: "dashboard", type: "agent-to-user", content: "hello" });

    expect(text(result)).toContain("Message sent to dashboard");
    expect(fake.sendMessage).toHaveBeenCalledTimes(1);
  });
});
