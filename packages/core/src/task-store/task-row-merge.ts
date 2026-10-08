import { and, eq } from "drizzle-orm";
import type { Task, TaskLogEntry } from "../types.js";
import type { TaskStore } from "../store.js";
import type { DbTransaction } from "../postgres/data-layer.js";
import * as schema from "../postgres/schema/index.js";
import { TASK_COLUMN_DESCRIPTORS, type TaskPersistSerializationContext, type TaskRow } from "./persistence.js";
import { getTaskActivityLogEntryLimit } from "./comments.js";
import { buildTaskInsertValues, readTaskRowInTransaction, upsertTaskRowInTransaction } from "./async/async-persistence.js";

/*
FNXC:TaskRowConcurrency 2026-10-07-21:40:
A generic task-row write reads the row, mutates a Task snapshot across awaits, then persists it. Diffing that snapshot against
the row re-read inside the write transaction treats every column another process committed in between as "changed by me" and
writes the stale value back: a status clear, an operator pause, a log entry or a passed gate is silently reverted.
The write is a three-way merge instead. The baseline is the row the caller's snapshot was read from; only columns the caller
changed relative to that baseline are written, and columns only another writer changed are left alone and copied into the
caller's snapshot so its task.json mirror, cache entry and event match the committed row.
When both sides changed the same column the caller's value wins, except the append-only activity log, whose new entries are
appended after the other writer's. An updater-style caller can instead ask for a conflict, so it re-runs from the fresh row.
*/

const taskRowBaselines = new WeakMap<Task, TaskRow>();

/** Record the persisted row a freshly read Task snapshot was built from. */
export function rememberTaskRowBaseline(task: Task, row: TaskRow): Task {
  taskRowBaselines.set(task, row);
  return task;
}

/** The persisted row `task` was read from, when it came from a tracked read. */
export function taskRowBaselineOf(task: Task): TaskRow | undefined {
  return taskRowBaselines.get(task);
}

/** A column this write changes was also changed by another writer since `observedRow` was read. */
export class TaskWriteConflictError extends Error {
  constructor(readonly taskId: string, readonly columns: readonly string[]) {
    super(`Task ${taskId} changed concurrently in ${columns.join(", ")}`);
    this.name = "TaskWriteConflictError";
  }
}

export type TaskRowWritePlan = {
  /** Columns to SET, excluding id and updatedAt. */
  writeColumns: Set<keyof TaskRow>;
  /** Columns another writer changed since the baseline that this write leaves as committed. */
  foreignColumns: Set<keyof TaskRow>;
};

export type TaskRowWriteOptions = {
  /**
   * The row an updater computed its patch from. When set, a write to any column whose live value no longer matches it
   * throws {@link TaskWriteConflictError} so the caller can recompute from the current row.
   */
  observedRow?: TaskRow;
};

function sameColumnValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseLog(value: unknown): TaskLogEntry[] | undefined {
  if (Array.isArray(value)) return value as TaskLogEntry[];
  if (typeof value !== "string" || value === "") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as TaskLogEntry[] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Entries `ours` appended to `base`, or undefined when `ours` is not `base` (optionally front-trimmed) plus appended entries.
 */
function appendedLogEntries(base: readonly TaskLogEntry[], ours: readonly TaskLogEntry[]): TaskLogEntry[] | undefined {
  const baseKeys = base.map((entry) => JSON.stringify(entry));
  const ourKeys = ours.map((entry) => JSON.stringify(entry));
  for (let dropped = 0; dropped <= baseKeys.length; dropped++) {
    const kept = baseKeys.length - dropped;
    if (kept > ourKeys.length) continue;
    let matches = true;
    for (let index = 0; index < kept; index++) {
      if (ourKeys[index] !== baseKeys[dropped + index]) { matches = false; break; }
    }
    if (matches) return ours.slice(kept) as TaskLogEntry[];
  }
  return undefined;
}

/*
Task fields each column is serialized from, discovered by running each descriptor against a recording proxy so the mapping
cannot drift from the descriptor list. Composite fields (tokenUsage, sourceIssue) span several columns.
*/
let columnTaskKeys: Map<keyof TaskRow, string[]> | undefined;
function taskKeysForColumn(column: keyof TaskRow): string[] {
  if (!columnTaskKeys) {
    columnTaskKeys = new Map();
    for (const descriptor of TASK_COLUMN_DESCRIPTORS) {
      const keys = new Set<string>();
      const recorder = new Proxy({}, {
        get(_target, key) {
          if (typeof key === "string") keys.add(key);
          return undefined;
        },
      }) as Task;
      try {
        descriptor.serialize(recorder, { lineageId: "" });
      } catch {
        // A serializer that dereferences an absent field has already recorded it.
      }
      columnTaskKeys.set(descriptor.column, [...keys]);
    }
  }
  return columnTaskKeys.get(column) ?? [];
}

/**
 * Decide which columns this write persists. Mutates `task.log` when both writers appended activity entries.
 * Without a tracked baseline the write falls back to diffing against the live row.
 */
export function planTaskRowWrite(store: TaskStore, liveRow: TaskRow, task: Task, options?: TaskRowWriteOptions): TaskRowWritePlan {
  const writeColumns = new Set<keyof TaskRow>();
  const foreignColumns = new Set<keyof TaskRow>();
  const baseRow = taskRowBaselines.get(task);
  const nextValues = store.getTaskPersistValues(task, liveRow);
  const baseValues = baseRow ? store.getTaskPersistValues(store.rowToTask(baseRow), baseRow) : undefined;
  let logMerged = false;

  for (const [index, descriptor] of TASK_COLUMN_DESCRIPTORS.entries()) {
    const column = descriptor.column;
    if (column === "id" || column === "updatedAt") continue;
    if (!baseRow || !baseValues) {
      if (!sameColumnValue(liveRow[column], nextValues[index])) writeColumns.add(column);
      continue;
    }
    const oursChanged = !sameColumnValue(nextValues[index], baseValues[index]);
    const theirsChanged = !sameColumnValue(liveRow[column], baseRow[column]);
    if (!oursChanged) {
      if (theirsChanged) foreignColumns.add(column);
      continue;
    }
    if (theirsChanged && column === "log") {
      const merged = mergeAppendedLog(baseRow.log, task.log, liveRow.log);
      if (merged) {
        task.log = merged;
        logMerged = true;
      }
    }
    writeColumns.add(column);
  }

  const observedRow = options?.observedRow;
  if (observedRow) {
    const conflicts = [...writeColumns].filter((column) =>
      !(column === "log" && logMerged) && !sameColumnValue(liveRow[column], observedRow[column]));
    if (conflicts.length > 0) throw new TaskWriteConflictError(task.id, conflicts.map(String));
  }
  return { writeColumns, foreignColumns };
}

function mergeAppendedLog(baseLog: unknown, ourLog: readonly TaskLogEntry[] | undefined, liveLog: unknown): TaskLogEntry[] | undefined {
  const base = parseLog(baseLog);
  const live = parseLog(liveLog);
  if (!base || !live || !ourLog) return undefined;
  const appended = appendedLogEntries(base, ourLog);
  if (!appended) return undefined;
  const merged = [...live, ...appended];
  const limit = getTaskActivityLogEntryLimit();
  return merged.length > limit ? merged.slice(merged.length - limit) : merged;
}

/**
 * After the row commits, copy the columns another writer owns into `task` and make `committedRow` its new baseline,
 * so a further write of the same snapshot diffs against what is now durable.
 */
export function adoptCommittedTaskRow(store: TaskStore, task: Task, committedRow: TaskRow, plan: TaskRowWritePlan): void {
  if (plan.foreignColumns.size > 0) {
    const committed = store.rowToTask(committedRow) as unknown as Record<string, unknown>;
    const target = task as unknown as Record<string, unknown>;
    const keys = new Set<string>();
    for (const column of plan.foreignColumns) for (const key of taskKeysForColumn(column)) keys.add(key);
    for (const key of keys) {
      if (committed[key] === undefined) delete target[key];
      else target[key] = committed[key];
    }
  }
  taskRowBaselines.set(task, committedRow);
}

/**
 * Merge-write `task` over the live row inside `tx`, which must already hold the task's advisory lock.
 * An absent row falls back to the full upsert (create-recovery), matching the generic writers.
 */
export async function mergeWriteTaskRowInTransaction(
  store: TaskStore,
  tx: DbTransaction,
  task: Task,
  context: TaskPersistSerializationContext,
  projectId: string | undefined,
): Promise<void> {
  const liveRecord = await readTaskRowInTransaction(tx, task.id, { includeDeleted: true }, projectId);
  if (!liveRecord) {
    await upsertTaskRowInTransaction(tx, task as unknown as Record<string, unknown>, context, projectId);
    return;
  }
  const liveRow = store.pgRowToTaskRow(liveRecord);
  const plan = planTaskRowWrite(store, liveRow, task);
  let committedRow = liveRow;
  if (plan.writeColumns.size > 0) {
    const allValues = buildTaskInsertValues(task as unknown as Record<string, unknown>, context);
    const setValues: Record<string, unknown> = { updatedAt: task.updatedAt };
    for (const column of plan.writeColumns) setValues[column as string] = allValues[column as string];
    const conditions = [eq(schema.project.tasks.id, task.id)];
    if (projectId) conditions.push(eq(schema.project.tasks.projectId, projectId));
    const [committed] = await tx.update(schema.project.tasks).set(setValues as never).where(and(...conditions)).returning();
    if (committed) committedRow = store.pgRowToTaskRow(committed as Record<string, unknown>);
  }
  adoptCommittedTaskRow(store, task, committedRow, plan);
}
