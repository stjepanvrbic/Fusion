/*
FNXC:ProviderRateLimitDeferral 2026-10-08-16:05:
Shared in-memory store for the KB-077 review/merge rate-limit deferral tests. It mirrors TaskStore's null-clears-field update semantics,
the workflow-selection readers `resolveWorkflowIrForTask` needs, the continuation slot used by external-block resumes, and a capturing
run-audit sink, so the real freeze, schedule, and resume code runs end to end without a database.
*/
import { vi } from "vitest";
import type { Task, WorkflowStepResult, WorkflowWorkItem } from "@fusion/core";

export const RATE_LIMIT_IR = {
  version: "v2",
  name: "kb-077-rate-limit",
  columns: [
    { id: "planning", name: "Planning", traits: [{ trait: "hold" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip" }] },
    { id: "review", name: "Review", traits: [{ trait: "human-review" }] },
    { id: "done", name: "Done", traits: [{ trait: "complete" }] },
  ],
  nodes: [
    { id: "start", kind: "start" },
    { id: "plan-review", kind: "prompt", column: "planning", config: { reviewKind: "plan" } },
    { id: "implement", kind: "execute", column: "building" },
    {
      id: "code-review",
      kind: "optional-group",
      column: "review",
      config: { name: "Code Review", defaultOn: true, reviewKind: "code", template: { nodes: [{ id: "review", kind: "prompt", config: { prompt: "review", gateMode: "gate" } }], edges: [] } },
    },
    {
      id: "browser-verification",
      kind: "optional-group",
      column: "review",
      config: { name: "Browser Verification", defaultOn: true, template: { nodes: [{ id: "verify", kind: "prompt", config: { prompt: "verify", gateMode: "gate" } }], edges: [] } },
    },
    { id: "merge-gate", kind: "merge-gate", column: "review", config: { gate: "auto-merge" } },
    { id: "post-merge-verification", kind: "prompt", column: "review", config: { phase: "post-merge" } },
  ],
  edges: [
    { from: "start", to: "plan-review" },
    { from: "plan-review", to: "implement" },
    { from: "implement", to: "code-review" },
    { from: "code-review", to: "browser-verification" },
    { from: "browser-verification", to: "merge-gate" },
    { from: "merge-gate", to: "post-merge-verification" },
  ],
} as never;

export const MINUTE = 60_000;
export const T0 = Date.parse("2026-10-08T10:45:41.000Z");
export const RAW_429 = "429 Too Many Requests: rate limited";

export function rateLimitedResult(workflowStepId: string, overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  const names: Record<string, string> = {
    "plan-review": "Plan Review",
    "code-review": "Code Review",
    "browser-verification": "Browser Verification",
    "post-merge-verification": "Post-merge Verification",
  };
  const name = names[workflowStepId] ?? workflowStepId;
  return {
    workflowStepId,
    workflowStepName: name,
    phase: workflowStepId === "post-merge-verification" ? "post-merge" : "pre-merge",
    source: "optional-group",
    status: "failed",
    output: `${name} failed before producing a verdict: ${RAW_429}`,
    providerFailure: { origin: "model-provider", code: "RATE_LIMIT" },
    startedAt: new Date(T0 - 21_000).toISOString(),
    completedAt: new Date(T0).toISOString(),
    ...overrides,
  };
}

export function reviewCard(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    description: id,
    column: "review",
    dependencies: [],
    steps: [{ name: "Implementation", status: "done" }],
    currentStep: 1,
    worktree: `/worktrees/${id.toLowerCase()}`,
    branch: `fusion/${id.toLowerCase()}`,
    createdAt: "2026-10-08T06:00:00.000Z",
    updatedAt: "2026-10-08T06:00:00.000Z",
    ...overrides,
  } as Task;
}

export function createRateLimitStore(initial: Task[], options: { settings?: Record<string, unknown>; ir?: unknown } = {}) {
  const rows = new Map(initial.map((task) => [task.id, structuredClone(task)]));
  const items: WorkflowWorkItem[] = [];
  const audits: Array<{ mutationType: string; agentId?: string; metadata: Record<string, unknown> }> = [];
  const logs: Array<{ taskId: string; message: string }> = [];
  const ir = options.ir ?? RATE_LIMIT_IR;
  const store = {
    getRootDir: () => "/project",
    getSettings: vi.fn(async () => ({ maxConcurrent: 6, maxWorktrees: 9, worktreeLimitEnabled: true, autoMerge: true, ...(options.settings ?? {}) })),
    getTask: vi.fn(async (id: string) => structuredClone(rows.get(id)) as Task),
    listTasks: vi.fn(async () => [...rows.values()].map((task) => structuredClone(task))),
    updateTask: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const row = rows.get(id)! as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === undefined) delete row[key];
        else row[key] = structuredClone(value);
      }
      row.updatedAt = new Date().toISOString();
      return structuredClone(row) as unknown as Task;
    }),
    updateTaskAtomic: vi.fn(async (id: string, mutate: (current: Task) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>) => {
      const patch = await mutate(structuredClone(rows.get(id)) as Task);
      if (!patch) return null;
      return store.updateTask(id, patch);
    }),
    logEntry: vi.fn(async (taskId: string, message: string) => { logs.push({ taskId, message }); }),
    addTaskComment: vi.fn(async () => undefined),
    withPlanningLifecycleLock: vi.fn(async <T>(_id: string, work: () => Promise<T>) => await work()),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "wf-kb-077", stepIds: [] })),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "wf-kb-077", stepIds: [] })),
    getWorkflowDefinition: vi.fn(async () => ({ id: "wf-kb-077", name: "KB-077", ir })),
    listWorkflowWorkItemsForTask: vi.fn(async (taskId: string) => items.filter((item) => item.taskId === taskId).map((item) => ({ ...item }))),
    replaceActiveTaskWorkflowContinuation: vi.fn(async (input: Record<string, unknown>) => {
      for (const item of items) {
        if (item.taskId === input.taskId && ["runnable", "running", "held", "retrying"].includes(item.state)) item.state = "cancelled";
      }
      const item = { id: `continuation-${items.length}`, attempt: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...input } as unknown as WorkflowWorkItem;
      items.push(item);
      return item;
    }),
    seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(async (input: Record<string, unknown>) => {
      items.push({ id: `reseed-${items.length}`, attempt: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...input } as unknown as WorkflowWorkItem);
      return { seeded: true };
    }),
    getWorkflowWorkItem: vi.fn(async (id: string) => items.find((item) => item.id === id) ?? null),
    transitionWorkflowWorkItem: vi.fn(async (id: string, state: WorkflowWorkItem["state"]) => {
      const item = items.find((candidate) => candidate.id === id);
      if (item) item.state = state;
      return item ?? null;
    }),
    recordRunAuditEvent: vi.fn(async (event: { mutationType: string; agentId?: string; metadata: Record<string, unknown> }) => { audits.push(event); }),
  };
  return { store, rows, items, audits, logs };
}
