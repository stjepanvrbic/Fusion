import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectEngine } from "../project-engine.js";
import {
  clearPreHeldExecutorSlotsForTests,
  projectAdmissionCoordinator,
  type AdmissionCandidate,
} from "../concurrency/concurrency.js";

/*
FNXC:ConcurrencyAdmission 2026-10-08-09:56:
KB-065 engine-level proof. On 2026-10-08 (maxConcurrent=7) 24 approved cards waited for merge behind six
executors: each merge was capacity-deferred and removed from the queue, and the next hold-release sweep gave
the freed slot to a new executor. ProjectEngine now registers a merge-lane demand probe so the coordinator
refuses execute/planning admission at limit - 1 while a merge is pending (queued, capacity-deferred, or
dequeued but not yet admitted) and the merge lane holds no slot. The pump stays single-flight.
*/

const mocks = vi.hoisted(() => ({
  runtimeStart: vi.fn(async () => undefined),
  runtimeStop: vi.fn(async () => undefined),
  runAiMerge: vi.fn(),
  currentStore: null as Record<string, unknown> | null,
}));

vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../test/mockCore.js");
  return createEngineCoreMock(() => importOriginal<typeof import("@fusion/core")>(), {
    AutomationStore: class MockAutomationStore {
      init = vi.fn(async () => undefined);
    },
    syncInsightExtractionAutomation: vi.fn(),
    syncAutoSummarizeAutomation: vi.fn(),
    syncMemoryDreamsAutomation: vi.fn(),
    syncScheduledEvalBatchAutomation: vi.fn(),
  });
});

vi.mock("../project/postgres-migration-notice.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/postgres-migration-notice.js")>()),
  deliverPostgresMigrationCompleteNoticeIfNeeded: vi.fn(async () => "no-migration"),
}));

vi.mock("../scheduling/cron-runner.js", () => ({
  CronRunner: vi.fn().mockImplementation(function () { return { start: vi.fn(), stop: vi.fn() }; }),
  createAiPromptExecutor: vi.fn(async () => vi.fn()),
}));

vi.mock("../merger.js", () => ({
  sweepStaleAutostashes: vi.fn(async () => ({ dropped: 0, retained: 0 })),
  VerificationError: class VerificationError extends Error {},
}));

vi.mock("../merge/merger-ai.js", () => {
  class NamedError extends Error {}
  return {
    runAiMerge: mocks.runAiMerge,
    landWorkspaceTask: vi.fn(),
    WorkspaceRepoLandBusyError: class extends NamedError {},
    WorkspacePartialLandError: class extends NamedError {},
    WorkspaceFinalizeBlockedError: class extends NamedError {},
    WorkspaceReviewRequiredError: class extends NamedError {},
    WorkspaceMergeDispatchSupersededError: class extends NamedError {},
    WorkspaceMergeTechnicalError: class extends NamedError {},
  };
});

vi.mock("../merge/integration-branch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../merge/integration-branch.js")>()),
  resolveIntegrationBranch: vi.fn().mockResolvedValue("main"),
  resolveIntegrationBranchSync: vi.fn().mockReturnValue("main"),
  __resetIntegrationBranchCacheForTests: vi.fn(),
}));

vi.mock("../merge/pr-monitor.js", () => ({
  PrMonitor: vi.fn().mockImplementation(function () { return { onNewComments: vi.fn() }; }),
}));
vi.mock("../merge/pr-comment-handler.js", () => ({
  PrCommentHandler: vi.fn().mockImplementation(function () {
    return { handleNewComments: vi.fn(), createFollowUpTask: vi.fn(async () => undefined) };
  }),
}));
vi.mock("../util/notifier.js", () => ({
  NtfyNotifier: vi.fn().mockImplementation(function () {
    return { start: vi.fn(async () => undefined), stop: vi.fn(), notifyGridlock: vi.fn() };
  }),
}));
vi.mock("../notification/index.js", () => {
  const lifecycle = () => vi.fn().mockImplementation(function () {
    return { start: vi.fn(async () => undefined), stop: vi.fn() };
  });
  return {
    NotificationService: lifecycle(),
    OAuthAlertStateStore: vi.fn().mockImplementation(function () { return {}; }),
    OAuthExpiryMonitor: lifecycle(),
    OAuthRefreshScheduler: lifecycle(),
    OAuthValidityLogger: lifecycle(),
  };
});
vi.mock("../auth/auth-storage.js", () => ({
  createFusionAuthStorage: vi.fn(() => ({ reload: vi.fn(), getOAuthProviders: vi.fn(() => []), get: vi.fn(() => undefined) })),
  getFusionOAuthAlertStatePath: vi.fn(() => "oauth-alert-state.json"),
}));
vi.mock("../runtimes/in-process-runtime.js", () => ({
  InProcessRuntime: vi.fn().mockImplementation(function () {
    return {
      start: mocks.runtimeStart,
      stop: mocks.runtimeStop,
      resumeAfterUnpause: vi.fn(async () => undefined),
      setFailedNoVerdictPreMergeReviewRerouter: vi.fn(),
      getTaskStore: () => mocks.currentStore,
      getPluginRunner: vi.fn(() => undefined),
      getAgentStore: vi.fn(),
      getMessageStore: vi.fn(),
      getRoutineStore: vi.fn(),
      getRoutineRunner: vi.fn(),
      getHeartbeatMonitor: vi.fn(),
      getTriggerScheduler: vi.fn(),
      getSelfHealingManager: vi.fn(() => undefined),
      configurePrMonitoring: vi.fn(),
    };
  }),
}));

/** Admission key used by the scheduler, triage, continuation, and merge one-shot lanes. */
const STORE_ROOT = "proj-root-kb065";
/** Config id the registered `merge:` provider is keyed under. */
const CONFIG_PROJECT_ID = "proj_kb065";
const LIMIT = 2;
const POLL_INTERVAL_MS = 60_000;

const SETTINGS = {
  autoMerge: true,
  globalPause: false,
  enginePaused: false,
  pollIntervalMs: POLL_INTERVAL_MS,
  maxConcurrent: LIMIT,
  maxWorktrees: LIMIT,
  memoryAutoSummarizeEnabled: false,
  memoryDreamsEnabled: false,
  insightExtractionEnabled: false,
  remoteAccess: { enabled: false },
};

function liveExecutor(id: string) {
  return { id, column: "in-progress", paused: false, status: null, createdAt: "2026-10-08T08:00:00.000Z" };
}

function createStore() {
  /** Live executors reported by the full-row admission snapshot. */
  const live: Array<Record<string, unknown>> = [];
  const settingsGate = { armed: false, release: null as null | (() => void), parked: 0 };
  const store = {
    live,
    settingsGate,
    getRootDir: () => STORE_ROOT,
    getSettings: vi.fn(async () => {
      if (settingsGate.armed) {
        settingsGate.armed = false;
        settingsGate.parked += 1;
        await new Promise<void>((resolve) => { settingsGate.release = resolve; });
      }
      return structuredClone(SETTINGS);
    }),
    getProjectId: vi.fn(() => CONFIG_PROJECT_ID),
    listTasks: vi.fn(async (options?: { slim?: boolean }) => options?.slim === false ? [...live] : []),
    getTask: vi.fn(async (taskId: string) => ({
      id: taskId,
      column: "in-review",
      paused: false,
      userPaused: false,
      mergeRetries: 0,
      status: null,
      steps: [],
      enabledWorkflowSteps: [],
      branch: `fusion/${taskId.toLowerCase()}`,
      createdAt: "2026-10-08T07:00:00.000Z",
    })),
    getStaleReviewCallbackWaiverReceipts: vi.fn(async () => []),
    updateTask: vi.fn(async () => undefined),
    updateTaskAtomic: vi.fn(async () => undefined),
    moveTask: vi.fn(async () => undefined),
    updateSettings: vi.fn(async () => structuredClone(SETTINGS)),
    logEntry: vi.fn(async () => undefined),
    getAsyncLayer: vi.fn(() => ({ kind: "test-async-layer" })),
    parseFileScopeFromPrompt: vi.fn(async () => []),
    getCompletionHandoffAcceptedMarker: vi.fn(() => null),
    emit: vi.fn(),
    addTaskComment: vi.fn(async () => undefined),
    getActiveMergingTask: vi.fn(() => null),
    getBranchGroup: vi.fn(() => null),
    on: vi.fn(),
    off: vi.fn(),
  };
  return store;
}

function createEngine() {
  return new ProjectEngine(
    {
      projectId: CONFIG_PROJECT_ID,
      workingDirectory: STORE_ROOT,
      isolationMode: "in-process",
      maxConcurrent: LIMIT,
      maxWorktrees: LIMIT,
    },
    {} as never,
    { skipNotifier: true },
  );
}

type PrivateEngine = {
  mergeQueue: string[];
  capacityDeferredMergeTaskIds: Set<string>;
  coordinatorAdmittedMergeTaskIds: Set<string>;
  mergeLaneDequeuedTaskId: string | null;
};

function executeCandidate(taskId: string): AdmissionCandidate & { start: ReturnType<typeof vi.fn> } {
  return { taskId, projectId: STORE_ROOT, lane: "execute", createdAt: "2026-10-08T06:00:00.000Z", start: vi.fn(async () => true) };
}

/** Scheduler-shaped hold-release pass: one execute candidate at the given occupancy. */
async function sweepExecute(candidate: AdmissionCandidate, claimed: number, claimedTaskIds?: string[]) {
  const onLaneReservationHold = vi.fn();
  const admitted = await projectAdmissionCoordinator.admitNext({
    projectId: STORE_ROOT,
    maxConcurrent: LIMIT,
    claimed: () => claimed,
    ...(claimedTaskIds ? { claimedTaskIds: () => claimedTaskIds } : {}),
    refresh: async () => [candidate],
    onLaneReservationHold,
  });
  projectAdmissionCoordinator.releaseReservation(candidate.taskId);
  return { admitted, onLaneReservationHold };
}

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe("merge-lane slot reservation (KB-065)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runAiMerge.mockReset();
    projectAdmissionCoordinator.clearReservationsForTests();
    clearPreHeldExecutorSlotsForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    projectAdmissionCoordinator.clearReservationsForTests();
    clearPreHeldExecutorSlotsForTests();
  });

  it("gives the freed slot to the capacity-deferred merge even when a hold-release sweep runs first", async () => {
    const store = createStore();
    store.live.push(liveExecutor("FN-E1"), liveExecutor("FN-E2"));
    mocks.currentStore = store;
    mocks.runAiMerge.mockResolvedValue({ merged: true, task: { id: "FN-M" } });
    const engine = createEngine();
    await engine.start();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const privateEngine = engine as unknown as PrivateEngine;

    engine.enqueueMerge("FN-M");
    await vi.waitFor(() => expect(privateEngine.capacityDeferredMergeTaskIds.has("FN-M")).toBe(true));
    expect(privateEngine.mergeQueue).toEqual([]);
    expect(mocks.runAiMerge).not.toHaveBeenCalled();

    // One executor finishes; the scheduler's sweep runs before the merge's retry timer.
    store.live.pop();
    const executor = executeCandidate("FN-NEW-EXEC");
    const { admitted, onLaneReservationHold } = await sweepExecute(executor, 1);
    expect(admitted).toBeUndefined();
    expect(executor.start).not.toHaveBeenCalled();
    expect(onLaneReservationHold).toHaveBeenCalledWith(expect.objectContaining({
      lane: "execute", occupied: 1, maxConcurrent: LIMIT, heldBackSlots: 1,
    }));

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await vi.waitFor(() => expect(mocks.runAiMerge).toHaveBeenCalledTimes(1));
    expect(mocks.runAiMerge).toHaveBeenCalledWith(store, STORE_ROOT, "FN-M", expect.any(Object));
    vi.useRealTimers();
    await engine.stop();
  });

  it("lets executors use every slot when no merge is pending", async () => {
    const store = createStore();
    mocks.currentStore = store;
    const engine = createEngine();
    await engine.start();

    const executor = executeCandidate("FN-LAST-SLOT");
    const { admitted, onLaneReservationHold } = await sweepExecute(executor, LIMIT - 1);
    expect(admitted).toBe("FN-LAST-SLOT");
    expect(executor.start).toHaveBeenCalledTimes(1);
    expect(onLaneReservationHold).not.toHaveBeenCalled();
    await engine.stop();
  });

  it("never runs or reserves two merges at once, and holds no extra slot while one runs", async () => {
    const store = createStore();
    mocks.currentStore = store;
    let running = 0;
    let maxRunning = 0;
    let releaseA!: () => void;
    mocks.runAiMerge.mockImplementation(async (_store: unknown, _cwd: string, taskId: string) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      if (taskId === "FN-A") await new Promise<void>((resolve) => { releaseA = resolve; });
      running -= 1;
      return { merged: true, task: { id: taskId } };
    });
    const engine = createEngine();
    await engine.start();
    const privateEngine = engine as unknown as PrivateEngine;

    engine.enqueueMerge("FN-A");
    await vi.waitFor(() => expect(mocks.runAiMerge).toHaveBeenCalledTimes(1));
    engine.enqueueMerge("FN-B");
    expect(privateEngine.mergeQueue).toEqual(["FN-B"]);

    // The registered merge provider offers nothing while merge A holds the lane's slot.
    const providerPass = await projectAdmissionCoordinator.admitNext({
      projectId: CONFIG_PROJECT_ID,
      maxConcurrent: LIMIT,
      claimed: () => 0,
    });
    expect(providerPass).toBeUndefined();
    expect(privateEngine.coordinatorAdmittedMergeTaskIds.has("FN-B")).toBe(false);

    // Merge A already holds its slot (counted in claimed), so no second slot is withheld.
    const executor = executeCandidate("FN-EXEC");
    const { admitted } = await sweepExecute(executor, LIMIT - 1, ["FN-A"]);
    expect(admitted).toBe("FN-EXEC");
    expect(mocks.runAiMerge).toHaveBeenCalledTimes(1);

    releaseA();
    await vi.waitFor(() => expect(mocks.runAiMerge).toHaveBeenCalledTimes(2));
    expect(mocks.runAiMerge.mock.calls.map((call) => call[2])).toEqual(["FN-A", "FN-B"]);
    expect(maxRunning).toBe(1);
    await engine.stop();
  });

  it("refuses an executor while the pump holds a dequeued merge that is not admitted yet", async () => {
    const store = createStore();
    mocks.currentStore = store;
    store.live.push(liveExecutor("FN-E1"));
    mocks.runAiMerge.mockResolvedValue({ merged: true, task: { id: "FN-D" } });
    const engine = createEngine();
    await engine.start();
    const privateEngine = engine as unknown as PrivateEngine;

    // Park the pump on the first store read after dequeue, before its own admission.
    store.settingsGate.armed = true;
    engine.enqueueMerge("FN-D");
    await vi.waitFor(() => expect(store.settingsGate.parked).toBe(1));
    expect(privateEngine.mergeQueue).toEqual([]);
    expect(privateEngine.capacityDeferredMergeTaskIds.has("FN-D")).toBe(false);
    expect(privateEngine.mergeLaneDequeuedTaskId).toBe("FN-D");

    const executor = executeCandidate("FN-SWEEP");
    const { admitted } = await sweepExecute(executor, LIMIT - 1);
    expect(admitted).toBeUndefined();
    expect(executor.start).not.toHaveBeenCalled();

    store.settingsGate.release?.();
    await vi.waitFor(() => expect(mocks.runAiMerge).toHaveBeenCalledTimes(1));
    expect(mocks.runAiMerge).toHaveBeenCalledWith(store, STORE_ROOT, "FN-D", expect.any(Object));
    await flush();
    await engine.stop();
  });

  it("unregisters the merge-lane probe on stop", async () => {
    const store = createStore();
    mocks.currentStore = store;
    const engine = createEngine();
    await engine.start();
    expect(projectAdmissionCoordinator.inspectProjectStateForTests(STORE_ROOT).mergeLaneReservationRegistered).toBe(true);
    await engine.stop();
    expect(projectAdmissionCoordinator.inspectProjectStateForTests(STORE_ROOT).mergeLaneReservationRegistered).toBe(false);
  });
});
