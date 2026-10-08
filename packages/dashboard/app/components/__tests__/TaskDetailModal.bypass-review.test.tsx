/*
FNXC:ReviewLaneBypass 2026-10-08-06:10:
KB-019: Task Detail offers "Bypass failed review" exactly when the server bypass-eligibility route reports `bypassable: true`.
These cases drive the menu through that server answer (never a client copy of the rule), including the reported case of a required pre-merge gate that never produced a result.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReviewBypassEligibility, Task } from "@fusion/core";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailContent } from "../TaskDetailModal";
import { fetchReviewBypassEligibility } from "../../api";

setupTaskDetailModalHooks();

const absentGate: ReviewBypassEligibility = {
  bypassable: true,
  workflowStepId: "plan-review",
  workflowStepName: "plan-review",
  source: "absent",
  reason: null,
};

const refused: ReviewBypassEligibility = {
  bypassable: false,
  workflowStepId: null,
  workflowStepName: null,
  source: null,
  reason: "Cannot bypass review lane for FN-099: failed review has open findings",
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function renderDetail(task: Task, onBypassReview?: (id: string, reason: string) => Promise<Task>) {
  return render(
    <TaskDetailContent
      task={task}
      projectId="proj-1"
      embedded
      onRequestClose={noop}
      onDeleteTask={noopDelete}
      onMergeTask={noopMerge}
      onOpenDetail={noopOpenDetail}
      onBypassReview={onBypassReview}
      addToast={noop}
    />,
  );
}

/** Settle the eligibility fetch chain (resolved mocks, no real timers) before opening the menu once. */
async function flushEligibility(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function openActions(): void {
  fireEvent.click(screen.getByRole("button", { name: "Actions" }));
}

const failedResult = {
  workflowStepId: "code-review",
  workflowStepName: "Code Review",
  phase: "pre-merge" as const,
  status: "failed" as const,
  output: "REVISE",
};

describe("TaskDetailContent review bypass eligibility", () => {
  const mockedFetch = vi.mocked(fetchReviewBypassEligibility);

  beforeEach(() => {
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue(refused);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("offers Bypass failed review for a required gate with no result when the server says bypassable", async () => {
    mockedFetch.mockResolvedValue(absentGate);
    const task = makeTask({ id: "FN-ABSENT", column: "in-review", workflowStepResults: [] });
    renderDetail(task, vi.fn(async () => task));

    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith("FN-ABSENT", "proj-1"));
    await flushEligibility();
    openActions();
    expect(await screen.findByRole("menuitem", { name: "Bypass failed review" })).toBeTruthy();
  });

  it("calls onBypassReview with the prompted reason when the item is selected", async () => {
    mockedFetch.mockResolvedValue(absentGate);
    const task = makeTask({ id: "FN-ABSENT", column: "in-review", workflowStepResults: [] });
    const onBypassReview = vi.fn(async () => task);
    vi.spyOn(window, "prompt").mockReturnValue("gate never ran");
    renderDetail(task, onBypassReview);

    await flushEligibility();
    openActions();
    expect(await screen.findByRole("menuitem", { name: "Bypass failed review" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Bypass failed review" }));
    await waitFor(() => expect(onBypassReview).toHaveBeenCalledWith("FN-ABSENT", "gate never ran"));
  });

  it("hides the item when the server refuses even though a failed pre-merge result is present", async () => {
    const task = makeTask({ id: "FN-REFUSED", column: "in-review", workflowStepResults: [failedResult] });
    renderDetail(task, vi.fn(async () => task));

    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));
    await flushEligibility();
    openActions();
    expect(screen.queryByRole("menuitem", { name: "Bypass failed review" })).toBeNull();
  });

  it("fails closed when the eligibility request rejects", async () => {
    mockedFetch.mockRejectedValue(new Error("boom"));
    const task = makeTask({ id: "FN-REJECT", column: "in-review", workflowStepResults: [failedResult] });
    renderDetail(task, vi.fn(async () => task));

    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));
    await flushEligibility();
    openActions();
    expect(screen.queryByRole("menuitem", { name: "Bypass failed review" })).toBeNull();
  });

  it("ignores a late answer for a previously shown task", async () => {
    const late = deferred<ReviewBypassEligibility>();
    mockedFetch.mockImplementation((id: string) => (id === "FN-A" ? late.promise : Promise.resolve(refused)));
    const taskA = makeTask({ id: "FN-A", column: "in-review", workflowStepResults: [] });
    const taskB = makeTask({ id: "FN-B", column: "in-review", workflowStepResults: [] });
    const onBypassReview = vi.fn(async () => taskA);
    const view = renderDetail(taskA, onBypassReview);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith("FN-A", "proj-1"));

    view.rerender(
      <TaskDetailContent
        task={taskB}
        projectId="proj-1"
        embedded
        onRequestClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onBypassReview={onBypassReview}
        addToast={noop}
      />,
    );
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith("FN-B", "proj-1"));
    late.resolve(absentGate);
    await late.promise;
    await flushEligibility();

    openActions();
    expect(screen.queryByRole("menuitem", { name: "Bypass failed review" })).toBeNull();
  });

  it("refetches when a live eligibility input changes", async () => {
    const task = makeTask({ id: "FN-LIVE", column: "in-review", paused: true, workflowStepResults: [] });
    const onBypassReview = vi.fn(async () => task);
    const view = renderDetail(task, onBypassReview);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));

    mockedFetch.mockResolvedValue(absentGate);
    view.rerender(
      <TaskDetailContent
        task={{ ...task, paused: false }}
        projectId="proj-1"
        embedded
        onRequestClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onBypassReview={onBypassReview}
        addToast={noop}
      />,
    );
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(2));
    await flushEligibility();
    openActions();
    expect(await screen.findByRole("menuitem", { name: "Bypass failed review" })).toBeTruthy();

    view.rerender(
      <TaskDetailContent
        task={{ ...task, paused: false, workflowStepResults: [failedResult] }}
        projectId="proj-1"
        embedded
        onRequestClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onBypassReview={onBypassReview}
        addToast={noop}
      />,
    );
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(3));
  });

  it("issues no eligibility request without a bypass handler", async () => {
    const task = makeTask({ id: "FN-NOHANDLER", column: "in-review", workflowStepResults: [] });
    renderDetail(task);
    await flushEligibility();
    openActions();
    expect(screen.queryByRole("menuitem", { name: "Bypass failed review" })).toBeNull();
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
