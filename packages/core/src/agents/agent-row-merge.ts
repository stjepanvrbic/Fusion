import type { Agent } from "../types.js";

/*
FNXC:AgentRowConcurrency 2026-10-07-21:40:
Agent mutations read the agent, build an updated copy, then upsert the whole row. The in-process lock orders one store only,
so a heartbeat, a CLI pause or a dashboard edit from another process landing in between was overwritten by the stale copy:
a paused or runtime-disabled agent came back active. The write now merges against the row it was read from: only fields
this mutation changed are taken from it, everything else keeps the committed value. When both sides changed the same field
(or the same key of runtimeConfig or metadata) the mutation is stale and is re-run on a fresh read.
*/

/** Another writer changed a field this agent mutation also changes; recompute from the current row. */
export class AgentWriteConflictError extends Error {
  constructor(readonly agentId: string, readonly fields: readonly string[]) {
    super(`Agent ${agentId} changed concurrently in ${fields.join(", ")}`);
    this.name = "AgentWriteConflictError";
  }
}

/** Fields whose keys are independent settings, merged one level deep. */
const KEYED_BAG_FIELDS: ReadonlySet<string> = new Set(["runtimeConfig", "metadata"]);

function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}

function same(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One-level merge of a keyed bag, or undefined when both sides changed the same key. */
function mergeKeyedBag(ours: unknown, base: unknown, live: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(ours) || !isPlainObject(live)) return undefined;
  const baseBag = isPlainObject(base) ? base : {};
  const merged: Record<string, unknown> = { ...live };
  for (const key of new Set([...Object.keys(ours), ...Object.keys(baseBag)])) {
    if (same(ours[key], baseBag[key])) continue;
    if (!same(live[key], baseBag[key]) && !same(live[key], ours[key])) return undefined;
    if (ours[key] === undefined) delete merged[key];
    else merged[key] = ours[key];
  }
  return merged;
}

/**
 * Rebase `ours` (built from `base`) onto `live` in place. Throws {@link AgentWriteConflictError} when a field changed on
 * both sides to different values.
 */
export function rebaseAgentOnto(ours: Agent, base: Agent, live: Agent): void {
  const target = ours as unknown as Record<string, unknown>;
  const baseRecord = base as unknown as Record<string, unknown>;
  const liveRecord = live as unknown as Record<string, unknown>;
  const conflicts: string[] = [];
  for (const field of new Set([...Object.keys(target), ...Object.keys(baseRecord), ...Object.keys(liveRecord)])) {
    if (field === "id" || field === "updatedAt") continue;
    const oursChanged = !same(target[field], baseRecord[field]);
    const theirsChanged = !same(liveRecord[field], baseRecord[field]);
    if (!theirsChanged) continue;
    if (!oursChanged) {
      if (liveRecord[field] === undefined) delete target[field];
      else target[field] = liveRecord[field];
      continue;
    }
    if (same(target[field], liveRecord[field])) continue;
    if (KEYED_BAG_FIELDS.has(field)) {
      const merged = mergeKeyedBag(target[field], baseRecord[field], liveRecord[field]);
      if (merged) {
        target[field] = merged;
        continue;
      }
    }
    conflicts.push(field);
  }
  if (conflicts.length > 0) throw new AgentWriteConflictError(ours.id, conflicts);
}
