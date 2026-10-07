import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MessageMetadata } from "@fusion/core";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { createTaskFromRecommendation, fetchRecommendationEligibility, fetchTaskDetail } from "../../api";
import { MailboxTaskRecommendations } from "../MailboxTaskRecommendations";
import { ApiRequestError } from "../../api/client/client";

vi.mock("../../api", () => ({ createTaskFromRecommendation: vi.fn(), fetchTaskDetail: vi.fn(), fetchRecommendationEligibility: vi.fn() }));

const metadata: MessageMetadata = { kind: "task-recommendation-notice", taskId: "FN-9100", recommendationCount: 1, recommendationIds: ["recommendation-1"], categories: ["feature"], recommendationSnapshot: [{ id: "recommendation-1", title: "Saved follow up", description: "Saved optional work.", category: "feature" }] };
const legacyMetadata: MessageMetadata = { kind: "task-recommendation-notice", taskId: "FN-9100", recommendationCount: 1, categories: ["feature"] };
const detail = { id: "FN-9100", recommendations: [{ id: "recommendation-1", title: "Follow up", description: "Finish the optional work.", category: "feature" }] };

function expectMailboxCardWithoutBoardClass(): void {
  const card = screen.getByTestId("mailbox-task-recommendations").querySelector("article");
  expect(card).toHaveClass("mailbox-task-recommendations__item");
  expect(card).not.toHaveClass("card");
}

describe("MailboxTaskRecommendations", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(fetchRecommendationEligibility).mockResolvedValue({ actionable: true, reason: null });
  });

  it("renders nothing for non-notices, missing parents, malformed ids, and empty recommendation ids", () => {
    for (const candidate of [{}, { kind: "task-recommendation-notice", recommendationIds: ["recommendation-1"] }, { kind: "task-recommendation-notice", taskId: "FN-9100", recommendationIds: [] }, { kind: "task-recommendation-notice", taskId: "FN-9100", recommendationIds: [null] }, { kind: "task-recommendation-notice", taskId: "FN-9100", recommendationIds: "recommendation-1" }]) {
      const { container, unmount } = render(<MailboxTaskRecommendations metadata={candidate} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("renders a saved informational fallback after a failed parent lookup", async () => {
    vi.mocked(fetchTaskDetail).mockRejectedValue(new Error("not found"));
    render(<MailboxTaskRecommendations metadata={metadata} />);
    expect(await screen.findByText("Saved follow up")).toBeInTheDocument();
    expect(screen.getByText("Saved optional work.")).toBeInTheDocument();
    expect(screen.getByText("Saved recommendation")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Create task|View task|Retry/i })).not.toBeInTheDocument();
  });

  it("renders a saved informational fallback when live recommendation ids are replaced", async () => {
    vi.mocked(fetchTaskDetail).mockResolvedValue({ ...detail, recommendations: [] } as never);
    render(<MailboxTaskRecommendations metadata={metadata} />);
    expect(await screen.findByText("Saved follow up")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Create task|View task|Retry/i })).not.toBeInTheDocument();
  });

  it("creates once and replaces the action with the linked task", async () => {
    const onOpenTask = vi.fn();
    vi.mocked(fetchTaskDetail).mockResolvedValue(detail as never);
    vi.mocked(createTaskFromRecommendation).mockResolvedValue({ task: { id: "FN-9101" }, parent: detail } as never);
    render(<MailboxTaskRecommendations metadata={metadata} projectId="project-1" onOpenTask={onOpenTask} />);
    await screen.findByRole("button", { name: "Create task" });
    expectMailboxCardWithoutBoardClass();
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "View task FN-9101" })).toBeInTheDocument());
    expect(createTaskFromRecommendation).toHaveBeenCalledWith("FN-9100", "recommendation-1", "project-1");
    fireEvent.click(screen.getByRole("button", { name: "View task FN-9101" }));
    expect(onOpenTask).toHaveBeenCalledWith("FN-9101");
  });

  it("resolves legacy metadata from live recommendations and creates a linked task", async () => {
    const onOpenTask = vi.fn();
    vi.mocked(fetchTaskDetail).mockResolvedValue(detail as never);
    vi.mocked(createTaskFromRecommendation).mockResolvedValue({ task: { id: "FN-9101" }, parent: detail } as never);
    render(<MailboxTaskRecommendations metadata={legacyMetadata} projectId="project-1" onOpenTask={onOpenTask} />);
    fireEvent.click(await screen.findByRole("button", { name: "Create task" }));
    await screen.findByRole("button", { name: "View task FN-9101" });
    expect(fetchTaskDetail).toHaveBeenCalledWith("FN-9100", "project-1");
    expect(createTaskFromRecommendation).toHaveBeenCalledTimes(1);
    expect(createTaskFromRecommendation).toHaveBeenCalledWith("FN-9100", "recommendation-1", "project-1");
    fireEvent.click(screen.getByRole("button", { name: "View task FN-9101" }));
    expect(onOpenTask).toHaveBeenCalledWith("FN-9101");
  });

  it("keeps modern notices scoped to their named live recommendation ids", async () => {
    vi.mocked(fetchTaskDetail).mockResolvedValue({
      ...detail,
      recommendations: [...detail.recommendations, { id: "recommendation-2", title: "Unreferenced", description: "Do not show this.", category: "bug" }],
    } as never);
    render(<MailboxTaskRecommendations metadata={metadata} />);
    expect(await screen.findByText("Follow up")).toBeInTheDocument();
    expect(screen.queryByText("Unreferenced")).not.toBeInTheDocument();
  });

  it("shows existing links without a duplicate Create action", async () => {
    vi.mocked(fetchTaskDetail).mockResolvedValue({ ...detail, recommendations: [{ ...detail.recommendations[0], createdTaskId: "FN-9101" }] } as never);
    render(<MailboxTaskRecommendations metadata={metadata} />);
    expect(await screen.findByRole("button", { name: "View task FN-9101" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create task" })).not.toBeInTheDocument();
    expectMailboxCardWithoutBoardClass();
  });

  it("guards rapid duplicate clicks", async () => {
    vi.mocked(fetchTaskDetail).mockResolvedValue(detail as never);
    let resolveCreate!: (value: never) => void;
    vi.mocked(createTaskFromRecommendation).mockImplementation(() => new Promise((resolve) => { resolveCreate = resolve; }));
    render(<MailboxTaskRecommendations metadata={metadata} />);
    await screen.findByRole("button", { name: "Create task" });
    const button = screen.getByRole("button", { name: "Create task" });
    fireEvent.click(button);
    expectMailboxCardWithoutBoardClass();
    fireEvent.click(button);
    expect(createTaskFromRecommendation).toHaveBeenCalledTimes(1);
    resolveCreate({ task: { id: "FN-9101" }, parent: detail } as never);
    await screen.findByRole("button", { name: "View task FN-9101" });
  });

  it("offers a retry after a rejected creation", async () => {
    vi.mocked(fetchTaskDetail).mockResolvedValue(detail as never);
    vi.mocked(createTaskFromRecommendation).mockRejectedValueOnce(new Error("conflict")).mockResolvedValueOnce({ task: { id: "FN-9101" }, parent: detail } as never);
    render(<MailboxTaskRecommendations metadata={metadata} />);
    fireEvent.click(await screen.findByRole("button", { name: "Create task" }));
    expect(await screen.findByRole("button", { name: "Retry creating task" })).toBeInTheDocument();
    expect(screen.getByText("Could not create task. Try again.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry creating task" }));
    expect(await screen.findByRole("button", { name: "View task FN-9101" })).toBeInTheDocument();
    expect(createTaskFromRecommendation).toHaveBeenCalledTimes(2);
    expectMailboxCardWithoutBoardClass();
  });

  it("shows the server's refusal reason instead of a generic retry prompt", async () => {
    vi.mocked(fetchTaskDetail).mockResolvedValue(detail as never);
    vi.mocked(createTaskFromRecommendation).mockRejectedValueOnce(new ApiRequestError("Recommendations from FN-9100 can be filed as tasks after FN-9100 lands or completes", 409));
    render(<MailboxTaskRecommendations metadata={metadata} />);
    fireEvent.click(await screen.findByRole("button", { name: "Create task" }));
    expect(await screen.findByText("Recommendations from FN-9100 can be filed as tasks after FN-9100 lands or completes")).toBeInTheDocument();
    expect(screen.queryByText("Could not create task. Try again.")).not.toBeInTheDocument();
  });

  it("keeps the generic retry prompt for transport and server failures", async () => {
    vi.mocked(fetchTaskDetail).mockResolvedValue(detail as never);
    vi.mocked(createTaskFromRecommendation).mockRejectedValueOnce(new ApiRequestError("Internal error", 500));
    render(<MailboxTaskRecommendations metadata={metadata} />);
    fireEvent.click(await screen.findByRole("button", { name: "Create task" }));
    expect(await screen.findByText("Could not create task. Try again.")).toBeInTheDocument();
    expect(screen.queryByText("Internal error")).not.toBeInTheDocument();
  });

  /*
  FNXC:TaskRecommendations 2026-10-07-20:06:
  The notice arrives at accepted fn_task_done, before the source lands. Create task must be enabled exactly when the create route would accept it, with the reason shown while it is not yet available.
  */
  it("disables Create task with the server's explanation while the source has not landed", async () => {
    const reason = "Recommendations from FN-9100 can be filed as tasks after FN-9100 lands or completes";
    vi.mocked(fetchTaskDetail).mockResolvedValue({ ...detail, column: "in-review", mergeDetails: { mergeConfirmed: false } } as never);
    vi.mocked(fetchRecommendationEligibility).mockResolvedValue({ actionable: false, reason });
    render(<MailboxTaskRecommendations metadata={metadata} projectId="project-1" />);
    const button = await screen.findByRole("button", { name: "Create task" });
    expect(button).toBeDisabled();
    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(button).toHaveAccessibleDescription(reason);
    fireEvent.click(button);
    expect(createTaskFromRecommendation).not.toHaveBeenCalled();
    expect(fetchRecommendationEligibility).toHaveBeenCalledWith("FN-9100", "project-1");
  });

  it.each([
    ["a landed review source", { column: "in-review", mergeDetails: { mergeConfirmed: true } }],
    ["a completed source", { column: "done" }],
  ])("enables Create task for %s", async (_label, shape) => {
    vi.mocked(fetchTaskDetail).mockResolvedValue({ ...detail, ...shape } as never);
    vi.mocked(fetchRecommendationEligibility).mockResolvedValue({ actionable: true, reason: null });
    render(<MailboxTaskRecommendations metadata={metadata} />);
    expect(await screen.findByRole("button", { name: "Create task" })).toBeEnabled();
    expect(screen.queryByText(/lands or completes/)).not.toBeInTheDocument();
  });

  it("leaves Create task enabled when eligibility cannot be read, so the server stays the authority", async () => {
    vi.mocked(fetchTaskDetail).mockResolvedValue(detail as never);
    vi.mocked(fetchRecommendationEligibility).mockRejectedValue(new Error("offline"));
    vi.mocked(createTaskFromRecommendation).mockRejectedValueOnce(new ApiRequestError("Recommendations from FN-9100 can be filed as tasks after FN-9100 lands or completes", 409));
    render(<MailboxTaskRecommendations metadata={metadata} />);
    const button = await screen.findByRole("button", { name: "Create task" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(await screen.findByText("Recommendations from FN-9100 can be filed as tasks after FN-9100 lands or completes")).toBeInTheDocument();
  });

  it("ignores a stale parent lookup after the notice changes", async () => {
    let resolveDetail!: (value: never) => void;
    vi.mocked(fetchTaskDetail).mockImplementation(() => new Promise((resolve) => { resolveDetail = resolve; }));
    const { rerender } = render(<MailboxTaskRecommendations metadata={metadata} />);
    rerender(<MailboxTaskRecommendations metadata={{ kind: "task-recommendation-notice", taskId: "FN-9101", recommendationIds: [] }} />);
    resolveDetail(detail as never);
    await Promise.resolve();
    expect(screen.queryByTestId("mailbox-task-recommendations")).not.toBeInTheDocument();
  });
});
