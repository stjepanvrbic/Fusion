import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { ExternalBlockNotice } from "../TaskCard";
import { readAppFile } from "../../test/cssFixture";

vi.mock("../ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../PrCreateModal", () => ({ PrCreateModal: () => null }));
vi.mock("../../hooks/useTaskDiffStats", () => ({ useTaskDiffStats: () => ({ stats: null, loading: false }) }));
vi.mock("../../hooks/useBadgeWebSocket", () => ({ useBadgeWebSocket: () => ({ badgeUpdates: new Map(), isConnected: true, subscribeToBadge: vi.fn(), unsubscribeFromBadge: vi.fn() }) }));
vi.mock("../../hooks/useBatchBadgeFetch", () => ({ getFreshBatchData: vi.fn(() => null) }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn(), confirmWithChoice: vi.fn() }) }));
vi.mock("../../api", () => ({ fetchWorkflowSettingValues: vi.fn().mockResolvedValue({ stored: {}, effective: {}, orphaned: [] }) }));

const blocked = {
  id: "FN-209", title: "Blocked", description: "", column: "in-progress", dependencies: [], steps: [], currentStep: 0,
  status: "blocked", paused: true, pausedReason: "external-block",
  externalBlock: { origin: "network", code: "ETIMEDOUT", message: "connection timed out", source: "session-failure", blockedAt: "2026-08-28T00:00:00.000Z", resume: { column: "in-progress", currentStep: 0 } },
} as Task;

describe("ListView external-block surfaces", () => {
  it("renders the list notice actions with the raw reason", () => {
    const explain = vi.fn();
    render(<ExternalBlockNotice task={blocked} variant="list" onOpenChatWithPrefill={explain} onRetryTask={vi.fn()} />);
    expect(screen.getByTestId("external-block-list-FN-209")).toHaveTextContent("ETIMEDOUT: connection timed out");
    fireEvent.click(screen.getByRole("button", { name: "Explain this error" }));
    expect(explain).toHaveBeenCalledWith(expect.stringContaining("ETIMEDOUT: connection timed out"));
  });

  it("renders a decision wait in the list notice with its question, no fault code and no explanation button", () => {
    const retry = vi.fn().mockResolvedValue(blocked);
    const waiting = {
      ...blocked,
      externalBlock: {
        ...blocked.externalBlock!, origin: "human-decision", code: "DECISION_REQUIRED", source: "agent-declaration", message: "Awaiting the owner's choice.",
        report: { verifiedCondition: "No choice is recorded.", stopReason: "Paused.", unimplementedWork: "Steps 2-8.", unblockCondition: "Record the option in a comment, then retry.", question: "Which option should this task implement?" },
      },
    } as Task;
    render(<ExternalBlockNotice task={waiting} variant="list" onOpenChatWithPrefill={vi.fn()} onRetryTask={retry} />);
    const notice = screen.getByTestId("external-block-list-FN-209");

    expect(notice).toHaveTextContent("Waiting for a decision");
    expect(notice).toHaveTextContent("Which option should this task implement?");
    expect(notice).toHaveTextContent("To resume: Record the option in a comment, then retry.");
    expect(notice).not.toHaveTextContent("DECISION_REQUIRED");
    expect(notice).not.toHaveTextContent("Blocked");
    expect(screen.queryByRole("button", { name: "Explain this error" })).toBeNull();
    expect(notice.querySelectorAll("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledWith("FN-209");
  });

  it("passes the decision-wait flag to the status badge in both list layouts", () => {
    const source = readAppFile("components/ListView.tsx");
    const badgeContexts = source.match(/externalBlocked: task\.status === "blocked"[^}]*\}/g) ?? [];

    expect(badgeContexts).toHaveLength(2);
    for (const context of badgeContexts) expect(context).toContain("awaitingDecision: isTaskAwaitingDecision(task)");
  });

  it("keeps both grouped-card and table-row render branches wired to the shared notice", () => {
    const source = readAppFile("components/ListView.tsx");
    const notices = source.match(/<ExternalBlockNotice task=\{task\} variant="list"[^>]*\/>/g) ?? [];
    expect(notices).toHaveLength(2);
    const firstNotice = source.indexOf(notices[0]);
    const secondNotice = source.indexOf(notices[1], firstNotice + notices[0].length);
    const table = source.indexOf("<table className=\"list-table\"");
    expect(firstNotice).toBeLessThan(table);
    expect(secondNotice).toBeGreaterThan(table);
  });
});
