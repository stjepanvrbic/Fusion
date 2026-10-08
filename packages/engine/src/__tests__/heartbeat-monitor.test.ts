import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  HeartbeatMonitor,
  type AgentSession,
} from "../agent-heartbeat.js";
import type { AgentStore, AgentHeartbeatRun, TaskStore, Agent, Message } from "@fusion/core";
import { createMockStore, createMockSession, createMockMessageStore, createMessage } from "./heartbeat-test-helpers.js";
vi.mock("../logger.js", async () => {
  const { createMockLogger, formatMockError } = await import("./heartbeat-test-helpers.js");
  return {
    createLogger: vi.fn(() => createMockLogger()),
    heartbeatLog: createMockLogger(),
    formatError: formatMockError,
  };
});
import { heartbeatLog } from "../logger.js";

let store: AgentStore;
let monitor: HeartbeatMonitor;

beforeEach(() => {
  store = createMockStore();
  monitor = new HeartbeatMonitor({ store });
});

afterEach(() => {
  monitor.stop();
  vi.useRealTimers();
});

describe("constructor", () => {
  it("initializes with default options", () => {
    expect(monitor).toBeDefined();
    expect(monitor.isActive()).toBe(false);
  });

  it("accepts custom pollIntervalMs", () => {
    const customMonitor = new HeartbeatMonitor({ store, pollIntervalMs: 5000 });
    expect(customMonitor).toBeDefined();
  });

  it("accepts custom heartbeatTimeoutMs", () => {
    const customMonitor = new HeartbeatMonitor({ store, heartbeatTimeoutMs: 120000 });
    expect(customMonitor).toBeDefined();
  });

  it("accepts callbacks", () => {
    const onMissed = vi.fn();
    const onRecovered = vi.fn();
    const onTerminated = vi.fn();

    const customMonitor = new HeartbeatMonitor({
      store,
      onMissed,
      onRecovered,
      onTerminated,
    });

    expect(customMonitor).toBeDefined();
  });
});


describe("start", () => {
  it("initiates polling interval", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    monitor.start();
    expect(monitor.isActive()).toBe(true);
    vi.useRealTimers();
  });

  it("is idempotent (multiple calls don't create multiple intervals)", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    monitor.start();
    monitor.start();
    monitor.start();

    expect(monitor.isActive()).toBe(true);
    // Stop should clean up properly
    monitor.stop();
    expect(monitor.isActive()).toBe(false);
    vi.useRealTimers();
  });
});

describe("stop", () => {
  it("clears the polling interval", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    monitor.start();
    expect(monitor.isActive()).toBe(true);

    monitor.stop();
    expect(monitor.isActive()).toBe(false);
    vi.useRealTimers();
  });

  it("is safe to call when not started", () => {
    expect(() => monitor.stop()).not.toThrow();
    expect(monitor.isActive()).toBe(false);
  });

  it("is safe to call multiple times", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    monitor.start();
    monitor.stop();
    monitor.stop();
    monitor.stop();

    expect(monitor.isActive()).toBe(false);
    vi.useRealTimers();
  });
});

describe("wake-on-message", () => {
  it("executes heartbeat when messageResponseMode is immediate", async () => {
    let messageHook: ((message: Message) => void) | undefined;
    const messageStore = createMockMessageStore((hook) => {
      messageHook = hook;
    });
    const configStore = createMockStore({
      getCachedAgent: vi.fn().mockReturnValue({
        id: "agent-1",
        state: "active",
        runtimeConfig: { messageResponseMode: "immediate" },
      }),
      getAgent: vi.fn().mockResolvedValue({
        id: "agent-1",
        state: "active",
        runtimeConfig: { messageResponseMode: "immediate" },
      }),
    });

    const customMonitor = new HeartbeatMonitor({
      store,
      agentStore: configStore,
      messageStore,
    });
    const executeHeartbeatSpy = vi
      .spyOn(customMonitor, "executeHeartbeat")
      .mockResolvedValue({ id: "run-1" } as AgentHeartbeatRun);

    customMonitor.start();
    messageHook?.(createMessage({ toId: "agent-1", toType: "agent" }));

    // FNXC:PostgresBackend 2026-06-28: wake-on-message is now async (getAgent);
    // flush microtasks before asserting.
    await vi.waitFor(() => {
      expect(executeHeartbeatSpy).toHaveBeenCalledWith({
        agentId: "agent-1",
        source: "on_demand",
        triggerDetail: "wake-on-message",
        wakeMessage: expect.objectContaining({
          messageId: "msg-001",
          fromType: "user",
          fromId: "user-1",
          forced: false,
        }),
      });
    });

    customMonitor.stop();
  });

  it("does not execute heartbeat when messageResponseMode is on-heartbeat or unset", () => {
    let messageHook: ((message: Message) => void) | undefined;
    const messageStore = createMockMessageStore((hook) => {
      messageHook = hook;
    });
    const getCachedAgent = vi
      .fn()
      .mockReturnValueOnce({
        id: "agent-1",
        state: "active",
        runtimeConfig: { messageResponseMode: "on-heartbeat" },
      })
      .mockReturnValueOnce({
        id: "agent-1",
        state: "active",
        runtimeConfig: {},
      });
    const configStore = createMockStore({ getCachedAgent });

    const customMonitor = new HeartbeatMonitor({
      store,
      agentStore: configStore,
      messageStore,
    });
    const executeHeartbeatSpy = vi
      .spyOn(customMonitor, "executeHeartbeat")
      .mockResolvedValue({ id: "run-1" } as AgentHeartbeatRun);

    customMonitor.start();
    messageHook?.(createMessage({ toId: "agent-1", toType: "agent", id: "msg-1" }));
    messageHook?.(createMessage({ toId: "agent-1", toType: "agent", id: "msg-2" }));

    expect(executeHeartbeatSpy).not.toHaveBeenCalled();

    customMonitor.stop();
  });

  it("does not execute heartbeat when agent is paused or error", () => {
    let messageHook: ((message: Message) => void) | undefined;
    const messageStore = createMockMessageStore((hook) => {
      messageHook = hook;
    });
    const getCachedAgent = vi
      .fn()
      .mockReturnValueOnce({
        id: "agent-1",
        state: "paused",
        runtimeConfig: { messageResponseMode: "immediate" },
      })
      .mockReturnValueOnce({
        id: "agent-1",
        state: "error",
        runtimeConfig: { messageResponseMode: "immediate" },
      });
    const configStore = createMockStore({ getCachedAgent });

    const customMonitor = new HeartbeatMonitor({
      store,
      agentStore: configStore,
      messageStore,
    });
    const executeHeartbeatSpy = vi
      .spyOn(customMonitor, "executeHeartbeat")
      .mockResolvedValue({ id: "run-1" } as AgentHeartbeatRun);

    customMonitor.start();
    messageHook?.(createMessage({ toId: "agent-1", toType: "agent", id: "msg-paused" }));
    messageHook?.(createMessage({ toId: "agent-1", toType: "agent", id: "msg-error" }));

    expect(executeHeartbeatSpy).not.toHaveBeenCalled();

    customMonitor.stop();
  });

  it("forces a wake when metadata.wakeRecipient overrides on-heartbeat mode", async () => {
    let messageHook: ((message: Message) => void) | undefined;
    const messageStore = createMockMessageStore((hook) => {
      messageHook = hook;
    });
    const configStore = createMockStore({
      getCachedAgent: vi.fn().mockReturnValue({
        id: "agent-1",
        state: "active",
        runtimeConfig: { messageResponseMode: "on-heartbeat" },
      }),
      getAgent: vi.fn().mockResolvedValue({
        id: "agent-1",
        state: "active",
        runtimeConfig: { messageResponseMode: "on-heartbeat" },
      }),
    });

    const customMonitor = new HeartbeatMonitor({
      store,
      agentStore: configStore,
      messageStore,
    });
    const executeHeartbeatSpy = vi
      .spyOn(customMonitor, "executeHeartbeat")
      .mockResolvedValue({ id: "run-1" } as AgentHeartbeatRun);

    customMonitor.start();
    messageHook?.(
      createMessage({
        toId: "agent-1",
        toType: "agent",
        metadata: { wakeRecipient: true },
      }),
    );

    await vi.waitFor(() => {
      expect(executeHeartbeatSpy).toHaveBeenCalledWith({
        agentId: "agent-1",
        source: "on_demand",
        triggerDetail: "wake-on-message-forced",
        wakeMessage: expect.objectContaining({
          messageId: "msg-001",
          fromType: "user",
          fromId: "user-1",
          forced: true,
        }),
      });
    });

    customMonitor.stop();
  });

  it("forces a wake even when messageResponseMode is unset", async () => {
    let messageHook: ((message: Message) => void) | undefined;
    const messageStore = createMockMessageStore((hook) => {
      messageHook = hook;
    });
    const configStore = createMockStore({
      getCachedAgent: vi.fn().mockReturnValue({
        id: "agent-1",
        state: "idle",
        runtimeConfig: {},
      }),
      getAgent: vi.fn().mockResolvedValue({
        id: "agent-1",
        state: "idle",
        runtimeConfig: {},
      }),
    });

    const customMonitor = new HeartbeatMonitor({
      store,
      agentStore: configStore,
      messageStore,
    });
    const executeHeartbeatSpy = vi
      .spyOn(customMonitor, "executeHeartbeat")
      .mockResolvedValue({ id: "run-1" } as AgentHeartbeatRun);

    customMonitor.start();
    messageHook?.(
      createMessage({
        toId: "agent-1",
        toType: "agent",
        metadata: { wakeRecipient: true },
      }),
    );

    await vi.waitFor(() => {
      expect(executeHeartbeatSpy).toHaveBeenCalledWith({
        agentId: "agent-1",
        source: "on_demand",
        triggerDetail: "wake-on-message-forced",
        wakeMessage: expect.objectContaining({
          messageId: "msg-001",
          fromType: "user",
          fromId: "user-1",
          forced: true,
        }),
      });
    });

    customMonitor.stop();
  });

  it("ignores wakeRecipient metadata when sender is an agent (only humans may force wakes)", () => {
    let messageHook: ((message: Message) => void) | undefined;
    const messageStore = createMockMessageStore((hook) => {
      messageHook = hook;
    });
    const configStore = createMockStore({
      getCachedAgent: vi.fn().mockReturnValue({
        id: "agent-1",
        state: "active",
        runtimeConfig: { messageResponseMode: "on-heartbeat" },
      }),
    });

    const customMonitor = new HeartbeatMonitor({
      store,
      agentStore: configStore,
      messageStore,
    });
    const executeHeartbeatSpy = vi
      .spyOn(customMonitor, "executeHeartbeat")
      .mockResolvedValue({ id: "run-1" } as AgentHeartbeatRun);

    customMonitor.start();
    messageHook?.(
      createMessage({
        toId: "agent-1",
        toType: "agent",
        fromId: "agent-2",
        fromType: "agent",
        metadata: { wakeRecipient: true },
      }),
    );

    expect(executeHeartbeatSpy).not.toHaveBeenCalled();

    customMonitor.stop();
  });

  it("still respects state gating when wakeRecipient is set (paused agent stays paused)", () => {
    let messageHook: ((message: Message) => void) | undefined;
    const messageStore = createMockMessageStore((hook) => {
      messageHook = hook;
    });
    const configStore = createMockStore({
      getCachedAgent: vi.fn().mockReturnValue({
        id: "agent-1",
        state: "paused",
        runtimeConfig: {},
      }),
    });

    const customMonitor = new HeartbeatMonitor({
      store,
      agentStore: configStore,
      messageStore,
    });
    const executeHeartbeatSpy = vi
      .spyOn(customMonitor, "executeHeartbeat")
      .mockResolvedValue({ id: "run-1" } as AgentHeartbeatRun);

    customMonitor.start();
    messageHook?.(
      createMessage({
        toId: "agent-1",
        toType: "agent",
        metadata: { wakeRecipient: true },
      }),
    );

    expect(executeHeartbeatSpy).not.toHaveBeenCalled();

    customMonitor.stop();
  });

  it("registers the message hook on start and clears it on stop", () => {
    const hooks: Array<(message: Message) => void> = [];
    const messageStore = createMockMessageStore((hook) => {
      hooks.push(hook);
    });
    const customMonitor = new HeartbeatMonitor({ store, messageStore });

    customMonitor.start();

    expect(messageStore.setMessageToAgentHook).toHaveBeenCalledTimes(1);
    expect(hooks).toHaveLength(1);

    customMonitor.stop();

    expect(messageStore.setMessageToAgentHook).toHaveBeenCalledTimes(2);
    expect(hooks).toHaveLength(2);
    expect(hooks[0]).not.toBe(hooks[1]);
  });

  it("ignores non-agent messages", () => {
    let messageHook: ((message: Message) => void) | undefined;
    const messageStore = createMockMessageStore((hook) => {
      messageHook = hook;
    });
    const configStore = createMockStore({
      getCachedAgent: vi.fn().mockReturnValue({
        id: "agent-1",
        state: "active",
        runtimeConfig: { messageResponseMode: "immediate" },
      }),
    });
    const customMonitor = new HeartbeatMonitor({
      store,
      agentStore: configStore,
      messageStore,
    });
    const executeHeartbeatSpy = vi
      .spyOn(customMonitor, "executeHeartbeat")
      .mockResolvedValue({ id: "run-1" } as AgentHeartbeatRun);

    customMonitor.start();
    messageHook?.(createMessage({ toType: "user", toId: "user-1" }));

    expect(executeHeartbeatSpy).not.toHaveBeenCalled();

    customMonitor.stop();
  });

  describe("createHeartbeatTools - message tools", () => {
    let mockTaskStore: TaskStore;
    let mockSession: ReturnType<typeof createMockSession>;
    let capturedTools: any[] = [];

    beforeEach(() => {
      mockTaskStore = {
        createTask: vi.fn().mockResolvedValue({ id: "FN-002", description: "test", dependencies: [], column: "triage" }),
        logEntry: vi.fn().mockResolvedValue(undefined),
        upsertTaskDocument: vi.fn().mockResolvedValue({
          id: "doc-1", taskId: "FN-001", key: "test", content: "test", revision: 1, author: "agent",
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }),
        getTaskDocument: vi.fn().mockResolvedValue(null),
        getTaskDocuments: vi.fn().mockResolvedValue([]),
      } as unknown as TaskStore;
      mockSession = createMockSession();
      capturedTools = [];
    });

    it("includes fn_send_message and fn_read_messages tools when messageStore is available", () => {
      const messageStore = createMockMessageStore();
      const customMonitor = new HeartbeatMonitor({
        store,
        messageStore,
        taskStore: mockTaskStore,
        rootDir: "/tmp",
      });

      const tools = customMonitor.createHeartbeatTools("agent-001", mockTaskStore, "FN-001", undefined, undefined, messageStore);
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).toContain("fn_send_message");
      expect(toolNames).toContain("fn_read_messages");
    });

    it("does not include message tools when messageStore is not provided", () => {
      const customMonitor = new HeartbeatMonitor({
        store,
        taskStore: mockTaskStore,
        rootDir: "/tmp",
      });

      const tools = customMonitor.createHeartbeatTools("agent-001", mockTaskStore, "FN-001");
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).not.toContain("fn_send_message");
      expect(toolNames).not.toContain("fn_read_messages");
    });

    it("does not include message tools when messageStore is undefined even if other params are passed", () => {
      const customMonitor = new HeartbeatMonitor({
        store,
        taskStore: mockTaskStore,
        rootDir: "/tmp",
      });

      const tools = customMonitor.createHeartbeatTools(
        "agent-001",
        mockTaskStore,
        "FN-001",
        undefined,
        undefined,
        undefined
      );
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).not.toContain("fn_send_message");
      expect(toolNames).not.toContain("fn_read_messages");
    });
  });
});

describe("isActive", () => {
  it("reflects monitor state (false when not started)", () => {
    expect(monitor.isActive()).toBe(false);
  });

  it("reflects monitor state (true when started)", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    monitor.start();
    expect(monitor.isActive()).toBe(true);
    vi.useRealTimers();
  });

  it("reflects monitor state (false after stopped)", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    monitor.start();
    monitor.stop();
    expect(monitor.isActive()).toBe(false);
    vi.useRealTimers();
  });
});

describe("trackAgent", () => {
  it("adds agent to tracked set with correct initial state", () => {
    const session = createMockSession();
    const before = Date.now();

    monitor.trackAgent("agent-001", session, "run-001");
    const lastSeen = monitor.getLastSeen("agent-001");

    expect(lastSeen).toBeDefined();
    expect(lastSeen).toBeGreaterThanOrEqual(before);
    expect(monitor.getTrackedAgents()).toContain("agent-001");
  });

  it("records initial heartbeat to store", () => {
    const session = createMockSession();
    monitor.trackAgent("agent-001", session, "run-001");

    expect(store.recordHeartbeat).toHaveBeenCalledWith("agent-001", "ok", "run-001");
  });

  it("can track multiple agents", () => {
    monitor.trackAgent("agent-001", createMockSession(), "run-001");
    monitor.trackAgent("agent-002", createMockSession(), "run-002");
    monitor.trackAgent("agent-003", createMockSession(), "run-003");

    expect(monitor.getTrackedAgents()).toHaveLength(3);
    expect(monitor.getTrackedAgents()).toContain("agent-001");
    expect(monitor.getTrackedAgents()).toContain("agent-002");
    expect(monitor.getTrackedAgents()).toContain("agent-003");
  });
});

describe("recordHeartbeat", () => {
  it("updates lastSeen timestamp", () => {
    const session = createMockSession();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    monitor.trackAgent("agent-001", session, "run-001");
    const initialLastSeen = monitor.getLastSeen("agent-001")!;

    vi.advanceTimersByTime(100);
    monitor.recordHeartbeat("agent-001");

    const newLastSeen = monitor.getLastSeen("agent-001")!;
    expect(newLastSeen).toBeGreaterThan(initialLastSeen);

    vi.useRealTimers();
  });

  /*
  FNXC:AgentHeartbeat 2026-10-07-18:24:
  recordHeartbeat runs on every session event, so it persists an "ok" heartbeat at most once per 30s while in-memory lastSeen updates on every call.
  */
  it("persists ok heartbeats to the store at a bounded cadence", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const session = createMockSession();
    monitor.trackAgent("agent-001", session, "run-001");
    monitor.recordHeartbeat("agent-001");

    // Track records the initial heartbeat; an immediate activity refresh is in-memory only.
    expect(store.recordHeartbeat).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 30_000);
    monitor.recordHeartbeat("agent-001");
    expect(store.recordHeartbeat).toHaveBeenCalledTimes(2);
    expect(store.recordHeartbeat).toHaveBeenLastCalledWith("agent-001", "ok", "run-001");

    vi.useRealTimers();
  });

  it("triggers onRecovered callback after missed heartbeat", () => {
    const onRecovered = vi.fn();
    const customMonitor = new HeartbeatMonitor({ store, onRecovered });
    const session = createMockSession();

    vi.useFakeTimers({ shouldAdvanceTime: true });
    customMonitor.trackAgent("agent-001", session, "run-001");

    // Simulate missed heartbeat by advancing time
    vi.advanceTimersByTime(70000); // Default timeout is 60000

    // Trigger the check
    customMonitor.stop();

    // Reset and record heartbeat (should trigger recovery)
    customMonitor.recordHeartbeat("agent-001");
    expect(onRecovered).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("does nothing for untracked agent", () => {
    expect(() => monitor.recordHeartbeat("agent-001")).not.toThrow();
    expect(store.recordHeartbeat).not.toHaveBeenCalled();
  });
});

describe("isAgentHealthy", () => {
  it("returns true for recent heartbeat", () => {
    const session = createMockSession();
    monitor.trackAgent("agent-001", session, "run-001");

    expect(monitor.isAgentHealthy("agent-001")).toBe(true);
  });

  it("returns false for missed heartbeat", () => {
    const session = createMockSession();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Use short timeout for testing
    const customMonitor = new HeartbeatMonitor({
      store,
      heartbeatTimeoutMs: 5000,
    });

    customMonitor.trackAgent("agent-001", session, "run-001");
    expect(customMonitor.isAgentHealthy("agent-001")).toBe(true);

    // Advance past timeout
    vi.advanceTimersByTime(6000);
    expect(customMonitor.isAgentHealthy("agent-001")).toBe(false);

    vi.useRealTimers();
  });

  it("returns false for untracked agent", () => {
    expect(monitor.isAgentHealthy("agent-001")).toBe(false);
  });
});

describe("getTrackedAgents", () => {
  it("returns empty array when no agents tracked", () => {
    expect(monitor.getTrackedAgents()).toEqual([]);
  });

  it("returns all tracked agent IDs", () => {
    monitor.trackAgent("agent-001", createMockSession(), "run-001");
    monitor.trackAgent("agent-002", createMockSession(), "run-002");

    const agents = monitor.getTrackedAgents();
    expect(agents).toHaveLength(2);
    expect(agents).toContain("agent-001");
    expect(agents).toContain("agent-002");
  });
});

describe("getLastSeen", () => {
  it("returns correct timestamp for tracked agent", () => {
    const session = createMockSession();
    const before = Date.now();

    monitor.trackAgent("agent-001", session, "run-001");
    const lastSeen = monitor.getLastSeen("agent-001");

    expect(lastSeen).toBeDefined();
    expect(lastSeen).toBeGreaterThanOrEqual(before);
  });

  it("returns undefined for untracked agent", () => {
    expect(monitor.getLastSeen("agent-001")).toBeUndefined();
  });
});

describe("missed heartbeat detection", () => {
  it("triggers onMissed callback when heartbeat is missed", async () => {
    const onMissed = vi.fn();
    const customMonitor = new HeartbeatMonitor({
      store,
      heartbeatTimeoutMs: 5000,
      pollIntervalMs: 1000,
      onMissed,
    });
    const session = createMockSession();

    vi.useFakeTimers({ shouldAdvanceTime: true });
    customMonitor.start();
    customMonitor.trackAgent("agent-001", session, "run-001");

    // Wait for polling to detect missed heartbeat
    vi.advanceTimersByTime(6000);

    // Wait for async checkMissedHeartbeats
    await vi.advanceTimersByTimeAsync(100);

    expect(onMissed).toHaveBeenCalledWith("agent-001", expect.any(String));

    customMonitor.stop();
    vi.useRealTimers();
  });

  it("records missed heartbeat to store", async () => {
    const customMonitor = new HeartbeatMonitor({
      store,
      heartbeatTimeoutMs: 5000,
      pollIntervalMs: 1000,
    });
    const session = createMockSession();

    vi.useFakeTimers({ shouldAdvanceTime: true });
    customMonitor.start();
    customMonitor.trackAgent("agent-001", session, "run-001");

    // Wait for polling to detect missed heartbeat
    vi.advanceTimersByTime(6000);
    await vi.advanceTimersByTimeAsync(100);

    expect(store.recordHeartbeat).toHaveBeenCalledWith("agent-001", "missed", "run-001");

    customMonitor.stop();
    vi.useRealTimers();
  });
});

describe("unresponsive agent recovery", () => {
  it("recovers only tracked stale sessions via pause/resume restart", async () => {
    const onTerminated = vi.fn();
    const session = createMockSession();
    const localStore = createMockStore({
      getAgent: vi.fn().mockResolvedValue({ id: "agent-001", state: "running", runtimeConfig: { enabled: false } }),
      updateAgentState: vi.fn().mockResolvedValue(undefined),
      updateAgent: vi.fn().mockResolvedValue(undefined),
    });
    const customMonitor = new HeartbeatMonitor({
      store: localStore,
      heartbeatTimeoutMs: 5000,
      pollIntervalMs: 1000,
      onTerminated,
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    customMonitor.start();
    customMonitor.trackAgent("agent-001", session, "run-001");

    vi.advanceTimersByTime(12000);
    await vi.advanceTimersByTimeAsync(100);

    expect(session.dispose).toHaveBeenCalled();
    expect(localStore.updateAgentState).toHaveBeenCalledWith("agent-001", "paused");
    expect(localStore.updateAgentState).toHaveBeenCalledWith("agent-001", "active");
    expect(onTerminated).not.toHaveBeenCalled();
    expect(customMonitor.getTrackedAgents()).toHaveLength(0);

    customMonitor.stop();
    vi.useRealTimers();
  });

  it("does not attempt stale recovery for untracked agents", async () => {
    const localStore = createMockStore({
      getAgent: vi.fn().mockResolvedValue({
        id: "agent-001",
        state: "active",
        lastHeartbeatAt: new Date(Date.now() - 60_000).toISOString(),
        runtimeConfig: { enabled: true },
      }),
      updateAgentState: vi.fn().mockResolvedValue(undefined),
      updateAgent: vi.fn().mockResolvedValue(undefined),
    });
    const customMonitor = new HeartbeatMonitor({
      store: localStore,
      heartbeatTimeoutMs: 5_000,
      pollIntervalMs: 1_000,
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    customMonitor.start();
    await vi.advanceTimersByTimeAsync(12_000);

    expect(localStore.updateAgentState).not.toHaveBeenCalledWith("agent-001", "paused");
    expect(localStore.updateAgentState).not.toHaveBeenCalledWith("agent-001", "active");

    customMonitor.stop();
    vi.useRealTimers();
  });

  it("logs recovery warnings when dispose and pause fail", async () => {
    const warnSpy = vi.mocked(heartbeatLog.warn);
    warnSpy.mockClear();
    const session: AgentSession = {
      dispose: vi.fn(() => {
        throw new Error("dispose exploded");
      }),
    };
    const localStore = createMockStore({
      getAgent: vi.fn().mockResolvedValue({ id: "agent-001", state: "running", runtimeConfig: { enabled: false } }),
      updateAgentState: vi.fn().mockRejectedValue(new Error("db connection lost")),
    });
    const customMonitor = new HeartbeatMonitor({
      store: localStore,
      heartbeatTimeoutMs: 5000,
      pollIntervalMs: 1000,
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    customMonitor.start();
    customMonitor.trackAgent("agent-001", session, "run-001");

    vi.advanceTimersByTime(10100);
    await vi.advanceTimersByTimeAsync(100);

    const warnMessages = warnSpy.mock.calls.map(([message]) => String(message));
    expect(warnMessages.some((message) => message.includes("Recovering unresponsive agent agent-001"))).toBe(true);
    expect(warnMessages.some((message) => message.includes("Error disposing session for agent-001") && message.includes("dispose exploded"))).toBe(true);
    expect(warnMessages.some((message) => message.includes("Error pausing unresponsive agent agent-001") && message.includes("db connection lost"))).toBe(true);

    customMonitor.stop();
    vi.useRealTimers();
  });

  /*
  FNXC:HeartbeatRecovery 2026-10-08-01:34:
  KB-016: unresponsive terminations share the heartbeatErrorRecovery budget, exhaustion parks with error-retry-exhausted without resuming, and the tracked controller is aborted before dispose.
  */
  describe("shared retry budget", () => {
    type RecoveryInternals = {
      recoverUnresponsiveAgent: (tracked: unknown, heartbeatTimeoutMs: number) => Promise<void>;
      trackedAgents: Map<string, unknown>;
    };

    function createBudgetHarness(options: {
      metadata?: Record<string, unknown>;
      settings?: Record<string, unknown> | "reject";
      recordRunAuditEvent?: (...args: unknown[]) => unknown;
      withTaskStore?: boolean;
    } = {}) {
      const agent = {
        id: "agent-001",
        state: "running",
        runtimeConfig: { enabled: false },
        ...(options.metadata ? { metadata: options.metadata } : {}),
      };
      const localStore = createMockStore({
        getAgent: vi.fn().mockResolvedValue(agent),
        updateAgentState: vi.fn().mockResolvedValue(agent),
        updateAgent: vi.fn().mockResolvedValue(agent),
      });
      const recordRunAuditEvent = vi.fn(options.recordRunAuditEvent ?? (async () => undefined));
      const taskStore = options.withTaskStore === false ? undefined : ({
        getSettings: options.settings === "reject"
          ? vi.fn().mockRejectedValue(new Error("settings down"))
          : vi.fn().mockResolvedValue(options.settings ?? {}),
        recordRunAuditEvent,
      } as unknown as TaskStore);
      const localMonitor = new HeartbeatMonitor({ store: localStore, taskStore, heartbeatTimeoutMs: 5000, pollIntervalMs: 1000 });
      const internals = localMonitor as unknown as RecoveryInternals;
      return { localStore, localMonitor, internals, recordRunAuditEvent };
    }

    function writtenAttempts(localStore: AgentStore): number[] {
      return vi.mocked(localStore.updateAgent).mock.calls
        .map(([, patch]) => (patch as { metadata?: { heartbeatErrorRecovery?: { consecutiveAttempts?: number } } }).metadata?.heartbeatErrorRecovery?.consecutiveAttempts)
        .filter((count): count is number => typeof count === "number");
    }

    async function recover(harness: ReturnType<typeof createBudgetHarness>, controller?: AbortController, session = createMockSession()) {
      harness.localMonitor.trackAgent("agent-001", session, "run-001", undefined, controller);
      const tracked = harness.internals.trackedAgents.get("agent-001");
      await harness.internals.recoverUnresponsiveAgent(tracked, 5000);
      // Flush the non-blocking resume dispatch.
      for (let i = 0; i < 10; i++) await Promise.resolve();
      return session;
    }

    it("counts an attempt for an agent with no metadata and resumes it", async () => {
      const harness = createBudgetHarness();
      await recover(harness);
      expect(writtenAttempts(harness.localStore)).toEqual([1]);
      expect(harness.localStore.updateAgentState).toHaveBeenCalledWith("agent-001", "paused");
      expect(harness.localStore.updateAgentState).toHaveBeenCalledWith("agent-001", "active");
    });

    it("increments a partial count and resumes", async () => {
      const harness = createBudgetHarness({ metadata: { heartbeatErrorRecovery: { consecutiveAttempts: 2 } } });
      await recover(harness);
      expect(writtenAttempts(harness.localStore)).toEqual([3]);
      expect(harness.localStore.updateAgentState).toHaveBeenCalledWith("agent-001", "active");
    });

    it("honors a legacy durableErrorRecovery count", async () => {
      const harness = createBudgetHarness({ metadata: { durableErrorRecovery: { attempts: 5 } } });
      await recover(harness);
      expect(harness.localStore.updateAgent).toHaveBeenCalledWith("agent-001", expect.objectContaining({ pauseReason: "error-retry-exhausted" }));
      expect(harness.localStore.updateAgentState).not.toHaveBeenCalledWith("agent-001", "active");
    });

    it("parks an exhausted agent without resuming and records the exhaustion audit", async () => {
      const harness = createBudgetHarness({ metadata: { heartbeatErrorRecovery: { consecutiveAttempts: 5 } } });
      await recover(harness);
      expect(harness.localStore.updateAgentState).toHaveBeenCalledWith("agent-001", "paused");
      expect(harness.localStore.updateAgent).toHaveBeenCalledWith("agent-001", expect.objectContaining({
        pauseReason: "error-retry-exhausted",
        lastError: expect.stringContaining("No heartbeat for"),
      }));
      expect(harness.localStore.updateAgentState).not.toHaveBeenCalledWith("agent-001", "active");
      expect(writtenAttempts(harness.localStore)).toEqual([]);
      expect(harness.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        mutationType: "agent:error-retry-exhausted",
        metadata: { agentId: "agent-001", attempts: 5, limit: 5, source: "heartbeat-unresponsive" },
      }));
    });

    it("uses a custom heartbeatErrorRecoveryAttempts limit", async () => {
      const harness = createBudgetHarness({ metadata: { heartbeatErrorRecovery: { consecutiveAttempts: 2 } }, settings: { heartbeatErrorRecoveryAttempts: 2 } });
      await recover(harness);
      expect(harness.localStore.updateAgent).toHaveBeenCalledWith("agent-001", expect.objectContaining({ pauseReason: "error-retry-exhausted" }));
    });

    it("falls back to the default limit when settings lookup rejects", async () => {
      const harness = createBudgetHarness({ metadata: { heartbeatErrorRecovery: { consecutiveAttempts: 2 } }, settings: "reject" });
      await recover(harness);
      expect(writtenAttempts(harness.localStore)).toEqual([3]);
      expect(harness.localStore.updateAgentState).toHaveBeenCalledWith("agent-001", "active");
    });

    it("uses the default limit when the monitor has no task store", async () => {
      const harness = createBudgetHarness({ metadata: { heartbeatErrorRecovery: { consecutiveAttempts: 5 } }, withTaskStore: false });
      await recover(harness);
      expect(harness.localStore.updateAgent).toHaveBeenCalledWith("agent-001", expect.objectContaining({ pauseReason: "error-retry-exhausted" }));
    });

    it("aborts the tracked controller before disposing the session", async () => {
      const harness = createBudgetHarness();
      const controller = new AbortController();
      const abortedAtDispose: boolean[] = [];
      const session: AgentSession = { dispose: vi.fn(() => { abortedAtDispose.push(controller.signal.aborted); }) };
      await recover(harness, controller, session as ReturnType<typeof createMockSession>);
      expect(abortedAtDispose).toEqual([true]);
    });

    it("recovers a tracked entry once when invoked concurrently", async () => {
      const harness = createBudgetHarness();
      const session = createMockSession();
      harness.localMonitor.trackAgent("agent-001", session, "run-001");
      const tracked = harness.internals.trackedAgents.get("agent-001");
      await Promise.all([
        harness.internals.recoverUnresponsiveAgent(tracked, 5000),
        harness.internals.recoverUnresponsiveAgent(tracked, 5000),
      ]);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(session.dispose).toHaveBeenCalledTimes(1);
      expect(writtenAttempts(harness.localStore)).toEqual([1]);
    });

    it.each([
      ["throws", () => { throw new Error("audit sink exploded"); }],
      ["never settles", () => new Promise(() => undefined)],
    ])("parks and completes recovery when the audit sink %s", async (_label, sink) => {
      const harness = createBudgetHarness({ metadata: { heartbeatErrorRecovery: { consecutiveAttempts: 5 } }, recordRunAuditEvent: sink });
      await recover(harness);
      expect(harness.recordRunAuditEvent).toHaveBeenCalled();
      expect(harness.localStore.updateAgent).toHaveBeenCalledWith("agent-001", expect.objectContaining({ pauseReason: "error-retry-exhausted" }));
      expect(harness.localMonitor.getTrackedAgents()).toHaveLength(0);
    });

    it("logs rather than throws when budget bookkeeping fails", async () => {
      const warnSpy = vi.mocked(heartbeatLog.warn);
      warnSpy.mockClear();
      const harness = createBudgetHarness();
      vi.mocked(harness.localStore.updateAgent).mockRejectedValue(new Error("metadata write lost"));
      await expect(recover(harness)).resolves.toBeDefined();
      const warnMessages = warnSpy.mock.calls.map(([message]) => String(message));
      expect(warnMessages.some((message) => message.includes("budget update failed") && message.includes("metadata write lost"))).toBe(true);
    });
  });
});

describe("untrackAgent", () => {
  it("removes agent from tracking", () => {
    const session = createMockSession();
    monitor.trackAgent("agent-001", session, "run-001");
    expect(monitor.getTrackedAgents()).toContain("agent-001");

    monitor.untrackAgent("agent-001");
    expect(monitor.getTrackedAgents()).not.toContain("agent-001");
    expect(monitor.getTrackedAgents()).toHaveLength(0);
  });

  it("is safe to call for untracked agent", () => {
    expect(() => monitor.untrackAgent("agent-001")).not.toThrow();
  });
});

// ── Per-Agent Config Tests ──────────────────────────────────────────────

