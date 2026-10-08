import { vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";

/**
 * In-memory TaskStore slice for recovery-ownership tests. `updateTask`/`updateTaskAtomic` apply the
 * same `null` => cleared convention as the real store, `moveTask` records every attempted move so a
 * test can assert that a recovery never moved the card, and run-audit rows are captured.
 */
export function createRecoveryFakeStore(initial: Partial<Task> & { id: string }) {
  let row = {
    column: "in-progress",
    status: undefined,
    error: undefined,
    steps: [],
    dependencies: [],
    columnMovedAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...initial,
  } as unknown as Task;
  const logs: string[] = [];
  const audits: Array<{ mutationType: string; metadata?: Record<string, unknown> }> = [];
  const moves: Array<{ column: string; options?: unknown }> = [];
  const apply = (patch: Record<string, unknown> | null | undefined) => {
    if (!patch) return;
    const next: Record<string, unknown> = { ...(row as unknown as Record<string, unknown>) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete next[key];
      else if (value !== undefined) next[key] = value;
    }
    row = next as unknown as Task;
  };
  const store = {
    getTask: vi.fn(async () => ({ ...row })),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      apply(patch);
      return { ...row };
    }),
    updateTaskAtomic: vi.fn(async (_id: string, updater: (current: Task) => Record<string, unknown> | null | undefined) => {
      apply(await updater({ ...row }));
      return { ...row };
    }),
    logEntry: vi.fn(async (_id: string, message: string) => {
      logs.push(message);
    }),
    moveTask: vi.fn(async (_id: string, column: string, options?: unknown) => {
      moves.push({ column, options });
      throw new Error(`unexpected moveTask(${column}) from a recovery that must stay in place`);
    }),
    getSettings: vi.fn(async () => ({})),
    recordRunAuditEvent: vi.fn(async (event: { mutationType: string; metadata?: Record<string, unknown> }) => {
      audits.push({ mutationType: event.mutationType, metadata: event.metadata });
    }),
  };
  return {
    store: store as unknown as TaskStore,
    raw: store,
    get task() { return row; },
    set task(next: Task) { row = next; },
    logs,
    audits,
    moves,
  };
}
