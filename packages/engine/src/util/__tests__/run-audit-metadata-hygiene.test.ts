import { describe, expect, it, vi } from "vitest";

import { createRunAuditor, errnoCodeOf, sanitizeRunAuditMetadata } from "../run-audit.js";

/*
FNXC:RunAudit 2026-10-07-20:20:
Run-audit metadata is ids/counts/fixed outcomes only. Merge cleanup, push, worktree removal, message delivery and stale-assignment reconciliation emitters put raw error text, stderr previews and prose reasons into metadata; the one RunAuditor seam must strip them for every domain.
*/
const SECRET = "ghp_SENTINELTOKEN0000";
const credentialUrl = `https://x-access-token:${SECRET}@github.com/acme/repo.git`;
const multilineStderr = `To ${credentialUrl}\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to '${credentialUrl}'`;

function recordingStore() {
  const events: Array<{ mutationType: string; metadata?: Record<string, unknown> }> = [];
  const store = { recordRunAuditEvent: vi.fn(async (event: (typeof events)[number]) => { events.push(event); }) };
  return { events, store };
}

function auditor(store: unknown) {
  return createRunAuditor(store as never, { runId: "run-1", agentId: "agent-1", taskId: "FN-1", phase: "merge" });
}

describe("run-audit metadata hygiene", () => {
  it.each([
    ["git: merge worktree cleanup", (a: ReturnType<typeof auditor>) => a.git({
      type: "merge:ai-worktree-cleanup",
      target: "/w/fn-1",
      metadata: { taskId: "FN-1", success: false, error: `EBUSY: resource busy or locked, rmdir '/w/fn-1' ${SECRET}`, attempts: 3, code: "EBUSY" },
    })],
    ["git: push after merge", (a: ReturnType<typeof auditor>) => a.git({
      type: "push:origin",
      target: "FN-1",
      metadata: { remote: "origin", outcome: "failed", stderrPreview: multilineStderr.slice(0, 500) },
    })],
    ["git: worktree remove fallback", (a: ReturnType<typeof auditor>) => a.git({
      type: "worktree:remove-fallback",
      target: "/w/fn-1",
      metadata: { fallback: "filesystem-non-empty", error: `fatal: '${credentialUrl}' contains modified files` },
    })],
    ["database: message delivery park", (a: ReturnType<typeof auditor>) => a.database({
      type: "message-delivery:park",
      target: "agent-7",
      metadata: { correlation: { kind: "direct", fromAgentId: "agent-7" }, attempts: 3, errorMessage: `connection to postgresql://fusion:${SECRET}@db/fusion refused`, mode: "direct" },
    })],
    ["database: stale assignment reconciliation", (a: ReturnType<typeof auditor>) => a.database({
      type: "task:reconcile-stale-agent-assignment",
      target: "agent-7",
      metadata: { agentId: "agent-7", taskId: "FN-1", hadFreshRun: false, reason: `agent idle; last error was ${SECRET}` },
    })],
    ["database with outcome", (a: ReturnType<typeof auditor>) => a.databaseWithOutcome!({
      type: "task:plan-admission-throttled",
      target: "FN-1",
      metadata: { blockedBy: "running-agent cap", nested: { findings: [{ probeError: "x", output: `token ${SECRET}` }] } },
    })],
    ["filesystem", (a: ReturnType<typeof auditor>) => a.filesystem({
      type: "file:write",
      target: "/w/fn-1/.env",
      metadata: { size: 12, stderr: SECRET },
    })],
    ["sandbox", (a: ReturnType<typeof auditor>) => a.sandbox({
      type: "sandbox:failure",
      target: "native",
      metadata: { command: `deploy --token ${SECRET}`, exitCode: 1 },
    })],
  ] as const)("%s: persists no diagnostic prose", async (_surface, emit) => {
    const { events, store } = recordingStore();
    await emit(auditor(store));
    expect(events).toHaveLength(1);
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("rejected");
    expect(events[0]!.metadata?.redactedFields).toEqual(expect.any(Array));
  });

  it("keeps ids, counts, fixed outcomes, enum reasons and the errno code", () => {
    expect(sanitizeRunAuditMetadata({
      taskId: "FN-1",
      attempts: 3,
      success: false,
      outcome: "failed",
      reason: "user-paused",
      error: "EBUSY: resource busy or locked",
      timedOut: true,
    })).toEqual({
      taskId: "FN-1",
      attempts: 3,
      success: false,
      outcome: "failed",
      reason: "user-paused",
      errorCode: "EBUSY",
      timedOut: true,
      redactedFields: ["error"],
    });
  });

  it("keeps fixed-vocabulary reasons and drops reasons that embed error text", () => {
    expect(sanitizeRunAuditMetadata({ reason: "parked in-review task FN-12 without live execution proof" })).toEqual({
      reason: "parked in-review task FN-12 without live execution proof",
    });
    expect(sanitizeRunAuditMetadata({ reason: "transient cancel — clear on restart + reviewLevel backfill" })).toEqual({
      reason: "transient cancel — clear on restart + reviewLevel backfill",
    });
    expect(sanitizeRunAuditMetadata({
      reason: "task is marked 'failed': Failed to create worktree after 3 attempts: Branch fusion/fn-9999 conflict",
    })).toEqual({ redactedFields: ["reason"] });
    expect(sanitizeRunAuditMetadata({ reason: `push to ${credentialUrl} failed` })).toEqual({ redactedFields: ["reason"] });
  });

  it("leaves boolean and numeric diagnostic flags and already-clean metadata untouched", () => {
    expect(sanitizeRunAuditMetadata({ error: false, output: 0, phase: "merge" })).toEqual({ error: false, output: 0, phase: "merge" });
    expect(sanitizeRunAuditMetadata(undefined)).toEqual({});
  });

  it("extracts only real errno codes", () => {
    expect(errnoCodeOf(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe("ENOENT");
    expect(errnoCodeOf("ERROR: EACCES permission denied")).toBe("EACCES");
    expect(errnoCodeOf("ERROR: something failed")).toBeUndefined();
  });
});
