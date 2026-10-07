import type { MailReport, Message, MessageStore } from "@fusion/core";

/*
FNXC:OperatorMailDedup 2026-10-07-12:56:
A durable heartbeat agent sent seven near-identical operator reports in seven hours because fn_read_messages shows only its inbox, so it never saw what it had already told the operator.
Two deterministic seams close that gap: every heartbeat prompt lists the agent's own recent agent->user mail (titles only, bounded), and fn_send_message refuses an exact normalized duplicate the recipient has not read yet.
Semantic dedupe ("same blocker, reworded title") stays the model's job, informed by the prompt listing; the send guard only catches literal repeats.
*/

/** Heartbeat outbox listing covers the last 24h of the agent's operator mail. */
export const RECENT_OPERATOR_OUTBOX_WINDOW_MS = 24 * 60 * 60 * 1000;
/** At most this many outbox entries reach the prompt; also the store LIMIT. */
export const RECENT_OPERATOR_OUTBOX_MAX_ENTRIES = 5;
/** Per-entry title cap; full message bodies never enter the prompt. */
export const RECENT_OPERATOR_OUTBOX_TITLE_MAX_CHARS = 120;
/** An identical unread agent->user send within this window is suppressed. */
export const DUPLICATE_OPERATOR_MESSAGE_WINDOW_MS = 6 * 60 * 60 * 1000;
/** Unread outbox rows scanned for a duplicate; bounded single indexed query. */
const DUPLICATE_OPERATOR_MESSAGE_SCAN_LIMIT = 20;

const collapseWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

function truncateTitle(value: string): string {
  const collapsed = collapseWhitespace(value);
  return collapsed.length > RECENT_OPERATOR_OUTBOX_TITLE_MAX_CHARS
    ? `${collapsed.slice(0, RECENT_OPERATOR_OUTBOX_TITLE_MAX_CHARS - 1)}…`
    : collapsed;
}

/** A report's title, else the first non-empty line of the body. */
function messageTitle(message: Message): string {
  const reportTitle = message.metadata?.report?.title?.trim();
  if (reportTitle) return truncateTitle(reportTitle);
  const firstLine = message.content.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  return truncateTitle(firstLine);
}

/**
 * Render the "Your Recent Operator Messages" heartbeat prompt section from the agent's outbox.
 * Keeps only agent->user rows inside the 24h window, newest first, capped at five entries with one truncated title line each.
 * Returns no lines when nothing qualifies so the prompt omits the section entirely.
 */
export function buildRecentOperatorOutboxLines(messages: readonly Message[], nowMs: number = Date.now()): string[] {
  const cutoffMs = nowMs - RECENT_OPERATOR_OUTBOX_WINDOW_MS;
  const recent = messages
    .filter((message) => message.type === "agent-to-user" && Date.parse(message.createdAt) >= cutoffMs)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, RECENT_OPERATOR_OUTBOX_MAX_ENTRIES);
  if (recent.length === 0) return [];
  return [
    "",
    "## Your Recent Operator Messages",
    "Already sent by you to humans in the last 24h, newest first. Do not message the operator again about a blocker listed here unless the facts changed; if they did, say exactly what changed.",
    ...recent.map((message) => {
      const sentAt = `${message.createdAt.slice(0, 16).replace("T", " ")}Z`;
      const kind = message.metadata?.mailKind ?? "message";
      return `- [id: ${message.id}] ${sentAt} · to ${message.toId} · ${message.read ? "read" : "unread"} · ${kind} · ${messageTitle(message)}`;
    }),
  ];
}

/** Whitespace- and case-insensitive identity of a message body plus its structured report. */
export function operatorMessageFingerprint(content: string, report?: MailReport): string {
  const normalizedReport = report
    ? [report.title, ...report.sections.flatMap((section) => [section.heading, section.body])].map(collapseWhitespace).join("\u0000")
    : "";
  return `${collapseWhitespace(content).toLowerCase()}\u0001${normalizedReport.toLowerCase()}`;
}

/**
 * Find the newest unread agent->user message from `fromAgentId` to `toId` inside the duplicate window whose fingerprint equals the candidate send.
 * Read messages, older messages, other recipients, and other senders never match: a read report means the operator has seen it, so a repeat is a deliberate re-ping.
 */
export async function findUnreadDuplicateOperatorMessage(
  messageStore: Pick<MessageStore, "getOutbox">,
  candidate: { fromAgentId: string; toId: string; content: string; report?: MailReport; nowMs?: number },
): Promise<Message | null> {
  const cutoffMs = (candidate.nowMs ?? Date.now()) - DUPLICATE_OPERATOR_MESSAGE_WINDOW_MS;
  const fingerprint = operatorMessageFingerprint(candidate.content, candidate.report);
  const unread = await messageStore.getOutbox(candidate.fromAgentId, "agent", {
    type: "agent-to-user",
    read: false,
    limit: DUPLICATE_OPERATOR_MESSAGE_SCAN_LIMIT,
  });
  return unread.find((message) =>
    !message.read
    && message.toId === candidate.toId
    && Date.parse(message.createdAt) >= cutoffMs
    && operatorMessageFingerprint(message.content, message.metadata?.report) === fingerprint,
  ) ?? null;
}
