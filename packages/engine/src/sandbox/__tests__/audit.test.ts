import { describe, expect, it, vi } from "vitest";

import { createRunAuditor, type RunAuditor } from "../../util/run-audit.js";
import { RUN_AUDIT_EMIT_TIMEOUT_MS } from "../../util/emit-bounded-run-audit.js";
import { withSandboxAudit } from "../audit.js";
import type { SandboxBackend, SandboxPolicy, SandboxRunOptions, SandboxRunResult } from "../types.js";

function makeBackend(runImpl?: (command: string, options: SandboxRunOptions) => Promise<SandboxRunResult>): SandboxBackend {
  return {
    capabilities: () => ({
      id: "native",
      supportsNetworkPolicy: false,
      supportsFilesystemPolicy: false,
      supportsStreaming: true,
      platform: "any",
    }),
    prepare: vi.fn(async (policy: SandboxPolicy) => {
      policy.onFallback?.({ fromBackendId: "sandbox-exec", toBackendId: "native", reason: "unavailable" });
    }),
    run: runImpl ?? vi.fn(async () => ({ stdout: "ok", stderr: "", exitCode: 0, signal: null, timedOut: false, bufferExceeded: false })),
    runStreaming: vi.fn(async () => ({ outcome: "success" as const, stdout: "", stderr: "", bufferOverflow: false })),
    dispose: vi.fn(async () => {}),
  };
}

function makeAuditor() {
  return {
    git: vi.fn(async () => {}),
    database: vi.fn(async () => {}),
    filesystem: vi.fn(async () => {}),
    sandbox: vi.fn(async () => {}),
  } satisfies RunAuditor;
}

describe("withSandboxAudit", () => {
  it("emits prepare once and fallback callback", async () => {
    const auditor = makeAuditor();
    const backend = withSandboxAudit(makeBackend(), auditor);

    await backend.prepare({ allowNetwork: false });
    await backend.prepare({ allowNetwork: false });

    const sandboxCalls = auditor.sandbox.mock.calls as unknown as Array<[Parameters<RunAuditor["sandbox"]>[0]]>;
    const prepareEvents = sandboxCalls.filter(([input]) => input.type === "sandbox:prepare");
    const fallbackEvents = sandboxCalls.filter(([input]) => input.type === "sandbox:fallback");
    expect(prepareEvents).toHaveLength(1);
    expect(fallbackEvents).toHaveLength(2);
  });

  it("emits run on success", async () => {
    const auditor = makeAuditor();
    const backend = withSandboxAudit(makeBackend(), auditor);

    await backend.run("echo hello", { cwd: "/tmp", timeoutMs: 10_000, maxBuffer: 1000 });

    expect(auditor.sandbox).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sandbox:run", target: "native" }),
    );
  });

  it("emits failure for non-zero exit, timeout, and buffer overflow", async () => {
    const auditor = makeAuditor();
    const backend = withSandboxAudit(
      makeBackend(async () => ({ stdout: "", stderr: "err", exitCode: 1, signal: null, timedOut: true, bufferExceeded: true })),
      auditor,
    );

    await backend.run("bad", { cwd: "/tmp", timeoutMs: 1000, maxBuffer: 10 });

    expect(auditor.sandbox).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sandbox:failure", target: "native" }),
    );
  });

  it("emits failure and rethrows on thrown error", async () => {
    const auditor = makeAuditor();
    const backend = withSandboxAudit(
      makeBackend(async () => {
        throw new Error("boom");
      }),
      auditor,
    );

    await expect(backend.run("explode", { cwd: "/tmp", timeoutMs: 1000, maxBuffer: 10 })).rejects.toThrow("boom");
    expect(auditor.sandbox).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sandbox:failure", target: "native" }),
    );
  });
});

/*
FNXC:RunAudit 2026-10-07-20:15:
Configured-command and routine execution reach this wrapper with operator command text, and failing commands print credential-bearing diagnostics.
Persisted sandbox audit metadata must carry identifiers, counts and fixed outcome categories only, through the real auditor, and a hung sink must never block the command.
*/
describe("withSandboxAudit metadata hygiene (real auditor)", () => {
  const SECRET = "sk-live-SENTINEL-4242";
  const command = `curl -H "Authorization: Bearer ${SECRET}" https://user:${SECRET}@example.test/deploy`;

  function recordingStore() {
    const events: unknown[] = [];
    const store = { recordRunAuditEvent: vi.fn(async (event: unknown) => { events.push(event); }) };
    return { events, store };
  }

  function auditorFor(store: unknown) {
    return createRunAuditor(store as never, { runId: "run-1", agentId: "agent-1", taskId: "FN-1", phase: "execute" });
  }

  it.each([
    ["success", async () => ({ stdout: SECRET, stderr: "", exitCode: 0, signal: null, timedOut: false, bufferExceeded: false })],
    ["failure", async () => ({ stdout: "", stderr: `fatal: auth failed for https://user:${SECRET}@example.test`, exitCode: 128, signal: null, timedOut: false, bufferExceeded: false })],
    ["timeout", async () => ({ stdout: "", stderr: `token=${SECRET}`, exitCode: null, signal: "SIGTERM", timedOut: true, bufferExceeded: false })],
    ["overflow", async () => ({ stdout: SECRET.repeat(10), stderr: SECRET, exitCode: 0, signal: null, timedOut: false, bufferExceeded: true })],
    ["thrown", async () => { throw Object.assign(new Error(`spawn failed: ${SECRET}`), { code: "ENOENT" }); }],
  ] as const)("%s: persists no command text, output, or error prose", async (_case, run) => {
    const { events, store } = recordingStore();
    const backend = withSandboxAudit(makeBackend(run as never), auditorFor(store));

    await backend.run(command, { cwd: "/tmp", timeoutMs: 1000, maxBuffer: 10 }).catch(() => undefined);

    expect(events.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("fatal:");
  });

  it("classifies failures with fixed outcomes and counts", async () => {
    const { events, store } = recordingStore();
    const backend = withSandboxAudit(
      makeBackend(async () => ({ stdout: "", stderr: "x".repeat(42), exitCode: null, signal: "SIGTERM", timedOut: true, bufferExceeded: false })),
      auditorFor(store),
    );
    await backend.run(command, { cwd: "/tmp", timeoutMs: 1000, maxBuffer: 10 });

    const failure = events.find((event) => (event as { mutationType: string }).mutationType === "sandbox:failure") as {
      metadata: Record<string, unknown>;
    };
    expect(failure.metadata).toMatchObject({ failureKind: "timeout", timedOut: true, stderrBytes: 42, commandLength: command.length });
    const run = events.find((event) => (event as { mutationType: string }).mutationType === "sandbox:run") as {
      metadata: Record<string, unknown>;
    };
    expect(run.metadata).toMatchObject({ timedOut: true, bufferExceeded: false });
  });

  it("records the errno code of a thrown failure without its message", async () => {
    const { events, store } = recordingStore();
    const backend = withSandboxAudit(
      makeBackend(async () => { throw Object.assign(new Error(`spawn ${SECRET} ENOENT`), { code: "ENOENT" }); }),
      auditorFor(store),
    );
    await expect(backend.run(command, { cwd: "/tmp", timeoutMs: 1000, maxBuffer: 10 })).rejects.toThrow(SECRET);
    const failure = events.find((event) => (event as { mutationType: string }).mutationType === "sandbox:failure") as {
      metadata: Record<string, unknown>;
    };
    expect(failure.metadata).toMatchObject({ failureKind: "error", errorCode: "ENOENT" });
  });

  it("a hanging audit sink cannot block the sandboxed command", async () => {
    vi.useFakeTimers();
    try {
      const hanging: RunAuditor = {
        git: async () => {},
        database: async () => {},
        filesystem: async () => {},
        sandbox: () => new Promise<void>(() => {}),
      };
      const backend = withSandboxAudit(makeBackend(), hanging);
      const result = backend.run("echo ok", { cwd: "/tmp", timeoutMs: 1000, maxBuffer: 10 });
      await vi.advanceTimersByTimeAsync(RUN_AUDIT_EMIT_TIMEOUT_MS + 1);
      await expect(result).resolves.toMatchObject({ exitCode: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});
