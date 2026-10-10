/*
FNXC:CloseAsLanded 2026-10-10-17:20:
Task Detail offers "Close as landed" for a card parked with "branch had no net changes vs main", collects the required reason, and posts it to the close-as-landed route.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EMPTY_MERGE_NO_LANDED_PROOF_REASON, type Task } from "@fusion/core";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailContent } from "../TaskDetailModal";
import { closeTaskAsLanded } from "../../api/tasks/tasks-lifecycle";

vi.mock("../../api/tasks/tasks-lifecycle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/tasks/tasks-lifecycle")>()),
  closeTaskAsLanded: vi.fn(async () => ({ outcome: "closed", baseBranch: "main" })),
}));

setupTaskDetailModalHooks();

function renderDetail(task: Task, addToast = noop) {
  return render(
    <TaskDetailContent
      task={task}
      projectId="proj-1"
      embedded
      onRequestClose={noop}
      onDeleteTask={noopDelete}
      onMergeTask={noopMerge}
      onOpenDetail={noopOpenDetail}
      addToast={addToast}
    />,
  );
}

const parked = () => makeTask({
  id: "KB-057",
  column: "in-review",
  status: "failed",
  error: `${EMPTY_MERGE_NO_LANDED_PROOF_REASON}; merge agent: main already contains everything on fusion/kb-057.`,
});

describe("TaskDetailContent close as landed", () => {
  afterEach(() => {
    vi.mocked(closeTaskAsLanded).mockClear();
    vi.restoreAllMocks();
  });

  it("posts the prompted reason for an empty-merge park", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("  KB-062 landed a superset  ");
    renderDetail(parked());

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Close as landed" }));

    await waitFor(() => expect(closeTaskAsLanded).toHaveBeenCalledWith("KB-057", "KB-062 landed a superset", "proj-1"));
  });

  it("does nothing when the operator gives no reason", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("   ");
    renderDetail(parked());

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Close as landed" }));

    expect(closeTaskAsLanded).not.toHaveBeenCalled();
  });

  it("is not offered for another failed review card", async () => {
    renderDetail(makeTask({ id: "FN-1", column: "in-review", status: "failed", error: "AI merge blocked: reviewer rejected" }));

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    await screen.findAllByRole("menuitem");
    expect(screen.queryByRole("menuitem", { name: "Close as landed" })).toBeNull();
  });
});
