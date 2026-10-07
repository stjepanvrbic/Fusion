import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { Task } from "@fusion/core";
import * as api from "../../api";
import * as swrCache from "../../utils/swrCache";
import { clearTraces, getTraces } from "../../utils/dashboardTraceBuffer";
import { useTasks } from "../useTasks";

vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    fetchTasks: vi.fn(), fetchArchivedTasks: vi.fn().mockResolvedValue({ tasks: [], total: 0, hasMore: false }),
    createTask: vi.fn(), moveTask: vi.fn(), deleteTask: vi.fn(), mergeTask: vi.fn(), retryTask: vi.fn(),
    bypassReview: vi.fn(), pauseTask: vi.fn(), unpauseTask: vi.fn(), resetTask: vi.fn(), duplicateTask: vi.fn(),
    updateTask: vi.fn(), archiveTask: vi.fn(), unarchiveTask: vi.fn(), archiveAllDone: vi.fn(), resumeWorkflowStep: vi.fn(),
  });
});

class MockEventSource {
  static instances: MockEventSource[] = [];
  static CLOSED = 2;
  readyState = 1;
  listeners: Record<string, Array<(event: MessageEvent) => void>> = {};
  close = vi.fn(() => { this.readyState = MockEventSource.CLOSED; });
  constructor(readonly url: string) { MockEventSource.instances.push(this); }
  addEventListener(event: string, listener: (event: MessageEvent) => void) { (this.listeners[event] ??= []).push(listener); }
  removeEventListener(event: string, listener: (event: MessageEvent) => void) { this.listeners[event] = (this.listeners[event] ?? []).filter((candidate) => candidate !== listener); }
  emit(event: string, payload: unknown) { for (const listener of this.listeners[event] ?? []) listener({ data: JSON.stringify(payload) } as MessageEvent); }
}

const task = (title: string, updatedAt: string): Task => ({ id: "KB-001", description: title, column: "todo", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-01-01T00:00:00Z", updatedAt, columnMovedAt: updatedAt } as Task);
const aOnly = task("A only", "2026-01-01T00:00:00Z");

describe("useTasks cross-project isolation", () => {
  const originalEventSource = globalThis.EventSource;
  const fetchTasks = vi.mocked(api.fetchTasks);
  beforeEach(() => {
    MockEventSource.instances = [];
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    fetchTasks.mockReset();
    clearTraces();
    vi.spyOn(swrCache, "readCache").mockReturnValue(null);
    vi.spyOn(swrCache, "writeCache").mockReturnValue(undefined);
  });
  afterEach(() => {
    MockEventSource.instances.forEach((source) => source.close());
    globalThis.EventSource = originalEventSource;
    vi.restoreAllMocks();
  });

  it.each(["2026-01-02T00:00:00Z", "2025-12-31T00:00:00Z"])("keeps project A's colliding row after A → B → A when B is %s", async (bUpdatedAt) => {
    fetchTasks.mockResolvedValueOnce([task("Project A task", "2026-01-01T00:00:00Z"), aOnly]);
    const { result, rerender } = renderHook(({ projectId }) => useTasks({ projectId }), { initialProps: { projectId: "project-a" } });
    await waitFor(() => expect(result.current.tasks.map((row) => row.description)).toEqual(["Project A task", "A only"]));
    fetchTasks.mockResolvedValueOnce([task("Project B task", bUpdatedAt)]);
    rerender({ projectId: "project-b" });
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    fetchTasks.mockResolvedValueOnce([task("Project A task", "2026-01-01T00:00:00Z"), aOnly]);
    rerender({ projectId: "project-a" });
    await waitFor(() => expect(result.current.tasks.map((row) => row.description)).toEqual(["Project A task", "A only"]));
  });

  it.each(["task:created", "task:updated", "task:deleted", "task:moved", "task:merged"])("drops foreign %s events before they mutate matching local rows", async (event) => {
    fetchTasks.mockResolvedValueOnce([task("Project A task", "2026-01-01T00:00:00Z")]);
    const { result } = renderHook(() => useTasks({ projectId: "project-a" }));
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    const foreignTask = { ...task("Project B task", "2026-01-02T00:00:00Z"), projectId: "project-b" };
    const payload = event === "task:moved"
      ? { projectId: "project-b", task: foreignTask, from: "todo", to: "done" }
      : event === "task:merged"
        ? { projectId: "project-b", task: foreignTask }
        : foreignTask;
    act(() => MockEventSource.instances.at(-1)?.emit(event, payload));
    await waitFor(() => expect(result.current.tasks[0]?.description).toBe("Project A task"));
    expect(getTraces()).toContainEqual(expect.objectContaining({
      source: "useTasks",
      event: "dropped-foreign-project-event",
      detail: expect.objectContaining({ eventProjectId: "project-b", projectId: "project-a" }),
    }));
  });

  it("drops foreign agent logs before they clear local stall state or add planner activity", async () => {
    const localTask = {
      ...task("Project A task", "2026-01-01T00:00:00Z"),
      inReviewStalled: true,
      recentAgentActivityAt: undefined,
    };
    fetchTasks.mockResolvedValueOnce([localTask]);
    const { result } = renderHook(() => useTasks({ projectId: "project-a" }));
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));

    act(() => MockEventSource.instances.at(-1)?.emit("agent:log", {
      projectId: "project-b",
      taskId: "KB-001",
      timestamp: "2026-01-02T00:00:00Z",
      type: "text",
      agent: "triage",
    }));

    expect(result.current.tasks[0]).toMatchObject({ inReviewStalled: true, recentAgentActivityAt: undefined });
    expect(getTraces()).toContainEqual(expect.objectContaining({
      source: "useTasks",
      event: "dropped-foreign-project-event",
      detail: expect.objectContaining({ eventProjectId: "project-b", projectId: "project-a" }),
    }));
  });

  it("does not persist foreign rows into project A's cache after events or switches", async () => {
    fetchTasks.mockResolvedValueOnce([task("Project A task", "2026-01-01T00:00:00Z")]);
    const { result, rerender } = renderHook(({ projectId }) => useTasks({ projectId }), { initialProps: { projectId: "project-a" } });
    await waitFor(() => expect(result.current.tasks[0]?.description).toBe("Project A task"));

    act(() => MockEventSource.instances.at(-1)?.emit("task:updated", {
      ...task("Project B task", "2026-01-02T00:00:00Z"), projectId: "project-b",
    }));
    fetchTasks.mockResolvedValueOnce([task("Project B task", "2026-01-02T00:00:00Z")]);
    rerender({ projectId: "project-b" });
    await waitFor(() => expect(result.current.tasks[0]?.description).toBe("Project B task"));

    const projectACacheWrites = vi.mocked(swrCache.writeCache).mock.calls
      .filter(([key]) => key === `${swrCache.SWR_CACHE_KEYS.TASKS_PREFIX}project-a`)
      .map(([, payload]) => JSON.stringify(payload));
    expect(projectACacheWrites).not.toContain("Project B task");
  });

  it("repaints a project switch from only its own cache hit or an empty cache miss", async () => {
    const projectBCached = task("Project B cached task", "2026-01-02T00:00:00Z");
    vi.mocked(swrCache.readCache).mockImplementation((key) =>
      key === `${swrCache.SWR_CACHE_KEYS.TASKS_PREFIX}project-b` ? [projectBCached] : null,
    );
    fetchTasks.mockResolvedValueOnce([task("Project A task", "2026-01-01T00:00:00Z")]);
    const { result, rerender } = renderHook(({ projectId }) => useTasks({ projectId }), { initialProps: { projectId: "project-a" } });
    await waitFor(() => expect(result.current.tasks[0]?.description).toBe("Project A task"));

    const projectBFetch = new Promise<Task[]>(() => undefined);
    fetchTasks.mockImplementationOnce(() => projectBFetch);
    rerender({ projectId: "project-b" });
    await waitFor(() => expect(result.current.tasks.map((row) => row.description)).toEqual(["Project B cached task"]));

    vi.mocked(swrCache.readCache).mockReturnValue(null);
    const projectCFetch = new Promise<Task[]>(() => undefined);
    fetchTasks.mockImplementationOnce(() => projectCFetch);
    rerender({ projectId: "project-c" });
    await waitFor(() => expect(result.current.tasks).toEqual([]));
  });

  it("uses the switched project's identity for mutations issued from the board", async () => {
    fetchTasks.mockResolvedValueOnce([task("Project A task", "2026-01-01T00:00:00Z")]);
    fetchTasks.mockResolvedValueOnce([task("Project B task", "2026-01-02T00:00:00Z")]);
    vi.mocked(api.moveTask).mockResolvedValue(task("Project B moved", "2026-01-03T00:00:00Z"));
    const { result, rerender } = renderHook(({ projectId }) => useTasks({ projectId }), { initialProps: { projectId: "project-a" } });
    await waitFor(() => expect(result.current.tasks[0]?.description).toBe("Project A task"));
    rerender({ projectId: "project-b" });
    await waitFor(() => expect(result.current.tasks[0]?.description).toBe("Project B task"));

    await act(async () => { await result.current.moveTask("KB-001", "in-progress"); });
    expect(api.moveTask).toHaveBeenCalledWith("KB-001", "in-progress", "project-b", undefined);
  });

  it("accepts legacy events without project identity",  async () => {
    fetchTasks.mockResolvedValueOnce([task("Project A task", "2026-01-01T00:00:00Z")]);
    const { result } = renderHook(() => useTasks({ projectId: "project-a" }));
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    act(() => MockEventSource.instances.at(-1)?.emit("task:updated", task("Legacy update", "2026-01-02T00:00:00Z")));
    await waitFor(() => expect(result.current.tasks[0]?.description).toBe("Legacy update"));
  });

  /*
  FNXC:TaskMutationProjectScope 2026-10-07-17:59:
  A mutation response belongs to the project it was issued from. It may change visible rows only while those rows still belong to that project, it updates only that project's cache, and it never invalidates another project's pending board fetch.
  Task ids are project-local, so project B's colliding KB-001 must never be replaced by project A's response.
  */
  describe("deferred mutation responses across a project switch", () => {
    type MutationCase = {
      name: string;
      arm: (row: Task) => void;
      invoke: (hook: ReturnType<typeof useTasks>) => Promise<unknown>;
    };

    let release: (() => void) | undefined;
    function deferApi<T>(mock: { mockImplementationOnce: (fn: () => Promise<T>) => unknown }, value: () => T): void {
      mock.mockImplementationOnce(() => new Promise<T>((resolve) => { release = () => resolve(value()); }));
    }

    const mutated = () => ({ ...task("A mutated", "2026-02-01T00:00:00Z"), column: "in-progress" } as Task);
    const created = () => ({ ...task("A created", "2026-02-01T00:00:00Z"), id: "KB-002" } as Task);

    const cases: MutationCase[] = [
      { name: "retryTask", arm: () => deferApi(vi.mocked(api.retryTask), mutated), invoke: (h) => h.retryTask("KB-001") },
      { name: "bypassReview", arm: () => deferApi(vi.mocked(api.bypassReview), mutated), invoke: (h) => h.bypassReview("KB-001", "operator") },
      { name: "resumeWorkflowStep", arm: () => deferApi(vi.mocked(api.resumeWorkflowStep), mutated), invoke: (h) => h.resumeWorkflowStep("KB-001", "WS-001", "operator") },
      { name: "moveTask", arm: () => deferApi(vi.mocked(api.moveTask), mutated), invoke: (h) => h.moveTask("KB-001", "in-progress") },
      { name: "pauseTask", arm: () => deferApi(vi.mocked(api.pauseTask), mutated), invoke: (h) => h.pauseTask("KB-001") },
      { name: "unpauseTask", arm: () => deferApi(vi.mocked(api.unpauseTask), mutated), invoke: (h) => h.unpauseTask("KB-001") },
      { name: "resetTask", arm: () => deferApi(vi.mocked(api.resetTask), mutated), invoke: (h) => h.resetTask("KB-001") },
      { name: "updateTask", arm: () => deferApi(vi.mocked(api.updateTask), mutated), invoke: (h) => h.updateTask("KB-001", { title: "A mutated" }) },
      { name: "archiveTask", arm: () => deferApi(vi.mocked(api.archiveTask), mutated), invoke: (h) => h.archiveTask("KB-001") },
      { name: "unarchiveTask", arm: () => deferApi(vi.mocked(api.unarchiveTask), mutated), invoke: (h) => h.unarchiveTask("KB-001") },
      { name: "archiveAllDone", arm: () => deferApi(vi.mocked(api.archiveAllDone), () => ({ archived: [mutated()], skipped: [] }) as never), invoke: (h) => h.archiveAllDone() },
      { name: "deleteTask", arm: () => deferApi(vi.mocked(api.deleteTask), mutated), invoke: (h) => h.deleteTask("KB-001") },
      { name: "createTask", arm: () => deferApi(vi.mocked(api.createTask), created), invoke: (h) => h.createTask({ description: "A created" } as never) },
      { name: "duplicateTask", arm: () => deferApi(vi.mocked(api.duplicateTask), created), invoke: (h) => h.duplicateTask("KB-001") },
    ];

    const cacheWritesFor = (projectId: string) => vi.mocked(swrCache.writeCache).mock.calls
      .filter(([key]) => key === `${swrCache.SWR_CACHE_KEYS.TASKS_PREFIX}${projectId}`)
      .map(([, payload]) => JSON.stringify(payload));

    async function startInProjectA(mutation: MutationCase) {
      fetchTasks.mockResolvedValueOnce([task("Project A task", "2026-01-01T00:00:00Z")]);
      const hook = renderHook(({ projectId }) => useTasks({ projectId }), { initialProps: { projectId: "project-a" } });
      await waitFor(() => expect(hook.result.current.tasks[0]?.description).toBe("Project A task"));
      mutation.arm(task("Project A task", "2026-01-01T00:00:00Z"));
      let pending!: Promise<unknown>;
      act(() => { pending = mutation.invoke(hook.result.current).catch(() => undefined); });
      return { ...hook, pending };
    }

    it.each(cases)("$name: a late response leaves project B's colliding row and cache untouched", async (mutation) => {
      const { result, rerender, pending } = await startInProjectA(mutation);
      fetchTasks.mockResolvedValueOnce([task("Project B task", "2026-01-02T00:00:00Z")]);
      rerender({ projectId: "project-b" });
      await waitFor(() => expect(result.current.tasks.map((row) => row.description)).toEqual(["Project B task"]));

      await act(async () => { release?.(); await pending; });

      expect(result.current.tasks.map((row) => row.description)).toEqual(["Project B task"]);
      expect(cacheWritesFor("project-b").join("")).not.toMatch(/A mutated|A created/);
      // Project A had no cache entry, so its cache must not be rebuilt from project B's rows.
      expect(cacheWritesFor("project-a").join("")).not.toContain("Project B task");
    });

    it.each(cases)("$name: a late response does not discard project B's pending board fetch", async (mutation) => {
      const { result, rerender, pending } = await startInProjectA(mutation);
      let resolveProjectB!: (rows: Task[]) => void;
      fetchTasks.mockImplementationOnce(() => new Promise<Task[]>((resolve) => { resolveProjectB = resolve; }));
      rerender({ projectId: "project-b" });
      await waitFor(() => expect(resolveProjectB).toBeTypeOf("function"));

      await act(async () => { release?.(); await pending; });
      await act(async () => { resolveProjectB([task("Project B task", "2026-01-02T00:00:00Z")]); });

      await waitFor(() => expect(result.current.tasks.map((row) => row.description)).toEqual(["Project B task"]));
    });

    it.each(cases.filter((mutation) => !["deleteTask", "createTask", "duplicateTask", "archiveAllDone"].includes(mutation.name)))(
      "$name: a late response updates project A's own cache when it exists",
      async (mutation) => {
        vi.mocked(swrCache.readCache).mockImplementation((key) =>
          key === `${swrCache.SWR_CACHE_KEYS.TASKS_PREFIX}project-a` ? [task("Project A cached", "2026-01-01T00:00:00Z")] : null,
        );
        const { result, rerender, pending } = await startInProjectA(mutation);
        fetchTasks.mockResolvedValueOnce([task("Project B task", "2026-01-02T00:00:00Z")]);
        rerender({ projectId: "project-b" });
        await waitFor(() => expect(result.current.tasks.map((row) => row.description)).toEqual(["Project B task"]));
        vi.mocked(swrCache.writeCache).mockClear();

        await act(async () => { release?.(); await pending; });

        const writes = cacheWritesFor("project-a");
        if (["retryTask", "bypassReview", "resumeWorkflowStep", "moveTask", "pauseTask", "unpauseTask", "resetTask"].includes(mutation.name)) {
          expect(writes.at(-1)).toContain("A mutated");
        }
        expect(writes.join("")).not.toContain("Project B task");
      },
    );

    it.each(cases.filter((mutation) => ["retryTask", "moveTask", "updateTask"].includes(mutation.name)))(
      "$name: after A -> B -> A the response reconciles project A's visible row",
      async (mutation) => {
        const { result, rerender, pending } = await startInProjectA(mutation);
        fetchTasks.mockResolvedValueOnce([task("Project B task", "2026-01-02T00:00:00Z")]);
        rerender({ projectId: "project-b" });
        await waitFor(() => expect(result.current.tasks.map((row) => row.description)).toEqual(["Project B task"]));
        fetchTasks.mockResolvedValueOnce([task("Project A task", "2026-01-01T00:00:00Z")]);
        rerender({ projectId: "project-a" });
        await waitFor(() => expect(result.current.tasks.map((row) => row.description)).toEqual(["Project A task"]));

        await act(async () => { release?.(); await pending; });

        expect(result.current.tasks.map((row) => row.description)).toEqual(["A mutated"]);
      },
    );
  });
});
