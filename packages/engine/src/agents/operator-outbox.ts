import type { MailReport, Message, MessageFilter } from "@fusion/core";

/*
FNXC:OperatorMailDedup 2026-10-07-12:56:
A durable heartbeat agent sent seven near-identical operator reports in seven hours because fn_read_messages shows only its inbox, so it never saw what it had already told the operator.
Two deterministic seams close that gap: every heartbeat prompt lists the agent's own recent agent->user mail (titles only, bounded), and fn_send_message refuses a duplicate the recipient has not read yet.
Semantic dedupe ("same blocker, reworded title") stays the model's job, informed by the prompt listing.

FNXC:OperatorMailDedup 2026-10-07-20:39:
The guard keys on thread plus content: a reply to one parent never suppresses a reply to a different parent, so identical "Done" replies to two separate requests are both delivered.
Beyond the exact repeat it catches the structural repeat typical heartbeat reports produce: same mail kind, same title once counts and timestamps are ignored, and the same referenced task set. Such a send is refused unless it carries an explicit note of what changed, so a legitimate new report stays deliverable.
The check and the insert run atomically at the message-store seam (sendMessageUnlessDuplicate), so concurrent sessions sharing an agent identity cannot both deliver the same report.
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

/** Task-style identifiers (FN-123, KB-003) referenced anywhere in the body or report. */
const TASK_ID_PATTERN = /\b[A-Z][A-Z0-9]*-\d+\b/g;

function referencedTaskIds(content: string, report?: MailReport): string[] {
  const text = [content, report?.title ?? "", ...(report?.sections ?? []).flatMap((section) => [section.heading, section.body])].join("\n");
  return [...new Set(text.match(TASK_ID_PATTERN) ?? [])].sort();
}

/**
 * Identity of a report that is stable under changing counts and timestamps: mail kind, the title with task ids removed and digit runs collapsed, and the referenced task id set.
 * "Push main: 7 tasks waiting" and "Push main: 8 tasks waiting" share a key; a report about a different task set does not.
 */
export function operatorMailStructuralKey(content: string, report?: MailReport, mailKind?: string): string {
  const rawTitle = report?.title?.trim() || (content.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "");
  const title = collapseWhitespace(rawTitle.replace(TASK_ID_PATTERN, " ").replace(/\d+/g, "#")).toLowerCase();
  return `${mailKind ?? "message"}\u0001${title}\u0001${referencedTaskIds(content, report).join(",")}`;
}

/** The parent a message replies to; unsolicited mail has no thread. */
function threadOf(message: Message): string | null {
  return message.metadata?.replyTo?.messageId ?? null;
}

export type OperatorMailDuplicateKind = "exact" | "structural";

/**
 * Classify whether `prior` makes `candidate` a duplicate agent->user send.
 * Never a duplicate when the prior was read, went to another recipient, is outside the window, or belongs to a different reply thread.
 * A structural match counts only when the candidate carries no change note.
 */
export function classifyOperatorMailDuplicate(
  candidate: Message,
  prior: Message,
  options: { hasChangeNote: boolean; nowMs?: number },
): OperatorMailDuplicateKind | null {
  if (prior.read || prior.type !== "agent-to-user" || prior.toId !== candidate.toId) return null;
  if (Date.parse(prior.createdAt) < (options.nowMs ?? Date.now()) - DUPLICATE_OPERATOR_MESSAGE_WINDOW_MS) return null;
  if (threadOf(prior) !== threadOf(candidate)) return null;
  const candidateReport = candidate.metadata?.report;
  const priorReport = prior.metadata?.report;
  if (operatorMessageFingerprint(candidate.content, candidateReport) === operatorMessageFingerprint(prior.content, priorReport)) {
    return "exact";
  }
  if (!options.hasChangeNote
    && operatorMailStructuralKey(candidate.content, candidateReport, candidate.metadata?.mailKind)
      === operatorMailStructuralKey(prior.content, priorReport, prior.metadata?.mailKind)) {
    return "structural";
  }
  return null;
}

/** Store guard for `MessageStore.sendMessageUnlessDuplicate`: scans the sender's unread operator mail and applies `classifyOperatorMailDuplicate`. */
export function operatorMailDuplicateGuard(options: { hasChangeNote: boolean; nowMs?: number }): {
  scan: MessageFilter;
  isDuplicate: (candidate: Message, prior: Message) => boolean;
} {
  return {
    scan: { type: "agent-to-user", read: false, limit: DUPLICATE_OPERATOR_MESSAGE_SCAN_LIMIT },
    isDuplicate: (candidate, prior) => classifyOperatorMailDuplicate(candidate, prior, options) !== null,
  };
}
