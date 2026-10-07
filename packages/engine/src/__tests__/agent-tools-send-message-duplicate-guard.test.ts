import { describe, expect, it, vi } from "vitest";
import type { Message, MessageCreateInput, MessageFilter, ParticipantType } from "@fusion/core";
import { createSendMessageTool } from "../agent-tools.js";

/**
 * FNXC:OperatorMailDedup 2026-10-07-12:56:
 * A durable heartbeat agent re-sent the same unread operator report every tick.
 * fn_send_message must suppress an exact (whitespace/case-normalized) agent->user duplicate
 * still unread by the same recipient within the window, and leave every other send untouched.
 *
 * FNXC:OperatorMailDedup 2026-10-07-20:48:
 * Replies to different parents are distinct responses and are never suppressed. A structural repeat (same title once counts and timestamps are ignored, same task set) needs an explicit `changes` note.
 * The decision is made by the store's atomic sendMessageUnlessDuplicate seam; the fake below applies the tool's guard the same way the store does.
 */

const HOUR_MS = 60 * 60 * 1000;

function createFakeMessageStore(seed: Message[] = []) {
  const messages = [...seed];
  let counter = 0;
  const outboxRows = (ownerId: string, ownerType: ParticipantType, filter?: MessageFilter) =>
    messages
      .filter((m) => m.fromId === ownerId && m.fromType === ownerType)
      .filter((m) => !filter?.type || m.type === filter.type)
      .filter((m) => filter?.read === undefined || m.read === filter.read)
      .filter((m) => !m.archived)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, filter?.limit ?? 100);
  const getOutbox = vi.fn(async (ownerId: string, ownerType: ParticipantType, filter?: MessageFilter) => outboxRows(ownerId, ownerType, filter));
  const build = (input: MessageCreateInput): Message => {
    const now = new Date().toISOString();
    return {
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
  };
  const sendMessage = vi.fn(async (input: MessageCreateInput) => {
    const message = build(input);
    messages.push(message);
    return message;
  });
  const sendMessageUnlessDuplicate = vi.fn(async (
    input: MessageCreateInput,
    guard: { scan: MessageFilter; isDuplicate: (candidate: Message, prior: Message) => boolean },
  ) => {
    // Scan and insert with no await in between, mirroring the store's atomic check-and-insert.
    const candidate = build(input);
    const priors = outboxRows(candidate.fromId, candidate.fromType, guard.scan);
    const duplicateOf = priors.find((prior) => guard.isDuplicate(candidate, prior));
    if (duplicateOf) return { sent: false as const, duplicateOf };
    messages.push(candidate);
    return { sent: true as const, message: candidate };
  });
  return {
    store: { getOutbox, sendMessage, sendMessageUnlessDuplicate, getMessage: vi.fn(async () => null) },
    getOutbox, sendMessage, sendMessageUnlessDuplicate, messages,
  };
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
    expect(fake.messages).toHaveLength(1);
  });

  it("suppresses the second of two identical back-to-back operator sends", async () => {
    const fake = createFakeMessageStore();
    const params = { to_id: "dashboard", type: "agent-to-user", content: "Decision needed: push main" };

    const first = await send(fake.store, params);
    const second = await send(fake.store, params);

    expect(text(first)).toContain("Message sent to dashboard (ID: msg-new-1)");
    expect(text(second)).toContain("msg-new-1");
    expect(fake.messages).toHaveLength(1);
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
    expect(fake.messages.filter((message) => message.id.startsWith("msg-new-"))).toHaveLength(1);
  });

  it("requires a changes note for a report whose title and tasks match an unread one, and suppresses an identical report", async () => {
    const report = { title: "Board blocker", sections: [{ heading: "Push", body: "main is ahead of origin" }] };
    const fake = createFakeMessageStore([priorOperatorMessage({ content: "See report", metadata: { mailKind: "report", report } })]);
    const reworded = { ...report, sections: [{ heading: "Push", body: "main is ahead of origin by 3 commits" }] };

    const withoutNote = await send(fake.store, { to_id: "dashboard", type: "agent-to-user", content: "See report", mail_kind: "report", report: reworded });
    const repeated = await send(fake.store, { to_id: "dashboard", type: "agent-to-user", content: "See report", mail_kind: "report", report });
    const withNote = await send(fake.store, {
      to_id: "dashboard", type: "agent-to-user", content: "See report", mail_kind: "report", report: reworded, changes: "3 more commits landed on main",
    });

    expect(text(withoutNote)).toMatch(/not sent/i);
    expect(text(withoutNote)).toContain("`changes`");
    expect((withoutNote as { details: Record<string, unknown> }).details).toMatchObject({ suppressed: true, duplicateKind: "structural" });
    expect((repeated as { details: Record<string, unknown> }).details).toMatchObject({ suppressed: true, duplicateKind: "exact" });
    expect(text(withNote)).toContain("Message sent to dashboard");
    expect(fake.messages.at(-1)?.content).toBe("What changed: 3 more commits landed on main\n\nSee report");
  });

  it.each(["dashboard", "cli"])("suppresses a %s report that differs only in counts and timestamps until it names what changed", async (recipient) => {
    const fake = createFakeMessageStore([priorOperatorMessage({ toId: recipient, content: "Push main: 7 tasks waiting (as of 2026-10-07 12:00)\nFN-10, FN-11 are blocked." })]);
    const base = { to_id: recipient, type: "agent-to-user" };

    const countsChanged = await send(fake.store, { ...base, content: "Push main: 8 tasks waiting (as of 2026-10-07 13:00)\nFN-10, FN-11 are blocked." });
    const taskSetChanged = await send(fake.store, { ...base, content: "Push main: 8 tasks waiting (as of 2026-10-07 13:00)\nFN-10, FN-11, FN-12 are blocked." });

    expect((countsChanged as { details: Record<string, unknown> }).details).toMatchObject({ suppressed: true, duplicateKind: "structural", duplicateOfMessageId: "msg-prior" });
    expect(text(taskSetChanged)).toContain(`Message sent to ${recipient}`);
  });

  it("never suppresses identical replies to different parents but suppresses a repeat within one thread", async () => {
    const fake = createFakeMessageStore();
    const reply = (parent: string) => send(fake.store, { to_id: "dashboard", type: "agent-to-user", content: "Done", reply_to_message_id: parent });

    const first = await reply("msg-request-1");
    const second = await reply("msg-request-2");
    const repeatInFirstThread = await reply("msg-request-1");
    const unsolicited = await send(fake.store, { to_id: "dashboard", type: "agent-to-user", content: "Done" });

    expect(text(first)).toContain("Message sent to dashboard");
    expect(text(second)).toContain("Message sent to dashboard");
    expect((repeatInFirstThread as { details: Record<string, unknown> }).details).toMatchObject({ suppressed: true, duplicateOfMessageId: "msg-new-1" });
    expect(text(unsolicited)).toContain("Message sent to dashboard");
    expect(fake.messages.map((message) => message.metadata?.replyTo?.messageId ?? null)).toEqual(["msg-request-1", "msg-request-2", null]);
  });

  it("sends every operator message through the atomic store seam, including concurrent ones", async () => {
    const fake = createFakeMessageStore();
    const params = { to_id: "dashboard", type: "agent-to-user", content: "Decision needed: push main" };

    const results = await Promise.all([send(fake.store, params), send(fake.store, params)]);

    expect(fake.sendMessageUnlessDuplicate).toHaveBeenCalledTimes(2);
    expect(fake.sendMessage).not.toHaveBeenCalled();
    expect(results.filter((result) => text(result).startsWith("Message sent"))).toHaveLength(1);
    expect(fake.messages).toHaveLength(1);
  });

  it("never applies to agent-to-agent messages", async () => {
    const fake = createFakeMessageStore();
    const params = { to_id: "agent-b", type: "agent-to-agent", content: "same text" };

    await send(fake.store, params);
    await send(fake.store, params);

    expect(fake.sendMessage).toHaveBeenCalledTimes(2);
    expect(fake.sendMessageUnlessDuplicate).not.toHaveBeenCalled();
  });

  it("reports a store failure as a failed send instead of delivering without the guard", async () => {
    const fake = createFakeMessageStore();
    fake.sendMessageUnlessDuplicate.mockRejectedValueOnce(new Error("db unavailable"));

    const failed = await send(fake.store, { to_id: "dashboard", type: "agent-to-user", content: "hello" });
    const retried = await send(fake.store, { to_id: "dashboard", type: "agent-to-user", content: "hello" });

    expect(text(failed)).toContain("ERROR: Failed to send message: db unavailable");
    expect(fake.sendMessage).not.toHaveBeenCalled();
    expect(text(retried)).toContain("Message sent to dashboard");
    expect(fake.messages).toHaveLength(1);
  });
});
