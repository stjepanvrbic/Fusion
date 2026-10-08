/*
FNXC:ExternalBlockAutoResume 2026-10-08-08:29:
The scheduler pass is the timer for automatic resumes of rate-limit freezes: it requests due resumes after both pause gates, so a
globally paused or engine-paused board never resumes frozen work.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";

const resumeDueExternalBlocks = vi.fn(async () => [] as string[]);
vi.mock("../external-block/external-block-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../external-block/external-block-lifecycle.js")>()),
  resumeDueExternalBlocks,
}));

const { Scheduler } = await import("../scheduler.js");

const frozen = {
  id: "KB-046",
  description: "rate limited",
  column: "in-progress",
  status: "blocked",
  paused: true,
  dependencies: [],
  steps: [],
  currentStep: 0,
  createdAt: "2026-10-08T07:00:00.000Z",
  updatedAt: "2026-10-08T07:00:00.000Z",
} as unknown as Task;

function createStore(settings: Record<string, unknown>): TaskStore {
  return {
    getRootDir: vi.fn(() => "/project"),
    listTasks: vi.fn(async () => [frozen]),
    getSettings: vi.fn(async () => ({ maxConcurrent: 2, maxWorktrees: 4, ...settings })),
    updateSettings: vi.fn(async () => ({})),
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    getTaskWorkflowSelection: vi.fn(() => undefined),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;
}

describe("scheduler external-block automatic resume sweep", () => {
  beforeEach(() => resumeDueExternalBlocks.mockClear());

  it("requests due automatic resumes on an unpaused pass", async () => {
    const store = createStore({});
    const scheduler = new Scheduler(store);
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(resumeDueExternalBlocks).toHaveBeenCalledWith({ store, tasks: [frozen] });
  });

  it.each([{ globalPause: true }, { enginePaused: true }])("never resumes frozen work while paused: %o", async (pause) => {
    const scheduler = new Scheduler(createStore(pause));
    (scheduler as unknown as { running: boolean }).running = true;

    await scheduler.schedule();

    expect(resumeDueExternalBlocks).not.toHaveBeenCalled();
  });
});
