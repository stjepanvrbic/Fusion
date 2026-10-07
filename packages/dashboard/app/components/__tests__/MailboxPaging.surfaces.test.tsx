import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Message } from "@fusion/core";
import { MailboxView } from "../MailboxView";
import { MailboxModal } from "../MailboxModal";
import { useViewportMode } from "../../hooks/useViewportMode";
import { useViewportMode as useHeaderViewportMode } from "../Header";

vi.mock("../../api", () => ({
  fetchInbox: vi.fn(), fetchOutbox: vi.fn(), fetchUnreadCount: vi.fn(), fetchAgentMailbox: vi.fn(), fetchAllAgentMailbox: vi.fn(),
  markMessageRead: vi.fn(), markAllMessagesRead: vi.fn(), deleteMessage: vi.fn(), fetchConversation: vi.fn(), fetchMessage: vi.fn(),
  sendMessage: vi.fn(), fetchAgents: vi.fn(), fetchApprovals: vi.fn(), fetchApprovalDetail: vi.fn(), decideApproval: vi.fn(),
  artifactMediaUrlWithToken: vi.fn(), fetchNativeStructurePreview: vi.fn(), fetchTaskDetail: vi.fn(), createTaskFromRecommendation: vi.fn(),
  fetchRecommendationEligibility: vi.fn(), archiveMessage: vi.fn(), unarchiveMessage: vi.fn(),
}));
vi.mock("../../hooks/useViewportMode", () => ({ useViewportMode: vi.fn(() => "desktop"), isMobileViewport: () => false, isFullScreenSheetViewport: () => false, isShortViewport: () => false, getViewportMode: () => "desktop", isTabletTouchViewport: () => false }));
vi.mock("../../hooks/useMobileKeyboard", () => ({ useMobileKeyboard: vi.fn(() => ({ keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0, keyboardOpen: false })) }));
vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => () => {}) }));
vi.mock("../Header", () => ({ useViewportMode: vi.fn(() => "desktop") }));
vi.mock("../ComposeChatPanel", () => ({ ComposeChatPanel: () => null }));
vi.mock("lucide-react", () => ({ Mail: () => null, Send: () => null, Inbox: () => null, Bot: () => null, Trash2: () => null, Archive: () => null, CheckCheck: () => null, Loader2: () => null, RefreshCw: () => null, MessageSquare: () => null, User: () => null, X: () => null, Check: () => null, ChevronRight: () => null, ChevronDown: () => null, AlertCircle: () => null, Map: () => null, Flag: () => null, Lightbulb: () => null, BarChart3: () => null, Target: () => null, CircleAlert: () => null }));

import * as api from "../../api";

/*
FNXC:Mailbox 2026-10-07-20:25:
Older mail must stay reachable in both mailbox hosts at both breakpoints: Load more appears exactly while the server reports another page, appends the next page in order, and a deep link to a message past the loaded pages opens it directly.
*/

const agents = [{ id: "agent-1", name: "Agent", role: "executor", state: "idle", createdAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T00:00:00.000Z", metadata: {} }];

function mail(id: string, direction: "in" | "out", archived = false): Message {
  return {
    id, content: `Body ${id}`, type: direction === "in" ? "agent-to-user" : "user-to-agent", read: true, archived,
    fromId: direction === "in" ? "agent-1" : "dashboard", fromType: direction === "in" ? "agent" : "user",
    toId: direction === "in" ? "dashboard" : "agent-1", toType: direction === "in" ? "user" : "agent",
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
  } as Message;
}

function pagedBox(prefix: string, count: number, direction: "in" | "out", archived = false) {
  const rows = Array.from({ length: count }, (_, index) => mail(`${prefix}-${index}`, direction, archived));
  return (options?: { limit?: number; offset?: number; archived?: boolean }) => {
    if ((options?.archived === true) !== archived) return { messages: [], total: 0, hasMore: false, unreadCount: 0 };
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 20;
    const messages = rows.slice(offset, offset + limit);
    return { messages, total: rows.length, hasMore: offset + messages.length < rows.length, unreadCount: 0 };
  };
}

const hosts = [
  ["MailboxView", "desktop", (props: Record<string, unknown>) => <MailboxView {...props} />],
  ["MailboxView", "mobile", (props: Record<string, unknown>) => <MailboxView {...props} />],
  ["MailboxModal", "desktop", (props: Record<string, unknown>) => <MailboxModal isOpen onClose={vi.fn()} agents={agents as never} {...props} />],
  ["MailboxModal", "mobile", (props: Record<string, unknown>) => <MailboxModal isOpen onClose={vi.fn()} agents={agents as never} {...props} />],
] as const;

function renderHost(Host: (typeof hosts)[number][2], viewport: "desktop" | "mobile") {
  vi.mocked(useViewportMode).mockReturnValue(viewport);
  vi.mocked(useHeaderViewportMode).mockReturnValue(viewport);
  render(<Host projectId="project-1" addToast={vi.fn()} onOpenNativeStructure={vi.fn()} nativeStructureCandidates={[]} />);
}

describe("mailbox paging production surfaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    vi.mocked(api.fetchUnreadCount).mockResolvedValue({ unreadCount: 0 });
    vi.mocked(api.fetchAgents).mockResolvedValue(agents as never);
    vi.mocked(api.fetchAllAgentMailbox).mockResolvedValue({ messages: [], total: 0, unreadCount: 0 } as never);
    vi.mocked(api.fetchConversation).mockResolvedValue([]);
    vi.mocked(api.fetchOutbox).mockImplementation(async (options) => pagedBox("out", 0, "out")(options) as never);
  });
  afterEach(() => window.history.replaceState(null, "", "/"));

  it.each(hosts)("pages a 120-message inbox in %s %s until the last message is reachable", async (_name, viewport, Host) => {
    vi.mocked(api.fetchInbox).mockImplementation(async (options) => pagedBox("in", 120, "in")(options) as never);
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    renderHost(Host, viewport);

    await screen.findByTestId("mailbox-item-in-49");
    expect(screen.queryByTestId("mailbox-item-in-50")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("mailbox-inbox-load-more"));
    await screen.findByTestId("mailbox-item-in-99");
    expect(api.fetchInbox).toHaveBeenCalledWith(expect.objectContaining({ limit: 50, offset: 50 }), "project-1");
    await user.click(screen.getByTestId("mailbox-inbox-load-more"));
    await screen.findByTestId("mailbox-item-in-119");
    expect(screen.queryByTestId("mailbox-inbox-load-more")).not.toBeInTheDocument();
    const ids = screen.getAllByTestId(/^mailbox-item-in-\d+$/).map((element) => element.getAttribute("data-testid"));
    expect(ids).toEqual(Array.from({ length: 120 }, (_, index) => `mailbox-item-in-${index}`));
  });

  it.each(hosts.flatMap(([name, viewport, Host]) => [0, 50].map((count) => [name, viewport, count, Host] as const)))(
    "offers no Load more in %s %s for a %i-message inbox",
    async (_name, viewport, count, Host) => {
      vi.mocked(api.fetchInbox).mockImplementation(async (options) => pagedBox("in", count, "in")(options) as never);
      renderHost(Host, viewport);
      if (count === 0) await screen.findByTestId("mailbox-inbox-empty");
      else await screen.findByTestId(`mailbox-item-in-${count - 1}`);
      expect(screen.queryByTestId("mailbox-inbox-load-more")).not.toBeInTheDocument();
    },
  );

  it.each(hosts)("pages the outbox in %s %s", async (_name, viewport, Host) => {
    vi.mocked(api.fetchInbox).mockImplementation(async (options) => pagedBox("in", 1, "in")(options) as never);
    vi.mocked(api.fetchOutbox).mockImplementation(async (options) => pagedBox("out", 51, "out")(options) as never);
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    renderHost(Host, viewport);
    await screen.findByTestId("mailbox-item-in-0");
    await user.click(screen.getByTestId("mailbox-tab-outbox"));
    await screen.findByTestId("mailbox-item-out-49");
    await user.click(screen.getByTestId("mailbox-outbox-load-more"));
    await screen.findByTestId("mailbox-item-out-50");
    expect(screen.queryByTestId("mailbox-outbox-load-more")).not.toBeInTheDocument();
  });

  it.each(hosts)("pages archived inbox and outbox mail in %s %s", async (_name, viewport, Host) => {
    const archivedInbox = pagedBox("arch-in", 60, "in", true);
    const activeInbox = pagedBox("in", 1, "in");
    vi.mocked(api.fetchInbox).mockImplementation(async (options) => (options?.archived ? archivedInbox(options) : activeInbox(options)) as never);
    vi.mocked(api.fetchOutbox).mockImplementation(async (options) => pagedBox("arch-out", 3, "out", true)(options) as never);
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    renderHost(Host, viewport);
    await screen.findByTestId("mailbox-item-in-0");
    await user.click(screen.getByTestId("mailbox-tab-archived"));
    await screen.findByTestId("mailbox-item-arch-in-49");
    expect(screen.getByTestId("mailbox-item-arch-out-2")).toBeInTheDocument();
    await user.click(screen.getByTestId("mailbox-archived-load-more"));
    await screen.findByTestId("mailbox-item-arch-in-59");
    expect(api.fetchInbox).toHaveBeenCalledWith(expect.objectContaining({ archived: true, offset: 50 }), "project-1");
    expect(screen.queryByTestId("mailbox-archived-load-more")).not.toBeInTheDocument();
  });

  it.each(hosts)("opens a deep link to a message past the loaded pages in %s %s", async (_name, viewport, Host) => {
    vi.mocked(api.fetchInbox).mockImplementation(async (options) => pagedBox("in", 120, "in")(options) as never);
    const older = { ...mail("in-110", "in"), content: "Older recommendation notice" };
    vi.mocked(api.fetchMessage).mockResolvedValue(older);
    window.history.replaceState(null, "", "/?mailbox-message=in-110");
    renderHost(Host, viewport);
    await waitFor(() => expect(api.fetchMessage).toHaveBeenCalledWith("in-110", "project-1"));
    expect(await screen.findAllByText("Older recommendation notice")).not.toHaveLength(0);
    expect(api.fetchMessage).toHaveBeenCalledTimes(1);
  });
});
