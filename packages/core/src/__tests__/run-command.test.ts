import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommandAsync } from "../process/run-command.js";

const fixturePath = join(import.meta.dirname, "fixtures", "process-supervisor-child.mjs");

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("runCommandAsync", () => {
  it("terminates background children left in the command process group", async () => {
    if (process.platform === "win32") {
      return;
    }

    const childScript = "setInterval(() => {}, 1000)";
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
      "console.log(child.pid);",
      "child.unref();",
    ].join(" ");

    const result = await runCommandAsync(
      `${process.execPath} -e ${JSON.stringify(parentScript)}`,
      { timeoutMs: 5_000 },
    );

    expect(result.exitCode).toBe(0);
    const leakedPid = Number.parseInt(result.stdout.trim(), 10);
    expect(Number.isFinite(leakedPid)).toBe(true);

    for (let i = 0; i < 10 && isProcessAlive(leakedPid); i++) {
      await sleep(100);
    }

    expect(isProcessAlive(leakedPid)).toBe(false);
  });

  /*
  FNXC:ProcessLifecycle 2026-10-07-18:00:
  A command timeout bounds the caller's wait on every platform and kills the command's whole tree,
  including a grandchild that inherited the output pipes (the shape that hung `close` on Windows).
  */
  it("resolves a timed-out command promptly and kills the grandchild holding its pipes", async () => {
    const root = mkdtempSync(join(os.tmpdir(), "fn-run-command-"));
    const childPidFile = join(root, "child.pid");
    const grandchildPidFile = join(root, "grandchild.pid");
    let grandchildPid = 0;
    try {
      const startedAt = Date.now();
      const result = await runCommandAsync(
        `"${process.execPath}" "${fixturePath}" spawn-child-inherit "${childPidFile}" "${grandchildPidFile}"`,
        { timeoutMs: 1_500 },
      );
      grandchildPid = Number.parseInt(readFileSync(grandchildPidFile, "utf8"), 10);

      expect(result.timedOut).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(1_500 + 3_000);
      for (let i = 0; i < 20 && isProcessAlive(grandchildPid); i++) {
        await sleep(100);
      }
      expect(isProcessAlive(grandchildPid)).toBe(false);
    } finally {
      if (grandchildPid > 0 && isProcessAlive(grandchildPid)) process.kill(grandchildPid, "SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  });
});
