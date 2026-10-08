import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * FNXC:LifecycleContainment 2026-10-07-18:04:
 * Code-construct ratchet for FN-207: the store runs the lifecycle direction postcondition only for an
 * explicit engine/scheduler `moveSource`, and an optionless move takes the fail-open legacy route.
 * Every automatic engine mover must therefore name its source, so an automatic backward move cannot
 * slip past containment. A call may pass the source through an options object declared in the same
 * function (the identifier's literal must carry `moveSource`). The allowlist below is a shrinking list
 * of call sites owned by other in-flight changes; adding an entry needs a written owner and reason.
 *
 * FNXC:LifecycleContainment 2026-10-08-05:54:
 * KB-045 flipped the absent source to fail closed: an optionless move is now judged as an engine move, not
 * fail-open. Naming the source stays mandatory so every mover records a deliberate containment decision.
 * agent-tools.ts and project/mesh-lease-manager.ts now name "engine" and left the allowlist; only the
 * column-boundary wrapper, which is not a store call, remains.
 */
const ENGINE_SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

const ALLOWLIST: Record<string, string> = {
  // `deps.moveTask` here is the graph boundary's own wrapper, not TaskStore.moveTask; it supplies the source.
  "workflows/workflow-column-boundary.ts": "graph column-boundary wrapper, not a store call",
};

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      walk(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
}

function callText(source: string, start: number): string {
  let depth = 1;
  let index = start;
  while (index < source.length && depth > 0) {
    const char = source[index];
    if (char === "(" || char === "{" || char === "[") depth++;
    else if (char === ")" || char === "}" || char === "]") depth--;
    index++;
  }
  return source.slice(start, index);
}

function namesSourceThroughIdentifier(source: string, callIndex: number, call: string): boolean {
  const identifiers = [...call.matchAll(/(?:,\s*|\.\.\.)([A-Za-z_$][\w$]*)\s*(?=[,)}])/g)].map((match) => match[1]);
  const preceding = source.slice(Math.max(0, callIndex - 4_000), callIndex);
  return identifiers.some((name) => {
    const declaration = preceding.lastIndexOf(`const ${name}`);
    if (declaration < 0) return false;
    const literalStart = preceding.indexOf("{", declaration);
    if (literalStart < 0) return false;
    return /moveSource\s*:/.test(callText(preceding, literalStart + 1));
  });
}

describe("engine moveTask census", () => {
  it("every engine store.moveTask call names an explicit moveSource", () => {
    const files: string[] = [];
    walk(ENGINE_SRC, files);
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(ENGINE_SRC, file).split("\\").join("/");
      if (ALLOWLIST[rel]) continue;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/\.moveTask\(/g)) {
        const start = (match.index ?? 0) + match[0].length;
        const call = callText(source, start);
        if (/moveSource\s*:/.test(call)) continue;
        if (namesSourceThroughIdentifier(source, match.index ?? 0, call)) continue;
        const line = source.slice(0, match.index).split("\n").length;
        offenders.push(`${rel}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps every allowlist entry live, so the list can only shrink", () => {
    for (const rel of Object.keys(ALLOWLIST)) {
      const source = readFileSync(join(ENGINE_SRC, rel), "utf8");
      expect(source.includes(".moveTask("), `${rel} no longer moves tasks; delete its allowlist entry`).toBe(true);
    }
  });
});
