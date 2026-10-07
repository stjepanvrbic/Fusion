import type { ChildProcess, spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __getProcessSupervisorStateForTests,
  __resetProcessSupervisorForTests,
  __setProcessTreeKillLauncherForTests,
  __terminateSupervisedChildrenForTests,
  killProcessTree,
  releaseSupervisedChild,
  superviseSpawn,
} from "../process/process-supervisor.js";

const fixturePath = join(import.meta.dirname, "fixtures", "process-supervisor-child.mjs");

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    try {
      if (predicate()) {
        return;
      }
    } catch {
      // Retry until the timeout; many predicates wait on files to appear.
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("process-supervisor", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await __terminateSupervisedChildrenForTests("afterEach");
    __resetProcessSupervisorForTests();
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers a child and deregisters it after natural exit", async () => {
    const child = superviseSpawn(process.execPath, [fixturePath, "exit-immediately"], {
      stdio: "ignore",
      maxLifetimeMs: 1_000,
    });

    expect(__getProcessSupervisorStateForTests()).toEqual({ registrySize: 1, handlersInstalled: true });
    await expect(child.waitExit()).resolves.toEqual({ code: 0, signal: null });
    await waitFor(() => __getProcessSupervisorStateForTests().registrySize === 0);
  });

  /*
  FNXC:RemoteAccess 2026-09-01-02:54:
  A SUPERVISED RESTART IS NOT A SHUTDOWN. The dashboard exits with FUSION_RESTART_EXIT_CODE and a
  supervisor relaunches it seconds later, so the parent-death teardown below must be skippable for a
  child that has to outlive the swap — the Tailscale funnel that carries the operator's only remote
  route to the box. Released children survive every path that otherwise reaps them.
  */
  it("releases a child from parent-death supervision so a relaunch cannot kill it", async () => {
    if (process.platform === "win32") {
      return;
    }

    const child = superviseSpawn(process.execPath, [fixturePath, "keepalive"], {
      stdio: "ignore",
      killGraceMs: 100,
      maxLifetimeMs: Number.POSITIVE_INFINITY,
    });
    const pid = child.pid;
    expect(typeof pid).toBe("number");
    await waitFor(() => isAlive(pid as number));

    expect(releaseSupervisedChild(pid)).toBe(true);
    expect(__getProcessSupervisorStateForTests().registrySize).toBe(0);

    // The exact teardown a parent exit performs. The released child must be untouched by it.
    await __terminateSupervisedChildrenForTests("released");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(isAlive(pid as number)).toBe(true);

    // Releasing twice is not a second claim — the caller must not be told it released anything.
    expect(releaseSupervisedChild(pid)).toBe(false);
    expect(releaseSupervisedChild(undefined)).toBe(false);

    process.kill(-(pid as number), "SIGKILL");
    await waitFor(() => !isAlive(pid as number));
  });

  it("cascades SIGTERM to the supervised process group", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = mkdtempSync(join(os.tmpdir(), "fn-process-supervisor-"));
    tempDirs.push(root);
    const parentPidFile = join(root, "parent.pid");
    const grandchildPidFile = join(root, "grandchild.pid");

    const child = superviseSpawn(process.execPath, [fixturePath, "spawn-child", parentPidFile, grandchildPidFile], {
      stdio: "ignore",
      killGraceMs: 100,
      // This case is specifically asserting explicit cascade teardown. Do not
      // arm a lifetime timer here: matching the old 5s lifetime with the 5s
      // waitFor windows made the explicit teardown race maxLifetime cleanup
      // under broad-suite load.
      maxLifetimeMs: Number.POSITIVE_INFINITY,
    });

    await waitFor(() => Number.parseInt(readFileSync(grandchildPidFile, "utf8"), 10) > 0);
    const grandchildPid = Number.parseInt(readFileSync(grandchildPidFile, "utf8"), 10);
    expect(isAlive(grandchildPid)).toBe(true);

    await __terminateSupervisedChildrenForTests("cascade");
    await expect(child.waitExit()).resolves.toEqual({ code: null, signal: "SIGTERM" });
    expect(__getProcessSupervisorStateForTests().registrySize).toBe(0);
    await waitFor(() => !isAlive(grandchildPid));
    expect(isAlive(grandchildPid)).toBe(false);
  });

  it("escalates to SIGKILL after the grace period", async () => {
    if (process.platform === "win32") {
      return;
    }

    const child = superviseSpawn(process.execPath, [fixturePath, "keepalive"], {
      stdio: "ignore",
      killGraceMs: 50,
      maxLifetimeMs: 5_000,
    });

    const realKill = process.kill.bind(process);
    const processKillSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -(child.pgid ?? 0)) {
        return true;
      }
      return realKill(pid, signal as NodeJS.Signals | undefined);
    }) as typeof process.kill);

    await __terminateSupervisedChildrenForTests("sigkill");
    expect(processKillSpy).toHaveBeenCalledWith(-(child.pgid ?? 0), "SIGTERM");
    expect(processKillSpy).toHaveBeenCalledWith(-(child.pgid ?? 0), "SIGKILL");

    processKillSpy.mockRestore();
    child.child.kill("SIGKILL");
    await expect(child.waitExit()).resolves.toEqual({ code: null, signal: "SIGKILL" });
  });

  it("enforces maxLifetimeMs", async () => {
    const child = superviseSpawn(process.execPath, [fixturePath, "keepalive"], {
      stdio: "ignore",
      killGraceMs: 50,
      maxLifetimeMs: 50,
    });

    const exit = await child.waitExit();
    expect(exit.code === null || exit.code === 0 || exit.signal !== null).toBe(true);
    await waitFor(() => __getProcessSupervisorStateForTests().registrySize === 0);
  });

  it("installs parent handlers only once", async () => {
    const before = process.listenerCount("SIGTERM");

    const first = superviseSpawn(process.execPath, [fixturePath, "exit-immediately"], { stdio: "ignore" });
    const second = superviseSpawn(process.execPath, [fixturePath, "exit-immediately"], { stdio: "ignore" });

    await Promise.all([first.waitExit(), second.waitExit()]);

    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    expect(__getProcessSupervisorStateForTests().handlersInstalled).toBe(true);
  });

  it("uses the Windows fallback branch when process groups are unavailable", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    const child = superviseSpawn(process.execPath, [fixturePath, "exit-immediately"], {
      stdio: "ignore",
    });

    expect(child.pgid).toBeNull();
    await expect(child.waitExit()).resolves.toEqual({ code: 0, signal: null });
  });

  /*
  FNXC:ProcessLifecycle 2026-10-07-18:00:
  A killed supervised command leaves no descendant alive and its waitExit settles, on every platform.
  These run real `shell: true` children whose grandchild inherits the pipes, which is the shape that hung on Windows.
  */
  it("kills the whole tree of a shell command and settles while its grandchild held the pipes", async () => {
    const root = mkdtempSync(join(os.tmpdir(), "fn-process-supervisor-"));
    tempDirs.push(root);
    const childPidFile = join(root, "child.pid");
    const grandchildPidFile = join(root, "grandchild.pid");

    const child = superviseSpawn(
      `"${process.execPath}" "${fixturePath}" spawn-child-inherit "${childPidFile}" "${grandchildPidFile}"`,
      [],
      { shell: true, stdio: ["ignore", "pipe", "pipe"], killGraceMs: 100, maxLifetimeMs: Number.POSITIVE_INFINITY },
    );
    await waitFor(() => Number.parseInt(readFileSync(grandchildPidFile, "utf8"), 10) > 0);
    const grandchildPid = Number.parseInt(readFileSync(grandchildPidFile, "utf8"), 10);
    expect(isAlive(grandchildPid)).toBe(true);

    try {
      child.kill("SIGTERM");
      await expect(settlesWithin(child.waitExit(), 4_000)).resolves.toBe(true);
      await waitFor(() => !isAlive(grandchildPid), 4_000);
    } finally {
      forceKill(grandchildPid);
    }
  });

  it("bounds waitExit after a kill even when an orphaned descendant keeps the pipes open", async () => {
    const root = mkdtempSync(join(os.tmpdir(), "fn-process-supervisor-"));
    tempDirs.push(root);
    const childPidFile = join(root, "child.pid");
    const grandchildPidFile = join(root, "grandchild.pid");

    const child = superviseSpawn(
      `"${process.execPath}" "${fixturePath}" spawn-child-inherit-then-exit "${childPidFile}" "${grandchildPidFile}"`,
      [],
      {
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        killGraceMs: 100,
        stdioReleaseGraceMs: 100,
        maxLifetimeMs: Number.POSITIVE_INFINITY,
      },
    );
    child.child.stdout?.resume();
    child.child.stderr?.resume();
    await waitFor(() => Number.parseInt(readFileSync(grandchildPidFile, "utf8"), 10) > 0);
    const grandchildPid = Number.parseInt(readFileSync(grandchildPidFile, "utf8"), 10);
    await waitFor(() => child.child.exitCode !== null || child.child.signalCode !== null);

    try {
      child.kill("SIGTERM");
      await expect(settlesWithin(child.waitExit(), 3_000)).resolves.toBe(true);
    } finally {
      forceKill(grandchildPid);
    }
  });
});

class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdio = [null, this.stdout, this.stderr];
  kill = vi.fn(() => true);
}

describe("process-supervisor win32 tree kill", () => {
  let killers: EventEmitter[] = [];
  let spawnCalls: Array<{ command: string; args: readonly string[] }> = [];
  let spawnSyncCalls: Array<{ command: string; args: readonly string[] }> = [];

  function installWin32(): FakeChild {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    killers = [];
    spawnCalls = [];
    spawnSyncCalls = [];
    __setProcessTreeKillLauncherForTests({
      spawn: ((command: string, args: readonly string[]) => {
        spawnCalls.push({ command, args });
        const killer = Object.assign(new EventEmitter(), { unref: () => undefined });
        killers.push(killer);
        return killer;
      }) as unknown as typeof nodeSpawn,
      spawnSync: ((command: string, args: readonly string[]) => {
        spawnSyncCalls.push({ command, args });
        return { status: 0 };
      }) as unknown as typeof nodeSpawnSync,
    });
    return new FakeChild();
  }

  function spawnFake(fake: FakeChild, options: { stdioReleaseGraceMs?: number } = {}) {
    return superviseSpawn("pnpm test", [], {
      shell: true,
      spawnImpl: (() => fake as unknown as ChildProcess) as unknown as typeof nodeSpawn,
      maxLifetimeMs: Number.POSITIVE_INFINITY,
      ...options,
    });
  }

  afterEach(() => {
    __resetProcessSupervisorForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("kills the tree with taskkill /T /F for every signal and never signals a negative pid", () => {
    const fake = installWin32();
    const processKill = vi.spyOn(process, "kill");
    const supervised = spawnFake(fake);

    supervised.kill("SIGTERM");
    supervised.kill("SIGKILL");

    expect(spawnCalls).toHaveLength(2);
    for (const call of spawnCalls) {
      expect(call.command.toLowerCase()).toMatch(/taskkill(\.exe)?$/);
      expect(call.args).toEqual(["/PID", "4242", "/T", "/F"]);
    }
    expect(processKill.mock.calls.some(([pid]) => typeof pid === "number" && pid < 0)).toBe(false);
    expect(fake.kill).not.toHaveBeenCalled();
  });

  it("reports the requested signal for a tree-killed root, matching the POSIX exit shape", async () => {
    const fake = installWin32();
    const supervised = spawnFake(fake);

    supervised.kill("SIGTERM");
    fake.exitCode = 1;
    fake.emit("exit", 1, null);
    fake.emit("close", 1, null);

    await expect(supervised.waitExit()).resolves.toEqual({ code: null, signal: "SIGTERM" });
  });

  it("does not tree-kill a pid whose root already exited, because the pid may be reused", () => {
    const fake = installWin32();
    const supervised = spawnFake(fake);
    fake.exitCode = 0;
    fake.emit("exit", 0, null);

    supervised.kill("SIGTERM");

    expect(spawnCalls).toHaveLength(0);
  });

  it("falls back to a direct kill when taskkill cannot run", () => {
    const fake = installWin32();
    const supervised = spawnFake(fake);

    supervised.kill("SIGKILL");
    killers[0].emit("error", new Error("spawn taskkill ENOENT"));

    expect(fake.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("releases held pipes after the root exits so a killed command's waitExit settles", async () => {
    vi.useFakeTimers();
    const fake = installWin32();
    const supervised = spawnFake(fake, { stdioReleaseGraceMs: 250 });
    let settled = false;
    void supervised.waitExit().then(() => {
      settled = true;
    });
    // Mirror Node: `close` fires once the process exited and every stdio pipe closed.
    let closesGot = 0;
    const maybeClose = () => {
      closesGot += 1;
      if (closesGot === 3) fake.emit("close", null, "SIGTERM");
    };
    fake.stdout.on("close", maybeClose);
    fake.stderr.on("close", maybeClose);

    supervised.kill("SIGTERM");
    fake.signalCode = "SIGTERM";
    fake.emit("exit", null, "SIGTERM");
    maybeClose();
    await vi.advanceTimersByTimeAsync(249);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(10);
    expect(fake.stdout.destroyed).toBe(true);
    expect(fake.stderr.destroyed).toBe(true);
    expect(settled).toBe(true);
  });

  it("never force-closes the pipes of a command that was not killed", async () => {
    vi.useFakeTimers();
    const fake = installWin32();
    spawnFake(fake, { stdioReleaseGraceMs: 50 });
    fake.exitCode = 0;
    fake.emit("exit", 0, null);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.stdout.destroyed).toBe(false);
  });

  it("kills every live tree in one synchronous taskkill when the parent exits", () => {
    const fake = installWin32();
    const before = new Set(process.listeners("exit"));
    spawnFake(fake);
    const exitHandler = process.listeners("exit").find((listener) => !before.has(listener));
    expect(exitHandler).toBeDefined();

    exitHandler?.call(process, 0);

    expect(spawnSyncCalls).toHaveLength(1);
    expect(spawnSyncCalls[0].args).toEqual(["/PID", "4242", "/T", "/F"]);
    expect(spawnCalls).toHaveLength(0);
  });

  it("exposes the same tree kill to callers that own a raw pid", () => {
    installWin32();
    killProcessTree(777, "SIGTERM");
    expect(spawnCalls).toEqual([expect.objectContaining({ args: ["/PID", "777", "/T", "/F"] })]);
  });

  it("reports settlement once, after taskkill finishes, whatever its outcome", () => {
    installWin32();
    const settled = vi.fn();
    const failed = vi.fn();

    killProcessTree(777, "SIGKILL", { onSettled: settled, onTreeKillFailed: failed });
    expect(settled).not.toHaveBeenCalled();
    killers[0].emit("exit", 128);
    killers[0].emit("error", new Error("late"));

    expect(settled).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledTimes(1);

    killProcessTree(778, "SIGKILL", { sync: true, onSettled: settled });
    expect(settled).toHaveBeenCalledTimes(2);
  });
});

function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), timeoutMs).unref();
    }),
  ]);
}

function forceKill(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}
