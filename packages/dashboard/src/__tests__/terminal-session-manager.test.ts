import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const supervisedKills = vi.hoisted(() => [] as NodeJS.Signals[]);
const spawnCalls = vi.hoisted(() => [] as Array<{ command: string; options: Record<string, unknown> }>);
const children = vi.hoisted(() => [] as EventEmitter[]);

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return {
    ...actual,
    superviseSpawn: (command: string, _args: readonly string[], options: Record<string, unknown>) => {
      spawnCalls.push({ command, options });
      const child = Object.assign(new EventEmitter(), {
        pid: 9191,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        kill: vi.fn(),
      });
      children.push(child);
      return {
        pid: 9191,
        pgid: 9191,
        child,
        kill: (signal: NodeJS.Signals = "SIGTERM") => {
          supervisedKills.push(signal);
        },
        waitExit: () => new Promise(() => undefined),
      };
    },
  };
});

const { TerminalSessionManager } = await import("../terminal.js");

/*
FNXC:ProcessLifecycle 2026-10-07-18:00:
Killing, timing out, or cleaning up a terminal command must go through the supervised child's kill, which is the
process-group kill on POSIX and the taskkill tree kill on Windows, so no descendant of the command survives.
*/
describe("TerminalSessionManager process teardown", () => {
  afterEach(() => {
    supervisedKills.length = 0;
    spawnCalls.length = 0;
    children.length = 0;
    vi.useRealTimers();
  });

  it("spawns commands under the process supervisor in a shell", () => {
    const manager = new TerminalSessionManager();
    const { sessionId, error } = manager.createSession("pnpm test", "/repo");

    expect(error).toBeUndefined();
    expect(sessionId).not.toBe("");
    expect(spawnCalls).toEqual([expect.objectContaining({ command: "pnpm test", options: expect.objectContaining({ shell: true, cwd: "/repo" }) })]);
  });

  it("kills a session through the supervised tree kill", () => {
    const manager = new TerminalSessionManager();
    const { sessionId } = manager.createSession("pnpm test", "/repo");

    expect(manager.killSession(sessionId, "SIGKILL")).toBe(true);
    expect(supervisedKills).toEqual(["SIGKILL"]);
    expect((children[0] as unknown as { kill: ReturnType<typeof vi.fn> }).kill).not.toHaveBeenCalled();
  });

  it("times a session out through the supervised tree kill", () => {
    vi.useFakeTimers();
    const manager = new TerminalSessionManager();
    manager.createSession("pnpm test", "/repo");

    vi.advanceTimersByTime(30_000);
    expect(supervisedKills).toEqual(["SIGTERM"]);
  });

  it("cleans up a still-running session through the supervised tree kill", () => {
    const manager = new TerminalSessionManager();
    const { sessionId } = manager.createSession("pnpm test", "/repo");

    expect(manager.cleanupSession(sessionId)).toBe(true);
    expect(supervisedKills).toEqual(["SIGKILL"]);
  });
});
