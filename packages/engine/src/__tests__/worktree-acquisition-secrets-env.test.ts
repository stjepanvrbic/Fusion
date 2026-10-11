import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tempWorkspace } from "../../../core/src/__test-utils__/workspace.js";

const { writeSecretsEnvFile, reconcileSecretsEnvFingerprint, refreshReusedWorktreeBase } = vi.hoisted(() => ({
  writeSecretsEnvFile: vi.fn(),
  reconcileSecretsEnvFingerprint: vi.fn(),
  refreshReusedWorktreeBase: vi.fn(),
}));

/*
FNXC:TaskPinnedWorktrees 2026-10-11-02:27:
The pinned reservation must stay held until warm reuse has settled. This probe keeps the real reservation and only records when its release starts and ends, with an optional per-test gate that holds the release open so a test controls the interleaving without real time.
*/
const reservationProbe = vi.hoisted(() => ({
  events: [] as string[],
  releaseGate: undefined as undefined | (() => Promise<void>),
}));

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return {
    ...actual,
    acquireWorktreePathReservation: async (...args: Parameters<typeof actual.acquireWorktreePathReservation>) => {
      const handle = await actual.acquireWorktreePathReservation(...args);
      return {
        canonicalPath: handle.canonicalPath,
        token: handle.token,
        previousState: handle.previousState,
        get state() { return handle.state; },
        quarantine: (reason: string) => handle.quarantine(reason),
        release: async () => {
          reservationProbe.events.push("release:start");
          await reservationProbe.releaseGate?.();
          await handle.release();
          reservationProbe.events.push("release:end");
        },
      };
    },
  };
});

vi.mock("../worktree/secrets-env-writer.js", () => ({
  writeSecretsEnvFile,
  reconcileSecretsEnvFingerprint,
}));

vi.mock("../worktree-base-refresh.js", () => ({
  refreshReusedWorktreeBase,
}));

vi.mock("../worktree/worktree-pool.js", async () => {
  const actual = await vi.importActual<any>("../worktree/worktree-pool.js");
  return {
    ...actual,
    classifyTaskWorktree: vi.fn().mockResolvedValue({ ok: true }),
    isInsideWorktreesDir: vi.fn().mockReturnValue(true),
  };
});

vi.mock("../worktree/worktree-db-hydrate.js", () => ({
  hydrateWorktreeDb: vi.fn().mockResolvedValue({ degraded: false, tasksCopied: 0, documentsCopied: 0, artifactsCopied: 0 }),
}));

/*
FNXC:EngineTests 2026-07-21-00:10:
Pool unit tests use non-git temp paths; identity guard would throw and fall through to fresh.
*/
vi.mock("../worktree/worktree-hooks.js", async () => {
  const actual = await vi.importActual<any>("../worktree/worktree-hooks.js");
  return {
    ...actual,
    installTaskWorktreeIdentityGuard: vi.fn().mockResolvedValue(undefined),
  };
});

import { acquireTaskWorktree } from "../worktree/worktree-acquisition.js";
import { classifyTaskWorktree } from "../worktree/worktree-pool.js";

const nextMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

function pinnedWorktree(rootDir: string): string {
  execSync("git init -b main", { cwd: rootDir, stdio: "pipe" });
  execSync('git config user.email "test@example.com"', { cwd: rootDir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: rootDir, stdio: "pipe" });
  execSync("git commit --allow-empty -m baseline", { cwd: rootDir, stdio: "pipe" });
  const worktree = join(rootDir, ".fusion", "worktrees", "fn-1");
  mkdirSync(dirname(worktree), { recursive: true });
  execSync(`git worktree add -b fusion/fn-1 ${JSON.stringify(worktree)} HEAD`, { cwd: rootDir, stdio: "pipe" });
  return worktree;
}

describe("worktree-acquisition secrets env hook", () => {
  const task = { id: "FN-1", title: "t", description: "d", branch: null, worktree: null } as any;
  let store: any;

  beforeEach(() => {
    reservationProbe.events.length = 0;
    reservationProbe.releaseGate = undefined;
    writeSecretsEnvFile.mockReset().mockResolvedValue({ outcome: "skipped", filename: ".env", reason: "disabled" });
    reconcileSecretsEnvFingerprint.mockReset().mockResolvedValue({ executionSafe: true, outcome: "clean" });
    refreshReusedWorktreeBase.mockReset().mockResolvedValue({ kind: "up-to-date", executionSafe: true });
    vi.mocked(classifyTaskWorktree).mockResolvedValue({ ok: true } as any);
    store = { updateTask: vi.fn().mockResolvedValue(undefined), logEntry: vi.fn().mockResolvedValue(undefined) };
  });

  it("calls writer for a new pinned checkout", async () => {
    await acquireTaskWorktree({
      task,
      rootDir: tempWorkspace("fn-273-secrets-new-"),
      store,
      settings: { recycleWorktrees: true, secretsEnv: { enabled: true } } as any,
      pool: {
        acquire: () => "/tmp/pool",
        prepareForTask: vi.fn().mockResolvedValue({ branch: "fusion/fn-1", worktreePath: "/tmp/pool", reclaimed: false }),
        release: vi.fn(),
      } as any,
      createWorktree: vi.fn().mockResolvedValue({ path: "/tmp/fresh-fallback", branch: "fusion/fn-1" }),
      secretsStore: undefined,
    });
    expect(writeSecretsEnvFile).toHaveBeenCalledWith(expect.objectContaining({ worktreeSource: "fresh", secretsStore: undefined }));
  });

  it("calls writer on fresh", async () => {
    await acquireTaskWorktree({
      task,
      rootDir: tempWorkspace("fn-273-secrets-fresh-"),
      store,
      settings: { secretsEnv: { enabled: true } } as any,
      createWorktree: vi.fn().mockResolvedValue({ path: "/tmp/fresh", branch: "fusion/fn-1" }),
      secretsStore: undefined,
    });
    expect(writeSecretsEnvFile).toHaveBeenCalledWith(expect.objectContaining({ worktreeSource: "fresh" }));
  });

  it("does not call writer for existing resume", async () => {
    const projectRoot = tempWorkspace("fn-273-secrets-existing-");
    const existingWorktree = pinnedWorktree(projectRoot);

    await acquireTaskWorktree({
      task: { ...task, branch: "fusion/fn-1", worktree: existingWorktree },
      rootDir: projectRoot,
      store,
      settings: { secretsEnv: { enabled: true } } as any,
      createWorktree: vi.fn(),
    });
    expect(writeSecretsEnvFile).not.toHaveBeenCalled();
  });

  it("reconciles a pinned planning sidecar before its refresh-enabled execution handoff", async () => {
    const projectRoot = tempWorkspace("fn-273-secrets-refresh-");
    const existingWorktree = pinnedWorktree(projectRoot);
    reconcileSecretsEnvFingerprint.mockResolvedValueOnce({ executionSafe: true, outcome: "adopted-legacy" });

    await expect(acquireTaskWorktree({
      task: { ...task, branch: "fusion/fn-1", worktree: existingWorktree },
      rootDir: projectRoot,
      store,
      settings: { secretsEnv: { enabled: true } } as any,
      refreshStaleBase: true,
      createWorktree: vi.fn(),
    })).resolves.toMatchObject({ source: "existing", isResume: true });

    // FNXC:SecretsEnvMaterialization 2026-08-08-03:30: Execution handoff must reconcile the planning-era root record before strict refresh sees porcelain.
    expect(reconcileSecretsEnvFingerprint).toHaveBeenCalledWith(existingWorktree);
    expect(refreshReusedWorktreeBase).toHaveBeenCalledWith(expect.objectContaining({ worktreePath: existingWorktree }));
    expect(reconcileSecretsEnvFingerprint.mock.invocationCallOrder[0]).toBeLessThan(refreshReusedWorktreeBase.mock.invocationCallOrder[0]);
  });

  it("fails closed with a redacted fixed audit outcome when reconciliation rejects", async () => {
    const projectRoot = tempWorkspace("fn-273-secrets-reject-");
    const existingWorktree = pinnedWorktree(projectRoot);
    const git = vi.fn();
    reconcileSecretsEnvFingerprint.mockRejectedValueOnce(new Error("secret-derived resolver detail"));

    await expect(acquireTaskWorktree({
      task: { ...task, branch: "fusion/fn-1", worktree: existingWorktree },
      rootDir: projectRoot,
      store,
      settings: { secretsEnv: { enabled: true } } as any,
      refreshStaleBase: true,
      audit: { git },
      createWorktree: vi.fn(),
    })).rejects.toMatchObject({
      name: "WorktreeBaseRefreshError",
      refresh: { kind: "base-reconciliation-required", detail: "git-dir-unavailable" },
    });
    expect(refreshReusedWorktreeBase).not.toHaveBeenCalled();
    expect(git).toHaveBeenCalledWith(expect.objectContaining({
      type: "worktree:base-refresh-blocked",
      target: existingWorktree,
      metadata: { taskId: "FN-1", outcome: "base-reconciliation-required", reconciliationOutcome: "git-dir-unavailable" },
    }));
    // FNXC:SecretsEnvMaterialization 2026-08-09-03:50: Audit targets identify the affected checkout; only
    // resolver diagnostics and secret-derived values are redacted from the fixed failure outcome.
    expect(JSON.stringify(git.mock.calls)).not.toContain("secret-derived resolver detail");
  });

  /*
  FNXC:TaskPinnedWorktrees 2026-10-11-02:27:
  A refused warm reuse must reach only its caller. If the reservation is released while reuse is still running, the rejection has no handler until the release finishes and the process reports an unhandled rejection although the caller handles it a moment later.
  The gate makes the release outlast the refusal, so an early release is observable as a wrong event order and as a captured unhandled rejection. Vitest does not report an unhandled rejection while a test owns a listener, so the captured list is the assertion.
  */
  it.each([
    {
      refusal: "secrets reconciliation rejects",
      arm: (refuse: () => void) => reconcileSecretsEnvFingerprint.mockImplementationOnce(async () => {
        refuse();
        throw new Error("secret-derived resolver detail");
      }),
      detail: "git-dir-unavailable",
    },
    {
      refusal: "the base refresh leaves an unproven tree",
      arm: (refuse: () => void) => refreshReusedWorktreeBase.mockImplementationOnce(async () => {
        refuse();
        return { kind: "base-reconciliation-required", executionSafe: false, detail: "restore-failed" };
      }),
      detail: "restore-failed",
    },
  ])("keeps the pinned reservation held until a warm reuse refused because $refusal has settled", async ({ arm, detail }) => {
    const projectRoot = tempWorkspace("pinned-reservation-held-");
    const existingWorktree = pinnedWorktree(projectRoot);
    let signalRefused!: () => void;
    const refused = new Promise<void>((resolve) => { signalRefused = resolve; });
    arm(() => {
      reservationProbe.events.push("reuse:refused");
      signalRefused();
    });
    reservationProbe.releaseGate = async () => {
      await refused;
      await nextMacrotask();
    };
    const unhandled: unknown[] = [];
    const captureUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", captureUnhandled);
    try {
      await expect(acquireTaskWorktree({
        task: { ...task, branch: "fusion/fn-1", worktree: existingWorktree },
        rootDir: projectRoot,
        store,
        settings: { secretsEnv: { enabled: true } } as any,
        refreshStaleBase: true,
        createWorktree: vi.fn(),
      })).rejects.toMatchObject({
        name: "WorktreeBaseRefreshError",
        refresh: { kind: "base-reconciliation-required", detail },
      });
      await nextMacrotask();

      expect({
        events: reservationProbe.events,
        unhandledRejections: unhandled.map((reason) => (reason as Error)?.name ?? String(reason)),
      }).toEqual({
        events: ["reuse:refused", "release:start", "release:end"],
        unhandledRejections: [],
      });
    } finally {
      process.off("unhandledRejection", captureUnhandled);
    }
  });

  it("isolates writer failures", async () => {
    writeSecretsEnvFile.mockRejectedValueOnce(new Error("boom"));
    await expect(acquireTaskWorktree({
      task,
      rootDir: tempWorkspace("fn-273-secrets-writer-failure-"),
      store,
      settings: { secretsEnv: { enabled: true } } as any,
      createWorktree: vi.fn().mockResolvedValue({ path: "/tmp/fresh", branch: "fusion/fn-1" }),
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })).resolves.toMatchObject({ source: "fresh" });
  });
});
