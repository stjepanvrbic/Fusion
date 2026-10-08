// port-4040-allowlist: never kill port 4040. FNXC:CodeOrganization 2026-08-04-09:45: thin TaskExecutor shell (U4).
export * from "./executor/executor-reexports.js";
import { executorLog } from "./logger.js";
import { type TaskStore, type Task, type MergeResult, type TaskMoveLanes, dropPreHeldExecutorSlot, wireTaskExecutorLifecycle, type TaskExecutorOptions, TaskExecutorGraphFacades } from "./executor/task-executor-imports.js";
export class TaskExecutor extends TaskExecutorGraphFacades {
  private isBackwardMoveOutOfPlanning(_taskId: string, from: string, to: string, moveLanes: TaskMoveLanes | undefined): boolean { const lanes = moveLanes ?? { hold: "todo", intake: "triage", wip: "in-progress", review: "in-review", complete: "done" }; return (from === lanes.hold || from === lanes.intake) && ![lanes.wip, lanes.review, lanes.complete].filter((c): c is string => typeof c === "string").includes(to); }
  setOnExecutorLogFlushed(cb: TaskExecutorOptions["onExecutorLogFlushed"]): void { this.options = { ...this.options, onExecutorLogFlushed: cb }; }
  constructor(store: TaskStore, rootDir: string, options: TaskExecutorOptions = {}) { super(); this.store = store; this.rootDir = rootDir; this.options = options; wireTaskExecutorLifecycle(this); }
  setMergeRequester(requestMerge: (taskId: string, options?: { signal?: AbortSignal; graphOwnedPostMergeTraversal?: boolean }) => Promise<MergeResult>): void { this.mergeRequester = requestMerge; }
  setFailedNoVerdictPreMergeReviewRerouter(reroute: (task: Task) => Promise<"rerouted" | "pending" | "changed" | "unavailable" | "not-applicable">): void { this.rerouteFailedNoVerdictPreMergeReview = reroute; }
  /**
   * FNXC:ExecutorLifecycle 2026-10-08-07:20:
   * A replaced executor (engine restart in place, project reload, test teardown) must never react to store events again.
   * Idempotent: removes the four store event listeners, the task-move/archive disposer registrations, and the chat-memory capture; each removal is isolated so one throw never strands the rest.
   * Does NOT abort in-flight sessions or remove worktrees; that stays abortAllInFlight's job.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const steps: Array<[string, () => void]> = [["store listeners", () => { this.unregisterStoreListeners?.(); this.unregisterStoreListeners = undefined; }], ["store lifecycle disposers", () => this.disposeStoreLifecycleDisposers()], ["chat memory capture", () => this.detachChatMemoryCapture()]];
    for (const [label, run] of steps) { try { run(); } catch (err) { executorLog.warn(`dispose: failed to release ${label}: ${err instanceof Error ? err.message : String(err)}`); } }
  }
  async execute(task: Task): Promise<void> { try { await this.executeCore(task); } finally { if (dropPreHeldExecutorSlot(task.id)) this.options.semaphore?.release(); } }
}
