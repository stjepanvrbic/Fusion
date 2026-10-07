import { createLogger } from "../logger.js";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import { errnoCodeOf, type RunAuditor } from "../util/run-audit.js";
import type {
  SandboxBackend,
  SandboxCapabilities,
  SandboxFallbackEvent,
  SandboxPolicy,
  SandboxRunOptions,
  SandboxRunResult,
} from "./types.js";

const log = createLogger("sandbox-audit");

/**
 * FNXC:RunAudit 2026-10-07-20:11:
 * Sandbox audit metadata is ids/counts/fixed outcomes only: configured-command and routine execution pass operator command text here, and failing commands print credential-bearing diagnostics.
 * Command text, stdout/stderr and thrown error messages never enter run-audit; their lengths, the exit code, signal, an errno code and a fixed failure kind do.
 * Every emit goes through the bounded seam so an injected auditor that throws, rejects or hangs cannot block or fail the sandboxed command.
 */
async function emitSandboxAudit(
  auditor: RunAuditor,
  type: "sandbox:prepare" | "sandbox:run" | "sandbox:failure" | "sandbox:fallback",
  target: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await emitBoundedRunAudit(
    { recordRunAuditEvent: () => auditor.sandbox({ type, target, metadata }) },
    { mutationType: type },
    { log },
  );
}

type SandboxFailureKind = "exit" | "timeout" | "buffer-overflow" | "error";

function failureKindOf(result: SandboxRunResult): SandboxFailureKind {
  if (result.timedOut) return "timeout";
  if (result.bufferExceeded) return "buffer-overflow";
  return "exit";
}

function makeFallbackPolicy(policy: SandboxPolicy, backendId: SandboxCapabilities["id"], auditor: RunAuditor): SandboxPolicy {
  return {
    ...policy,
    onFallback: (event: SandboxFallbackEvent) => {
      void emitSandboxAudit(auditor, "sandbox:fallback", backendId, {
        backendId,
        fromBackendId: event.fromBackendId,
        toBackendId: event.toBackendId,
        reason: event.reason,
      });
      policy.onFallback?.(event);
    },
  };
}

export function withSandboxAudit(backend: SandboxBackend, auditor: RunAuditor): SandboxBackend {
  let prepared = false;
  const capabilities = backend.capabilities();
  const backendId = capabilities.id;

  return {
    capabilities: () => capabilities,
    prepare: async (policy: SandboxPolicy) => {
      await backend.prepare(makeFallbackPolicy(policy, backendId, auditor));
      if (!prepared) {
        prepared = true;
        await emitSandboxAudit(auditor, "sandbox:prepare", backendId, {
          backendId,
          supportsNetworkPolicy: capabilities.supportsNetworkPolicy,
          supportsFilesystemPolicy: capabilities.supportsFilesystemPolicy,
        });
      }
    },
    run: async (command: string, options: SandboxRunOptions): Promise<SandboxRunResult> => {
      const startedAt = Date.now();
      const commandLength = command.length;
      try {
        const result = await backend.run(command, options);
        const durationMs = Date.now() - startedAt;

        await emitSandboxAudit(auditor, "sandbox:run", backendId, {
          backendId,
          commandLength,
          cwd: options.cwd,
          timeoutMs: options.timeoutMs,
          exitCode: result.exitCode,
          durationMs,
          timedOut: result.timedOut,
          bufferExceeded: result.bufferExceeded,
        });

        if (result.exitCode !== 0 || result.timedOut || result.bufferExceeded) {
          await emitSandboxAudit(auditor, "sandbox:failure", backendId, {
            backendId,
            commandLength,
            failureKind: failureKindOf(result),
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            bufferExceeded: result.bufferExceeded,
            stdoutBytes: Buffer.byteLength(result.stdout),
            stderrBytes: Buffer.byteLength(result.stderr),
          });
        }

        return result;
      } catch (error) {
        const errorCode = errnoCodeOf(error);
        await emitSandboxAudit(auditor, "sandbox:failure", backendId, {
          backendId,
          commandLength,
          failureKind: "error" satisfies SandboxFailureKind,
          ...(errorCode ? { errorCode } : {}),
        });
        throw error;
      }
    },
    runStreaming: async (command, options) => backend.runStreaming(command, options),
    dispose: async () => {
      await backend.dispose();
    },
  };
}
