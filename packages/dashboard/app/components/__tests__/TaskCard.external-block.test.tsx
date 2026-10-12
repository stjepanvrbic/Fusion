import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { ExternalBlockNotice, TaskCard } from "../TaskCard";

vi.mock("../ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../PrCreateModal", () => ({ PrCreateModal: () => null }));
vi.mock("../../hooks/useTaskDiffStats", () => ({ useTaskDiffStats: () => ({ stats: null, loading: false }) }));
vi.mock("../../hooks/useBadgeWebSocket", () => ({ useBadgeWebSocket: () => ({ badgeUpdates: new Map(), isConnected: true, subscribeToBadge: vi.fn(), unsubscribeFromBadge: vi.fn() }) }));
vi.mock("../../hooks/useBatchBadgeFetch", () => ({ getFreshBatchData: vi.fn(() => null) }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn(), confirmWithChoice: vi.fn() }) }));
vi.mock("../../api", () => ({ fetchWorkflowSettingValues: vi.fn().mockResolvedValue({ stored: {}, effective: {}, orphaned: [] }) }));

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-209",
    title: "Frozen external obstacle",
    description: "Keep exact work",
    column: "in-progress",
    dependencies: [],
    steps: [{ name: "Implementation", status: "done" }, { name: "Testing & Verification", status: "in-progress" }],
    currentStep: 1,
    status: "blocked",
    paused: true,
    pausedReason: "external-block",
    error: "BLOCKED: host-environment/ENOSPC: no space left on device, write",
    externalBlock: {
      origin: "host-environment",
      code: "ENOSPC",
      message: "no space left on device, write",
      source: "agent-declaration",
      blockedAt: "2026-08-28T00:00:00.000Z",
      resume: { column: "in-progress", nodeId: "steps#1:step-execute", currentStep: 1, worktree: "/worktree", branch: "fusion/fn-209" },
    },
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    ...overrides,
  } as Task;
}

const QUESTION = "Which of options 1-4 should this task implement?";
const UNBLOCK = "Record the chosen option numbers in a task comment, then retry.";
const DECISION_REASON = "Awaiting the owner's choice. This is not a host, network, provider or credential failure.";

function decisionWait(overrides: Partial<Task> = {}, report: Record<string, string> | null = { question: QUESTION, unblockCondition: UNBLOCK }): Task {
  return task({
    error: `BLOCKED: human-decision/DECISION_REQUIRED: ${DECISION_REASON}`,
    externalBlock: {
      origin: "human-decision",
      code: "DECISION_REQUIRED",
      message: DECISION_REASON,
      source: "agent-declaration",
      blockedAt: "2026-10-12T06:16:00.000Z",
      resume: { column: "in-progress", nodeId: "steps#1:step-execute", currentStep: 1, worktree: "/worktree", branch: "fusion/fn-209" },
      ...(report ? { report } : {}),
    } as Task["externalBlock"],
    ...overrides,
  });
}

const originalRect = HTMLElement.prototype.getBoundingClientRect;
const originalInnerWidth = window.innerWidth;

beforeEach(() => {
  HTMLElement.prototype.getBoundingClientRect = vi.fn(() => ({ width: 420, height: 240, top: 0, left: 0, right: 420, bottom: 240, x: 0, y: 0, toJSON: () => ({}) }));
});

afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
  vi.restoreAllMocks();
});

describe("TaskCard external Blocked overlay", () => {
  it("shows the raw obstacle and routes explanation and exact Retry on desktop", async () => {
    const onOpenChatWithPrefill = vi.fn();
    const onRetryTask = vi.fn().mockResolvedValue(task({ status: undefined, externalBlock: undefined }));
    const { container } = render(<TaskCard task={task()} onOpenDetail={vi.fn()} addToast={vi.fn()} onOpenChatWithPrefill={onOpenChatWithPrefill} onRetryTask={onRetryTask} />);

    expect(screen.getByTestId("external-block-card-FN-209")).toHaveTextContent("Blocked");
    expect(screen.getByText("ENOSPC: no space left on device, write")).toBeInTheDocument();
    expect(screen.queryByText("paused")).toBeNull();
    expect(container.querySelector(".card-error")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Explain this error" }));
    expect(onOpenChatWithPrefill).toHaveBeenCalledWith("Explain this error ENOSPC: no space left on device, write and how to resolve it.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onRetryTask).toHaveBeenCalledWith("FN-209"));
  });

  it("keeps both mobile actions usable at the 768px breakpoint", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 768 });
    render(<TaskCard task={task()} onOpenDetail={vi.fn()} addToast={vi.fn()} onOpenChatWithPrefill={vi.fn()} onRetryTask={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Explain this error" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.getByTestId("external-block-card-FN-209")).toBeVisible();
  });

  it("renders no empty overlay or action shells for incomplete and read-only shapes", () => {
    const { rerender } = render(<TaskCard task={task({ externalBlock: undefined })} onOpenDetail={vi.fn()} addToast={vi.fn()} />);
    expect(screen.queryByTestId("external-block-card-FN-209")).toBeNull();

    rerender(<TaskCard task={task()} onOpenDetail={vi.fn()} addToast={vi.fn()} />);
    expect(screen.getByTestId("external-block-card-FN-209")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Explain this error" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  /*
  FNXC:ExternalBlockUx 2026-10-08-08:29:
  A requested resume waits for a running-agent slot while the card stays frozen, so Retry becomes a disabled "waiting" state on desktop
  and mobile instead of a button that answers a second click with a conflict. A scheduled automatic resume is announced in the notice.
  */
  it.each([1280, 768])("shows a queued resume as waiting for a slot instead of a second Retry at %ipx", (width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    const onRetryTask = vi.fn();
    const queued = task({ externalBlock: { ...task().externalBlock!, resumeRequest: { requestedAt: "2026-10-08T07:30:00.000Z", trigger: "operator" } } });
    render(<TaskCard task={queued} onOpenDetail={vi.fn()} addToast={vi.fn()} onOpenChatWithPrefill={vi.fn()} onRetryTask={onRetryTask} />);

    const waiting = screen.getByRole("button", { name: "Waiting for a free agent slot…" });
    expect(waiting).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    fireEvent.click(waiting);
    expect(onRetryTask).not.toHaveBeenCalled();
  });

  it("re-renders a memoized card when its resume becomes queued", () => {
    const props = { onOpenDetail: vi.fn(), addToast: vi.fn(), onOpenChatWithPrefill: vi.fn(), onRetryTask: vi.fn() };
    const { rerender } = render(<TaskCard task={task()} {...props} />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();

    rerender(<TaskCard task={task({ externalBlock: { ...task().externalBlock!, resumeRequest: { requestedAt: "2026-10-08T07:30:00.000Z", trigger: "automatic" } } })} {...props} />);
    expect(screen.getByRole("button", { name: "Waiting for a free agent slot…" })).toBeDisabled();
  });

  it("announces a scheduled automatic resume and keeps Retry available", () => {
    const scheduled = task({
      externalBlock: {
        ...task().externalBlock!,
        code: "RATE_LIMIT",
        autoResume: { attempt: 2, budget: 6, resumeAt: "2026-10-08T07:42:00.000Z" },
      },
    });
    render(<TaskCard task={scheduled} onOpenDetail={vi.fn()} addToast={vi.fn()} onOpenChatWithPrefill={vi.fn()} onRetryTask={vi.fn()} />);

    expect(screen.getByTestId("external-block-card-FN-209")).toHaveTextContent(/Automatic retry 2\/6 at /);
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });
});

/*
FNXC:DecisionWait 2026-10-12-06:16:
A card that waits for an owner decision must read as a wait, not a fault: its own title, the question, what the owner must do, no fault code and no "Explain this error" button.
The notice is one component shared by the board card, both list layouts and the task detail, so the three variants are asserted together.
*/
describe("decision-wait notice", () => {
  const variants = ["card", "list", "detail"] as const;

  it.each(variants)("shows the question and how to resume in the %s variant, without fault vocabulary", async (variant) => {
    const onRetryTask = vi.fn().mockResolvedValue(decisionWait());
    const onOpenChatWithPrefill = vi.fn();
    render(<ExternalBlockNotice task={decisionWait()} variant={variant} onOpenChatWithPrefill={onOpenChatWithPrefill} onRetryTask={onRetryTask} />);
    const notice = screen.getByTestId(`external-block-${variant}-FN-209`);

    expect(notice.querySelector(".external-block-notice__title")).toHaveTextContent(/^Waiting for a decision$/);
    expect(screen.getByText(QUESTION)).toBeInTheDocument();
    expect(screen.getByText(`To resume: ${UNBLOCK}`)).toBeInTheDocument();
    expect(notice).not.toHaveTextContent("Blocked");
    expect(notice).not.toHaveTextContent("DECISION_REQUIRED");
    expect(notice).not.toHaveTextContent(/credential/i);
    expect(notice).not.toHaveTextContent("CREDENTIALS");

    const buttons = [...notice.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["Retry"]);
    expect(notice.querySelector("[aria-label]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Explain this error" })).toBeNull();
    expect(screen.queryByTitle("Explain this error")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onRetryTask).toHaveBeenCalledWith("FN-209"));
    expect(onOpenChatWithPrefill).not.toHaveBeenCalled();
  });

  it.each(variants)("renders no actions wrapper in the %s variant when only the explanation handler is passed", (variant) => {
    render(<ExternalBlockNotice task={decisionWait()} variant={variant} onOpenChatWithPrefill={vi.fn()} />);
    const notice = screen.getByTestId(`external-block-${variant}-FN-209`);

    expect(notice.querySelector(".external-block-notice__actions")).toBeNull();
    expect(notice.querySelectorAll("button")).toHaveLength(0);
    expect(notice.querySelector("[aria-label]")).toBeNull();
    expect(screen.getByText(QUESTION)).toBeInTheDocument();
  });

  it("falls back to the stored explanation and omits the resume line for a wait without a report", () => {
    render(<ExternalBlockNotice task={decisionWait({}, null)} variant="detail" onRetryTask={vi.fn()} />);
    const notice = screen.getByTestId("external-block-detail-FN-209");

    expect(notice.querySelector(".external-block-notice__title")).toHaveTextContent(/^Waiting for a decision$/);
    expect(screen.getByText(DECISION_REASON)).toBeInTheDocument();
    expect(notice).not.toHaveTextContent("To resume:");
    expect(notice).not.toHaveTextContent("DECISION_REQUIRED");
    expect(notice.querySelectorAll(".external-block-notice__reason")).toHaveLength(1);
  });

  it("keeps a queued Retry as the waiting state", () => {
    const queued = decisionWait();
    queued.externalBlock = { ...queued.externalBlock!, resumeRequest: { requestedAt: "2026-10-12T07:00:00.000Z", trigger: "operator" } };
    const onRetryTask = vi.fn();
    render(<ExternalBlockNotice task={queued} variant="card" onRetryTask={onRetryTask} />);

    const waiting = screen.getByRole("button", { name: "Waiting for a free agent slot…" });
    expect(waiting).toBeDisabled();
    fireEvent.click(waiting);
    expect(onRetryTask).not.toHaveBeenCalled();
  });

  it.each(variants)("still shows a fault freeze as Blocked with its code and explanation button in the %s variant", (variant) => {
    render(<ExternalBlockNotice task={task()} variant={variant} onOpenChatWithPrefill={vi.fn()} onRetryTask={vi.fn()} />);
    const notice = screen.getByTestId(`external-block-${variant}-FN-209`);

    expect(notice.querySelector(".external-block-notice__title")).toHaveTextContent(/^Blocked$/);
    expect(screen.getByText("ENOSPC: no space left on device, write")).toBeInTheDocument();
    expect(notice).not.toHaveTextContent("Waiting for a decision");
    expect(notice).not.toHaveTextContent("To resume:");
    expect(screen.getByRole("button", { name: "Explain this error" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });

  it("ignores a question stored on a fault freeze", () => {
    const fault = task();
    fault.externalBlock = { ...fault.externalBlock!, report: { verifiedCondition: "a", stopReason: "b", unimplementedWork: "c", unblockCondition: "Free disk space.", question: "Not a decision?" } };
    render(<ExternalBlockNotice task={fault} variant="card" onOpenChatWithPrefill={vi.fn()} onRetryTask={vi.fn()} />);
    const notice = screen.getByTestId("external-block-card-FN-209");

    expect(notice).toHaveTextContent("Blocked");
    expect(notice).not.toHaveTextContent("Not a decision?");
    expect(notice).not.toHaveTextContent("To resume:");
  });

  it.each([1280, 768])("renders the wait on the board card at %ipx with a decision badge and no error or pause vocabulary", (width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    const { container } = render(<TaskCard task={decisionWait()} onOpenDetail={vi.fn()} addToast={vi.fn()} onOpenChatWithPrefill={vi.fn()} onRetryTask={vi.fn()} />);
    const notice = screen.getByTestId("external-block-card-FN-209");

    expect(notice).toBeVisible();
    expect(notice).toHaveTextContent("Waiting for a decision");
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Explain this error" })).toBeNull();
    expect(container.querySelector(".card-error")).toBeNull();
    expect(screen.queryByText("paused")).toBeNull();
    expect(container).not.toHaveTextContent("DECISION_REQUIRED");
    expect(container).not.toHaveTextContent("Blocked");
  });

  it("re-renders a memoized card when a fault freeze is replaced by a decision wait", () => {
    const props = { onOpenDetail: vi.fn(), addToast: vi.fn(), onOpenChatWithPrefill: vi.fn(), onRetryTask: vi.fn() };
    const { rerender } = render(<TaskCard task={task()} {...props} />);
    expect(screen.getByRole("button", { name: "Explain this error" })).toBeInTheDocument();

    rerender(<TaskCard task={decisionWait()} {...props} />);
    expect(screen.getByTestId("external-block-card-FN-209")).toHaveTextContent("Waiting for a decision");
    expect(screen.queryByRole("button", { name: "Explain this error" })).toBeNull();

    const reworded = decisionWait({}, { question: "Which vendor should this task use?", unblockCondition: UNBLOCK });
    rerender(<TaskCard task={reworded} {...props} />);
    expect(screen.getByText("Which vendor should this task use?")).toBeInTheDocument();
  });
});
