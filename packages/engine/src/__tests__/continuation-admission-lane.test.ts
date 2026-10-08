import { describe, expect, it } from "vitest";
import {
  BUILTIN_CODING_WORKFLOW_IR,
  BUILTIN_STEPWISE_CODING_WORKFLOW_IR,
  type WorkflowIr,
} from "@fusion/core";

import { resolveContinuationAdmissionLane } from "../concurrency/continuation-admission-lane.js";

/*
A custom board whose every column and node is renamed. The classifier must reach the same
answers from traits and node kinds alone; no id below matches a built-in id.
*/
const RENAMED_WORKFLOW_IR = {
  version: "v2",
  columns: [
    { id: "inbox", name: "Inbox", traits: [{ trait: "intake" }] },
    { id: "queue", name: "Queue", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "build", name: "Build", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "qa", name: "QA", traits: [{ trait: "merge-blocker" }, { trait: "human-review" }, { trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
  nodes: [
    { id: "begin", kind: "start", column: "inbox" },
    { id: "draft-spec", kind: "prompt", column: "queue", config: { seam: "planning" } },
    {
      id: "spec-audit",
      kind: "optional-group",
      column: "queue",
      config: { reviewKind: "plan", template: { nodes: [{ id: "spec-audit-run", kind: "prompt", config: {} }], edges: [] } },
    },
    { id: "craft", kind: "prompt", column: "build", config: { seam: "execute" } },
    {
      id: "ui-smoke",
      kind: "optional-group",
      column: "build",
      config: { template: { nodes: [{ id: "ui-smoke-run", kind: "prompt", config: {} }], edges: [] } },
    },
    { id: "peer-check", kind: "prompt", column: "build", config: { seam: "review" } },
    { id: "qa-notes", kind: "prompt", column: "qa", config: {} },
    { id: "land-it", kind: "merge-attempt", column: "qa", config: {} },
    {
      id: "after-ship",
      kind: "optional-group",
      column: "shipped",
      config: { phase: "post-merge", template: { nodes: [{ id: "after-ship-run", kind: "prompt", config: {} }], edges: [] } },
    },
    { id: "finish", kind: "end", column: "shipped" },
  ],
  edges: [],
} as unknown as WorkflowIr;

describe("resolveContinuationAdmissionLane", () => {
  it("classifies every resumable built-in coding node by lifecycle role", () => {
    const expected: Record<string, "review" | "execute" | "planning"> = {
      "plan-review": "planning",
      "plan-replan": "planning",
      execute: "execute",
      "browser-verification": "review",
      "code-review": "review",
      "completion-summary": "review",
      review: "review",
      "merge-gate": "review",
      "merge-attempt": "review",
      "post-merge-verification": "review",
    };
    for (const [nodeId, lane] of Object.entries(expected)) {
      expect({ nodeId, lane: resolveContinuationAdmissionLane(BUILTIN_CODING_WORKFLOW_IR, nodeId) }).toEqual({ nodeId, lane });
    }
  });

  it("keeps execution resumes, including foreach template nodes, in the execute lane", () => {
    expect(resolveContinuationAdmissionLane(BUILTIN_STEPWISE_CODING_WORKFLOW_IR, "parse")).toBe("execute");
    expect(resolveContinuationAdmissionLane(BUILTIN_STEPWISE_CODING_WORKFLOW_IR, "step-execute")).toBe("execute");
    expect(resolveContinuationAdmissionLane(BUILTIN_STEPWISE_CODING_WORKFLOW_IR, "steps#2:step-execute")).toBe("execute");
    expect(resolveContinuationAdmissionLane(BUILTIN_STEPWISE_CODING_WORKFLOW_IR, "plan-review")).toBe("planning");
  });

  it("classifies a renamed custom workflow by column traits and node roles, never by node id", () => {
    const expected: Record<string, "review" | "execute" | "planning"> = {
      "draft-spec": "planning",
      "spec-audit": "planning",
      "spec-audit::spec-audit-run": "planning",
      craft: "execute",
      "ui-smoke": "review",
      "ui-smoke::ui-smoke-run": "review",
      "peer-check": "review",
      "qa-notes": "review",
      "land-it": "review",
      "after-ship": "review",
      "after-ship-run": "review",
    };
    for (const [nodeId, lane] of Object.entries(expected)) {
      expect({ nodeId, lane: resolveContinuationAdmissionLane(RENAMED_WORKFLOW_IR, nodeId) }).toEqual({ nodeId, lane });
    }
  });

  it("falls back to node roles when a v1-upgraded board carries no column traits", () => {
    const traitless = {
      ...RENAMED_WORKFLOW_IR,
      columns: (RENAMED_WORKFLOW_IR as { columns: Array<{ id: string; name: string }> }).columns
        .map((column) => ({ ...column, traits: [] })),
    } as unknown as WorkflowIr;
    expect(resolveContinuationAdmissionLane(traitless, "spec-audit")).toBe("planning");
    expect(resolveContinuationAdmissionLane(traitless, "after-ship")).toBe("review");
    expect(resolveContinuationAdmissionLane(traitless, "land-it")).toBe("review");
    expect(resolveContinuationAdmissionLane(traitless, "draft-spec")).toBe("planning");
    expect(resolveContinuationAdmissionLane(traitless, "craft")).toBe("execute");
  });

  it("keeps today's execute lane for an unknown node or an unresolvable workflow", () => {
    expect(resolveContinuationAdmissionLane(BUILTIN_CODING_WORKFLOW_IR, "no-such-node")).toBe("execute");
    expect(resolveContinuationAdmissionLane(undefined, "post-merge-verification")).toBe("execute");
  });
});
