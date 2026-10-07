import { useTranslation } from "react-i18next";
import type { Message } from "@fusion/core";
import { fetchAllAgentMailbox, fetchInbox, fetchOutbox } from "../api";

/*
FNXC:Mailbox 2026-10-07-20:20:
Both mailbox hosts (MailboxView and MailboxModal) page inbox, outbox and archived mail in fixed-size pages and offer Load more while the server reports hasMore.
Before this, each host requested only the first 50 messages with no way to reach older mail, so the 51st newest report or recommendation notice disappeared from navigation.
*/
export const MAILBOX_PAGE_SIZE = 50;

/** Append a later page, keeping existing order and dropping messages already loaded (a new message can shift offsets between requests). */
export function mergeMailboxPage<T extends { messages: Message[] }>(current: T | null, page: T): T {
  if (!current) return page;
  return { ...page, messages: dedupeById([...current.messages, ...page.messages]) };
}

/** Page size for a refresh that keeps every page the operator already loaded on screen. */
export function mailboxRefreshLimit(loadedCount: number | undefined): number {
  return Math.max(MAILBOX_PAGE_SIZE, loadedCount ?? 0);
}

/**
 * Archived mail combines the archived inbox, archived outbox and archived agent mail so archiving never strands a message outside its restore view.
 * The inbox and outbox parts page independently; agent mail is fetched whole, as before.
 */
export interface ArchivedMailboxState {
  messages: Message[];
  hasMore: boolean;
  inboxLoaded: number;
  outboxLoaded: number;
  inboxHasMore: boolean;
  outboxHasMore: boolean;
}

function dedupeById(messages: Message[]): Message[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

/** Reload archived mail, keeping as many inbox and outbox rows as were already on screen. */
export async function loadArchivedMailbox(projectId: string | undefined, current: ArchivedMailboxState | null): Promise<ArchivedMailboxState> {
  const [inbox, outbox, agentMailbox] = await Promise.all([
    fetchInbox({ limit: mailboxRefreshLimit(current?.inboxLoaded), archived: true }, projectId),
    fetchOutbox({ limit: mailboxRefreshLimit(current?.outboxLoaded), archived: true }, projectId),
    fetchAllAgentMailbox(projectId, { archived: true }),
  ]);
  return {
    messages: dedupeById([...inbox.messages, ...outbox.messages, ...agentMailbox.messages]),
    hasMore: inbox.hasMore || outbox.hasMore,
    inboxLoaded: inbox.messages.length,
    outboxLoaded: outbox.messages.length,
    inboxHasMore: inbox.hasMore,
    outboxHasMore: outbox.hasMore,
  };
}

/** Fetch the next archived inbox and/or outbox page and append it. */
export async function loadMoreArchivedMailbox(projectId: string | undefined, current: ArchivedMailboxState): Promise<ArchivedMailboxState> {
  const [inbox, outbox] = await Promise.all([
    current.inboxHasMore ? fetchInbox({ limit: MAILBOX_PAGE_SIZE, offset: current.inboxLoaded, archived: true }, projectId) : null,
    current.outboxHasMore ? fetchOutbox({ limit: MAILBOX_PAGE_SIZE, offset: current.outboxLoaded, archived: true }, projectId) : null,
  ]);
  const inboxHasMore = inbox ? inbox.hasMore : false;
  const outboxHasMore = outbox ? outbox.hasMore : false;
  return {
    messages: dedupeById([...current.messages, ...(inbox?.messages ?? []), ...(outbox?.messages ?? [])]),
    hasMore: inboxHasMore || outboxHasMore,
    inboxLoaded: current.inboxLoaded + (inbox?.messages.length ?? 0),
    outboxLoaded: current.outboxLoaded + (outbox?.messages.length ?? 0),
    inboxHasMore,
    outboxHasMore,
  };
}

export function MailboxLoadMore({ loading, onLoadMore, testId }: { loading: boolean; onLoadMore: () => void; testId: string }) {
  const { t } = useTranslation("app");
  return (
    <div className="mailbox-load-more">
      <button type="button" className="btn btn-sm btn-secondary" disabled={loading} onClick={onLoadMore} data-testid={testId}>
        {loading ? t("mailbox.loadingMore", "Loading more…") : t("mailbox.loadMore", "Load more")}
      </button>
    </div>
  );
}
