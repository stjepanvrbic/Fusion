/*
FNXC:WorkflowColumns 2026-07-29-00:00 (U12 — R8):
Ratchet: `@fusion/core` must not export a column coercion that discards
workflow-defined ids.

`normalizeColumn` did exactly that — it answered "is this one of the SIX legacy ids"
and rewrote everything else to `triage`, so any project with a custom column silently
lost it. It sat one line away from `normalizeColumnId`, which sanitises structurally
and passes real ids through, and the dashboard picked the wrong one for its whole task
ingest path until that was diagnosed (see `routes-trait-rekey.test.ts`).

U12 deleted it once it had zero callers. This test is what stops it — or an equivalent
under a new name — coming back: an exported helper that maps a valid custom column id
to a legacy one is the defect, regardless of what it is called.
*/
import { describe, expect, it } from "vitest";
import * as core from "../index.js";
import { normalizeColumnId } from "../types/board/index.js";

const LEGACY_COLUMN_IDS = new Set(["triage", "todo", "in-progress", "in-review", "done", "archived"]);

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Name-agnostic scan: exercise every function export whose name mentions "column" and
 * return the names of those that turn a valid custom id into a different, legacy id.
 * That is the behaviour being banned, not the identifier.
 *
 * FNXC:WorkflowColumns 2026-10-12-10:27:
 * Async exports are awaited. A rejection counts as a refusal, exactly like a synchronous
 * throw, and the resolved value gets the same legacy-id check as a synchronous result.
 * Calling an async export without awaiting it let its rejection go unhandled, which fails
 * the whole core Vitest run even though every test passes, and let an async lossy coercer
 * pass unseen because a promise is never a string.
 */
async function findLossyColumnCoercers(exports: Record<string, unknown>): Promise<string[]> {
  const offenders: string[] = [];
  for (const [name, value] of Object.entries(exports)) {
    if (typeof value !== "function" || !/column/i.test(name)) continue;
    /*
    NO ARITY FILTER (PR #2535 review — greptile). An earlier version skipped anything
    whose `Function.length !== 1`, which is the exact signature family this is meant to
    police: `normalizeColumnId(value, fallback = DEFAULT)` reports length 1 because
    defaults do not count, but a new coercer written `(value, fallback)` with both
    required reports 2 and would have walked straight past the guard. A ratchet that
    silently skips the shape it exists to catch is worse than no ratchet.

    Probe with BOTH a custom id and a legacy fallback. One argument alone was not
    enough either: a two-required-argument coercer returns its (undefined) fallback,
    which is not a string, so the check skipped it — I verified that by injecting one.
    Supplying the fallback makes a lossy coercer return the LEGACY id, which is the
    signal; a passthrough returns the custom id; a one-argument function ignores the
    extra parameter harmlessly. A function that refuses this shape, by throwing or by
    rejecting, is not silently losing a column.
    */
    let result: unknown;
    try {
      result = (value as (input: unknown, fallback: unknown) => unknown)("custom-hold", "triage");
      if (isThenable(result)) result = await result;
    } catch {
      continue;
    }
    if (typeof result === "string" && result !== "custom-hold" && LEGACY_COLUMN_IDS.has(result)) {
      offenders.push(name);
    }
  }
  return offenders;
}

describe("no lossy column coercion on the core public surface", () => {
  it("does not export the deleted normalizeColumn", () => {
    expect(Object.keys(core)).not.toContain("normalizeColumn");
  });

  it("keeps normalizeColumnId non-lossy for workflow-defined ids", () => {
    // The property that made normalizeColumn wrong: a real custom column id must
    // survive. If this ever fails, the safe helper has acquired the lossy behaviour.
    for (const customId of ["ideas", "merging", "custom-hold", "signoff"]) {
      expect(normalizeColumnId(customId)).toBe(customId);
    }
    // Structural sanitisation is still expected.
    expect(normalizeColumnId("")).toBe("triage");
    expect(normalizeColumnId(undefined)).toBe("triage");
    expect(normalizeColumnId(null, "todo")).toBe("todo");
  });

  it("catches a two-required-argument lossy coercer, not just one-argument ones", () => {
    /*
    The arity hole, pinned directly rather than only in prose: this is the shape that
    used to slip through, so the guard's own coverage is now measurable instead of
    asserted.
    */
    const twoRequiredArgs = (value: unknown, fallback: string) =>
      (["triage", "todo", "in-progress", "in-review", "done", "archived"] as string[]).includes(value as string)
        ? (value as string)
        : fallback;
    expect(twoRequiredArgs.length).toBe(2);
    // Probed WITH the fallback, a lossy coercer returns the legacy id — the signal the
    // scan keys on. Probed without it, this same function returns undefined and the
    // scan skipped it, which is the hole that made the arity filter's removal
    // insufficient on its own.
    expect(twoRequiredArgs("custom-hold", "triage")).toBe("triage");
    expect(twoRequiredArgs("custom-hold", undefined as unknown as string)).toBeUndefined();
  });

  it("flags sync and async lossy coercers and skips an async refusal without leaking its rejection", async () => {
    const legacyIds = [...LEGACY_COLUMN_IDS];
    const offenders = await findLossyColumnCoercers({
      syncLossyColumnCoercer: (value: unknown, fallback: string) =>
        legacyIds.includes(value as string) ? (value as string) : fallback,
      asyncLossyColumnCoercer: async (value: unknown, fallback: string) =>
        legacyIds.includes(value as string) ? (value as string) : fallback,
      // Mirrors the lane-role lookups: the argument check rejects the returned promise.
      asyncRejectingColumnLookup: async (_column: unknown, _workflowId: unknown, role?: string) => {
        if (!role) throw new Error(`Unknown lane role '${role}'`);
        return false;
      },
      asyncPassthroughColumnLookup: async (value: unknown) => value,
    });
    expect(offenders).toEqual(["syncLossyColumnCoercer", "asyncLossyColumnCoercer"]);
  });

  it("exports no OTHER helper that maps a custom column id onto a legacy one", async () => {
    expect(await findLossyColumnCoercers(core)).toEqual([]);
  });
});
