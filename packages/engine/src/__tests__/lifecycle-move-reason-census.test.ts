import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ENGINE_SRC = join(process.cwd(), "src");

function productionTypescriptFiles(dir = ENGINE_SRC): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "dist" || entry === "node_modules") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...productionTypescriptFiles(path));
    else if (entry.endsWith(".ts")) files.push(path);
  }
  return files;
}

function directMoveWindows(source: string): string[] {
  const windows: string[] = [];
  let cursor = 0;
  while ((cursor = source.indexOf(".moveTask(", cursor)) >= 0) {
    const start = cursor;
    let index = cursor + ".moveTask".length;
    let depth = 0;
    let quote: "'" | '"' | "`" | undefined;
    let escaped = false;
    for (; index < source.length; index += 1) {
      const char = source[index]!;
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = undefined;
        continue;
      }
      if (char === "'" || char === '"' || char === "`") {
        quote = char;
        continue;
      }
      if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          index += 1;
          break;
        }
      }
    }
    windows.push(source.slice(start, index));
    cursor = index;
  }
  return windows;
}

const BACKWARD_TARGET_PATTERN = /resolve(?:ContainedBackwardTargetForTask|ReboundTargetForTask|ReboundColumnFor)|resolveMergerLifecycleColumn[\s\S]*?"rebound"|\b(?:reboundColumn|reboundTarget|requeueTarget|retryTarget|replanColumn)\b/;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("engine lifecycle move reason census", () => {
  it("pins the production move authority inventory", () => {
    const count = productionTypescriptFiles()
      .map((file) => readFileSync(file, "utf8"))
      .flatMap(directMoveWindows)
      .length;

    /*
     * FNXC:RecoveryOwnership 2026-10-06-17:39:
     * FN-9512 adds three owner-preserving rebound moves: planning-lock transport retry,
     * exhausted transient execution reseed, and exhausted branch-conflict reseed. Each first
     * fences durable state, clears only automatic recovery metadata, and returns to its resolved
     * current-lifecycle lane rather than introducing a direct terminal or backward move.
     *
     * FNXC:WorktreeAcquisition 2026-10-07-19:51:
     * Heartbeat worktree-acquisition recovery no longer moves the card (lifecycle containment), which removes its three rebound moves: the base-refresh refusal, the in-budget retry, and the exhausted park.
     *
     * FNXC:LifecycleContainment 2026-10-07-18:04:
     * 51 -> 25 (after the heartbeat change above). Every executor retry/rebound (transient, planning-lock, context overflow, stale
     * continuation, non-continuable, worktree liveness, reclaim, no-fn_task_done, completion refusal,
     * pause teardown, contamination, dependency abort, parse-pin, bootstrap misbinding, ephemeral gate,
     * completed-blocked park), the self-healing pause-abort requeue, and the mission retry moves were
     * automatic WIP-to-hold (or review-to-hold) moves that FN-207 forbids; each now recovers in place
     * through the guarded in-place re-dispatch. A rise here means a new direct move needs review.
     */
    expect(count).toBe(25);
  });

  it("requires direct backward-target moves to carry a registered reason", () => {
    const violations: string[] = [];
    for (const file of productionTypescriptFiles()) {
      const source = readFileSync(file, "utf8");
      directMoveWindows(source).forEach((window, index) => {
        if (!BACKWARD_TARGET_PATTERN.test(window)) return;
        if (!/moveSource:\s*"(?:engine|scheduler)"/.test(window)) return;
        if (window.includes("lifecycleReason:") || window.includes("moveTaskWithLifecycleReason(")) return;
        violations.push(`${relative(ENGINE_SRC, file)}#${index + 1}`);
      });
    }

    expect(violations).toEqual([]);
  });

  it("keeps review-capable recovery families off the hold-first resolver", () => {
    const reviewCapableFamilies = [
      "auto-recovery-handlers/contamination.ts",
      "recovery/foreign-only-contamination.ts",
      "healing/restart-recovery-coordinator.ts",
      "project-engine.ts",
      "merge/merger-ai.ts",
      "merger.ts",
    ];
    const violations = reviewCapableFamilies.filter((file) => {
      const source = stripComments(readFileSync(join(ENGINE_SRC, file), "utf8"));
      return /resolveReboundTargetForTask|resolveReboundTarget\(ir\)/.test(source);
    });

    expect(violations).toEqual([]);
  });
});
