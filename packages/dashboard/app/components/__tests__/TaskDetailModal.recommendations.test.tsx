import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskRecommendationsTab } from "../TaskRecommendationsTab";
import { TaskDetailContent } from "../TaskDetailModal";
import type { Task } from "@fusion/core";
import { ApiRequestError } from "../../api/client/client";

const { createTaskFromRecommendation, fetchBoardWorkflows, fetchRecommendationEligibility } = vi.hoisted(() => ({
  createTaskFromRecommendation: vi.fn(),
  fetchBoardWorkflows: vi.fn(),
  fetchRecommendationEligibility: vi.fn(),
}));
vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    createTaskFromRecommendation,
    fetchBoardWorkflows,
    fetchRecommendationEligibility,
  });
});

const task: Task = {
  id: "FN-8829",
  description: "Completed task",
  column: "done",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:00.000Z",
  recommendations: [{
    id: "rec-1",
    title: "Add focused coverage",
    description: "Add a separate regression test for a related workflow.",
    category: "improvement",
  }],
};

const sharedDetailProps = {
  onDeleteTask: vi.fn(),
  onMergeTask: vi.fn(),
  onOpenDetail: vi.fn(),
  addToast: vi.fn(),
};

/*
FNXC:TaskRecommendations 2026-10-08-01:10:
KB-011: task detail shows Recommendations exactly when the server eligibility route says the source is actionable.
These cases drive visibility through that server answer (never a client copy of the lane rule) across lane shapes, pending, rejected, empty, and task-switch states.
*/
function mockSingleLaneWorkflow(column: { id: string; name: string; flags: Record<string, boolean> }): void {
  fetchBoardWorkflows.mockResolvedValue({
    flagEnabled: true,
    defaultWorkflowId: "custom-workflow",
    taskWorkflowIds: { "FN-8829": "custom-workflow", "FN-8840": "custom-workflow" },
    workflows: [{ id: "custom-workflow", name: "Custom workflow", columns: [column] }],
  } as never);
}

const landingLane = { id: "landing", name: "Landing", flags: { mergeOrchestration: true } };
const landedTask: Task = { ...task, column: "landing" as Task["column"], prompt: "", mergeDetails: { mergeConfirmed: true } };

type EligibilityAnswer = { actionable: boolean; reason: string | null };

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe("TaskDetailContent recommendations eligibility", () => {
  beforeEach(() => {
    fetchRecommendationEligibility.mockReset();
    fetchRecommendationEligibility.mockResolvedValue({ actionable: true, reason: null });
    mockSingleLaneWorkflow(landingLane);
  });

  it("shows recommendations for a landed card in a merge-orchestration-only review lane when the server says actionable", async () => {
    render(<TaskDetailContent {...sharedDetailProps} embedded task={landedTask} />);

    expect(await screen.findByTestId("task-detail-workflow-badge")).toHaveTextContent("Custom workflow");
    fireEvent.click(screen.getByRole("button", { name: "Summary" }));
    expect(await screen.findByRole("heading", { name: "Recommendations" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create task" })).toBeEnabled();
    expect(fetchRecommendationEligibility).toHaveBeenCalledWith("FN-8829", undefined);
  });

  it("hides recommendations when the server says the source is not actionable", async () => {
    fetchRecommendationEligibility.mockResolvedValue({ actionable: false, reason: "Recommendations from FN-8829 can be filed as tasks after FN-8829 lands or completes" });
    const { container } = render(<TaskDetailContent {...sharedDetailProps} embedded task={{ ...landedTask, mergeDetails: { mergeConfirmed: false } }} />);

    expect(await screen.findByTestId("task-detail-workflow-badge")).toHaveTextContent("Custom workflow");
    fireEvent.click(screen.getByRole("button", { name: "Summary" }));
    await waitFor(() => expect(fetchRecommendationEligibility).toHaveBeenCalledWith("FN-8829", undefined));
    await act(async () => {});
    expect(screen.queryByRole("heading", { name: "Recommendations" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create task" })).not.toBeInTheDocument();
    expect(container.querySelector(".task-summary-section--recommendations")).toBeNull();
  });

  it("hides recommendations with no empty section shell when the eligibility request rejects", async () => {
    fetchRecommendationEligibility.mockRejectedValue(new Error("network down"));
    const { container } = render(<TaskDetailContent {...sharedDetailProps} embedded task={landedTask} />);

    expect(await screen.findByTestId("task-detail-workflow-badge")).toHaveTextContent("Custom workflow");
    fireEvent.click(screen.getByRole("button", { name: "Summary" }));
    await waitFor(() => expect(fetchRecommendationEligibility).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByRole("heading", { name: "Recommendations" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create task" })).not.toBeInTheDocument();
    expect(container.querySelector(".task-summary-section--recommendations")).toBeNull();
  });

  it("keeps recommendations hidden while the eligibility answer is pending", async () => {
    const pending = deferred<EligibilityAnswer>();
    fetchRecommendationEligibility.mockReturnValue(pending.promise);
    const { container } = render(<TaskDetailContent {...sharedDetailProps} embedded task={landedTask} />);

    expect(await screen.findByTestId("task-detail-workflow-badge")).toHaveTextContent("Custom workflow");
    fireEvent.click(screen.getByRole("button", { name: "Summary" }));
    await waitFor(() => expect(fetchRecommendationEligibility).toHaveBeenCalled());
    expect(container.querySelector(".task-summary-section--recommendations")).toBeNull();

    await act(async () => { pending.resolve({ actionable: true, reason: null }); });
    expect(await screen.findByRole("heading", { name: "Recommendations" })).toBeInTheDocument();
  });

  it.each([
    ["undefined", undefined],
    ["empty", []],
  ] as const)("does not ask the server and hides the section for %s recommendations", async (_label, recommendations) => {
    mockSingleLaneWorkflow({ id: "done", name: "Done", flags: { complete: true } });
    const { container } = render(<TaskDetailContent {...sharedDetailProps} embedded task={{ ...task, prompt: "", recommendations: recommendations as Task["recommendations"] }} />);

    expect(await screen.findByTestId("task-detail-workflow-badge")).toHaveTextContent("Custom workflow");
    fireEvent.click(screen.getByRole("button", { name: "Summary" }));
    await act(async () => {});
    expect(fetchRecommendationEligibility).not.toHaveBeenCalled();
    expect(container.querySelector(".task-summary-section--recommendations")).toBeNull();
  });

  it("ignores a stale eligibility answer for a previously opened task", async () => {
    const first = deferred<EligibilityAnswer>();
    const second = deferred<EligibilityAnswer>();
    fetchRecommendationEligibility.mockImplementation((taskId: string) => (taskId === "FN-8829" ? first.promise : second.promise));
    const { container, rerender } = render(<TaskDetailContent {...sharedDetailProps} embedded task={landedTask} />);

    expect(await screen.findByTestId("task-detail-workflow-badge")).toHaveTextContent("Custom workflow");
    fireEvent.click(screen.getByRole("button", { name: "Summary" }));
    await waitFor(() => expect(fetchRecommendationEligibility).toHaveBeenCalledWith("FN-8829", undefined));

    rerender(<TaskDetailContent {...sharedDetailProps} embedded task={{ ...landedTask, id: "FN-8840" }} />);
    await waitFor(() => expect(fetchRecommendationEligibility).toHaveBeenCalledWith("FN-8840", undefined));

    await act(async () => { first.resolve({ actionable: true, reason: null }); });
    expect(container.querySelector(".task-summary-section--recommendations")).toBeNull();

    await act(async () => { second.resolve({ actionable: false, reason: "not yet" }); });
    expect(container.querySelector(".task-summary-section--recommendations")).toBeNull();
  });

  it("follows the server answer, not a client lane rule, for a live custom archived-role lane", async () => {
    mockSingleLaneWorkflow({ id: "boxed", name: "Boxed", flags: { archived: true } });
    fetchRecommendationEligibility.mockResolvedValue({ actionable: false, reason: "not actionable" });

    render(<TaskDetailContent {...sharedDetailProps} embedded task={{ ...task, column: "boxed", prompt: "" }} />);

    expect(await screen.findByTestId("task-detail-workflow-badge")).toHaveTextContent("Custom workflow");
    await waitFor(() => expect(fetchRecommendationEligibility).toHaveBeenCalledWith("FN-8829", undefined));
    await act(async () => {});
    expect(screen.queryByRole("heading", { name: "Recommendations" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create task" })).not.toBeInTheDocument();
  });

  it.each([
    ["shows", true],
    ["hides", false],
  ] as const)("%s recommendations for a mergeBlocker review-lane card when the server answers actionable=%s", async (_verb, actionable) => {
    mockSingleLaneWorkflow({ id: "in-review", name: "In Review", flags: { mergeBlocker: true } });
    fetchRecommendationEligibility.mockResolvedValue({ actionable, reason: actionable ? null : "not yet" });

    render(
      <TaskDetailContent
        {...sharedDetailProps}
        embedded
        task={{ ...task, column: "in-review", prompt: "", mergeDetails: { mergeConfirmed: actionable } }}
      />,
    );

    expect(await screen.findByTestId("task-detail-workflow-badge")).toHaveTextContent("Custom workflow");
    fireEvent.click(screen.getByRole("button", { name: "Summary" }));
    await waitFor(() => expect(fetchRecommendationEligibility).toHaveBeenCalledWith("FN-8829", undefined));
    if (actionable) {
      expect(await screen.findByRole("heading", { name: "Recommendations" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Create task" })).toBeEnabled();
    } else {
      await act(async () => {});
      expect(screen.queryByRole("heading", { name: "Recommendations" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Create task" })).not.toBeInTheDocument();
    }
  });
});

describe("TaskRecommendationsTab", () => {
  it("renders one accessible empty message with no action for undefined or empty recommendations", () => {
    const view = render(<TaskRecommendationsTab task={{ ...task, recommendations: undefined }} projectId="project-a" />);

    expect(screen.getByText("No recommendations were produced for this task.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(createTaskFromRecommendation).not.toHaveBeenCalled();

    view.rerender(<TaskRecommendationsTab task={{ ...task, recommendations: [] }} projectId="project-a" />);
    expect(screen.getByText("No recommendations were produced for this task.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(createTaskFromRecommendation).not.toHaveBeenCalled();
  });

  it("renders exactly one create action and converges to Created after success", async () => {
    const parent = {
      ...task,
      recommendations: [{ ...task.recommendations![0], createdTaskId: "FN-8830" }],
    };
    const onTaskReconciled = vi.fn();
    createTaskFromRecommendation.mockResolvedValue({ task: { id: "FN-8830" }, parent });
    render(<TaskRecommendationsTab task={task} projectId="project-a" onTaskReconciled={onTaskReconciled} />);

    const button = screen.getByRole("button", { name: "Create task" });
    fireEvent.click(button);
    expect(button).toBeDisabled();

    expect(await screen.findByText("Created FN-8830")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Create|Retry/ })).not.toBeInTheDocument();
    expect(createTaskFromRecommendation).toHaveBeenCalledWith("FN-8829", "rec-1", "project-a");
    expect(onTaskReconciled).toHaveBeenCalledWith(parent);
  });

  it("does not render an action for an already-created recommendation", () => {
    render(<TaskRecommendationsTab task={{ ...task, recommendations: [{ ...task.recommendations![0], createdTaskId: "FN-8830" }] }} projectId="project-a" />);

    expect(screen.getByText("Created FN-8830")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Create|Retry/ })).not.toBeInTheDocument();
    expect(screen.queryByText("No recommendations were produced for this task.")).not.toBeInTheDocument();
  });

  it("clears recommendation action state when retained detail switches tasks", async () => {
    createTaskFromRecommendation.mockResolvedValue({
      task: { id: "FN-8830" },
      parent: { ...task, recommendations: [{ ...task.recommendations![0], createdTaskId: "FN-8830" }] },
    });
    const { rerender } = render(<TaskRecommendationsTab task={task} projectId="project-a" />);

    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await screen.findByText("Created FN-8830");

    rerender(<TaskRecommendationsTab task={{ ...task, id: "FN-8831" }} projectId="project-a" />);
    expect(await screen.findByRole("button", { name: "Create task" })).toBeEnabled();
    await waitFor(() => expect(screen.queryByText("Created FN-8830")).not.toBeInTheDocument());
  });

  it("issues one request for rapid clicks and leaves a retry action after an intake conflict", async () => {
    createTaskFromRecommendation.mockReset();
    let rejectRequest: ((error: Error) => void) | undefined;
    createTaskFromRecommendation.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRequest = reject; }));
    render(<TaskRecommendationsTab task={task} projectId="project-a" />);

    const button = screen.getByRole("button", { name: "Create task" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(createTaskFromRecommendation).toHaveBeenCalledTimes(1);

    rejectRequest?.(new Error("duplicate_candidates"));
    expect(await screen.findByRole("button", { name: "Retry creating task" })).toBeEnabled();
  });

  it("keeps concurrent recommendation actions isolated", async () => {
    createTaskFromRecommendation.mockReset();
    let resolveFirst: ((value: { task: { id: string }; parent: Task }) => void) | undefined;
    let resolveSecond: ((value: { task: { id: string }; parent: Task }) => void) | undefined;
    createTaskFromRecommendation
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    const secondRecommendation = {
      ...task.recommendations![0],
      id: "rec-2",
      title: "Add a separate feature",
    };
    const multiRecommendationTask = { ...task, recommendations: [task.recommendations![0], secondRecommendation] };
    render(<TaskRecommendationsTab task={multiRecommendationTask} projectId="project-a" />);

    const buttons = screen.getAllByRole("button", { name: "Create task" });
    fireEvent.click(buttons[0]!);
    fireEvent.click(buttons[1]!);
    expect(createTaskFromRecommendation).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole("button", { name: "Creating…" })).toHaveLength(2);

    resolveFirst?.({
      task: { id: "FN-8830" },
      parent: { ...multiRecommendationTask, recommendations: [{ ...task.recommendations![0], createdTaskId: "FN-8830" }, secondRecommendation] },
    });
    expect(await screen.findByText("Created FN-8830")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();

    resolveSecond?.({
      task: { id: "FN-8831" },
      parent: { ...multiRecommendationTask, recommendations: [task.recommendations![0], { ...secondRecommendation, createdTaskId: "FN-8831" }] },
    });
    expect(await screen.findByText("Created FN-8831")).toBeInTheDocument();
  });

  it("shows the server's refusal reason after a rejected creation", async () => {
    createTaskFromRecommendation.mockReset();
    createTaskFromRecommendation.mockRejectedValueOnce(new ApiRequestError("Recommendations from FN-8829 can be filed as tasks after FN-8829 lands or completes", 409));
    render(<TaskRecommendationsTab task={task} projectId="project-a" />);

    fireEvent.click(screen.getByRole("button", { name: "Create task" }));

    expect(await screen.findByText("Recommendations from FN-8829 can be filed as tasks after FN-8829 lands or completes")).toBeInTheDocument();
    expect(screen.queryByText("Could not create task. Try again.")).not.toBeInTheDocument();
  });
});
