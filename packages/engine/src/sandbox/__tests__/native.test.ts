import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cwd } from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NativeSandboxBackend } from "../native.js";

describe("NativeSandboxBackend", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "fusion-native-sandbox-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns stdout on success", async () => {
    const backend = new NativeSandboxBackend();
    // FNXC:TestInfraWindows 2026-10-07-18:04: the backend runs commands through the platform shell, so scripts use double outer quotes that sh and cmd.exe both parse.
    const result = await backend.run("node -e \"process.stdout.write('ok')\"", {
      cwd: cwd(),
      timeoutMs: 5_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf-8",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
    expect(result.timedOut).toBe(false);
    expect(result.bufferExceeded).toBe(false);
  });

  // FNXC:ProcessLifecycle 2026-10-08-01:40: the command never ends on its own, so only the timeout kill can settle it; a short-lived command could exit naturally before Windows' asynchronous tree kill and report exit code 0.
  it("maps timeout failures", async () => {
    const backend = new NativeSandboxBackend();
    const result = await backend.run("node -e \"setInterval(() => {}, 1000)\"", {
      cwd: cwd(),
      timeoutMs: 50,
      maxBuffer: 1024 * 1024,
      encoding: "utf-8",
    });

    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGTERM");
  });

  it.skipIf(process.platform === "win32")("times out and terminates descendant processes in the command process group", async () => {
    const backend = new NativeSandboxBackend();
    const markerPath = join(tempDir, "descendant-survived.txt");
    const parentScriptPath = join(tempDir, "spawn-descendant.cjs");
    await writeFile(
      parentScriptPath,
      `
const { spawn } = require("node:child_process");
spawn(process.execPath, [
  "-e",
  "setTimeout(() => require('node:fs').writeFileSync(process.env.MARKER, 'survived'), 450)",
], {
  env: { ...process.env, MARKER: process.argv[2] },
  stdio: "ignore",
}).unref();
setInterval(() => {}, 1000);
`,
      "utf-8",
    );

    const result = await backend.run(
      `${JSON.stringify(process.execPath)} ${JSON.stringify(parentScriptPath)} ${JSON.stringify(markerPath)}`,
      {
        cwd: tempDir,
        timeoutMs: 75,
        maxBuffer: 1024 * 1024,
        encoding: "utf-8",
      },
    );

    expect(result.timedOut).toBe(true);
    await delay(700);
    await expect(access(markerPath)).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")("cleans up background children after successful commands", async () => {
    const backend = new NativeSandboxBackend();
    const markerPath = join(tempDir, "success-descendant-survived.txt");
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify("setTimeout(() => require('node:fs').writeFileSync(process.env.MARKER, 'survived'), 450)")}], { env: { ...process.env, MARKER: process.env.MARKER }, stdio: 'ignore' }).unref();`,
      "process.stdout.write('parent-done');",
    ].join(" ");

    const result = await backend.run(
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(parentScript)}`,
      {
        cwd: tempDir,
        timeoutMs: 5_000,
        maxBuffer: 1024 * 1024,
        encoding: "utf-8",
        env: { ...process.env, MARKER: markerPath },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("parent-done");
    await delay(700);
    await expect(access(markerPath)).rejects.toThrow();
  });

  it("maps non-zero exits", async () => {
    const backend = new NativeSandboxBackend();
    const result = await backend.run("node -e \"process.stderr.write('fail'); process.exit(7)\"", {
      cwd: cwd(),
      timeoutMs: 5_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf-8",
    });

    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("fail");
    expect(result.timedOut).toBe(false);
  });

  /*
  FNXC:ProcessLifecycle 2026-10-07-23:34:
  Overflowing maxBuffer kills the command. The command keeps running after it overflows, so the kill, not a natural exit, ends it on every platform.
  A command that exits on its own right after writing races Windows' asynchronous tree kill and truthfully reports its own exit code.
  */
  it("maps maxBuffer failures", async () => {
    const backend = new NativeSandboxBackend();
    const startedAt = Date.now();
    const result = await backend.run("node -e \"process.stdout.write('x'.repeat(5000)); setInterval(() => {}, 1000)\"", {
      cwd: cwd(),
      timeoutMs: 5_000,
      maxBuffer: 512,
      encoding: "utf-8",
    });

    expect(result.bufferExceeded).toBe(true);
    expect(result.stdout).toBe("x".repeat(512));
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("prepare/dispose are idempotent no-ops", async () => {
    const backend = new NativeSandboxBackend();

    await expect(backend.prepare({ allowNetwork: true })).resolves.toBeUndefined();
    await expect(backend.prepare({ allowNetwork: false })).resolves.toBeUndefined();
    await expect(backend.dispose()).resolves.toBeUndefined();
    await expect(backend.dispose()).resolves.toBeUndefined();
  });

  /*
  FNXC:ProcessLifecycle 2026-10-07-18:00:
  Sandbox timeouts and aborts settle promptly and kill the command's whole tree on every platform.
  The grandchild inherits the output pipes, which is the shape that kept `close` pending on Windows.
  */
  describe("process tree teardown", () => {
    async function writeTreeScript(): Promise<{ command: string; pidFile: string }> {
      const script = join(tempDir, "tree.cjs");
      const pidFile = join(tempDir, "grandchild.pid");
      await writeFile(
        script,
        [
          "const { spawn } = require('node:child_process');",
          "const { writeFileSync } = require('node:fs');",
          "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
          "writeFileSync(process.argv[2], String(g.pid));",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );
      return { command: `"${process.execPath}" "${script}" "${pidFile}"`, pidFile };
    }

    async function readPid(pidFile: string): Promise<number> {
      for (let i = 0; i < 100; i++) {
        try {
          const pid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
          if (pid > 0) return pid;
        } catch {
          // Not written yet.
        }
        await delay(25);
      }
      throw new Error("grandchild pid was never written");
    }

    async function expectGone(pid: number): Promise<void> {
      for (let i = 0; i < 40 && isAlive(pid); i++) await delay(50);
      const alive = isAlive(pid);
      if (alive) process.kill(pid, "SIGKILL");
      expect(alive).toBe(false);
    }

    it("run() timeout settles and kills the grandchild holding the pipes", async () => {
      const { command, pidFile } = await writeTreeScript();
      const startedAt = Date.now();
      const result = await new NativeSandboxBackend().run(command, {
        cwd: tempDir,
        timeoutMs: 1_000,
        maxBuffer: 1024 * 1024,
        encoding: "utf-8",
      });

      expect(result.timedOut).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(1_000 + 3_000);
      await expectGone(await readPid(pidFile));
    });

    it("runStreaming() timeout settles and kills the grandchild holding the pipes", async () => {
      const { command, pidFile } = await writeTreeScript();
      const startedAt = Date.now();
      const result = await new NativeSandboxBackend().runStreaming(command, {
        cwd: tempDir,
        timeout: 1_000,
        maxBuffer: 1024 * 1024,
      });

      expect(result.outcome).toBe("timeout");
      expect(Date.now() - startedAt).toBeLessThan(1_000 + 3_000);
      await expectGone(await readPid(pidFile));
    });

    it("runStreaming() abort settles and kills the grandchild holding the pipes", async () => {
      const { command, pidFile } = await writeTreeScript();
      const controller = new AbortController();
      const pending = new NativeSandboxBackend().runStreaming(command, {
        cwd: tempDir,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        signal: controller.signal,
      });
      const grandchildPid = await readPid(pidFile);
      const abortedAt = Date.now();
      controller.abort();

      const result = await pending;
      expect(result.outcome).toBe("aborted");
      expect(Date.now() - abortedAt).toBeLessThan(3_000);
      await expectGone(grandchildPid);
    });
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
