import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

import { probeAgentBrowserBinary } from "../probe.js";

function fakeChild(onSpawn: (child: EventEmitter & { stdout: PassThrough; stderr: PassThrough }) => void) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), exitCode: null, signalCode: null });
  queueMicrotask(() => onSpawn(child));
  return child;
}

describe("probeAgentBrowserBinary launch", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation((command: string) =>
      command === "where" || command === "which"
        ? fakeChild((child) => child.emit("close", 1))
        : fakeChild((child) => {
          child.stdout.write("agent-browser 1.0.0\n");
          child.emit("close", 0);
        }));
    // An empty PATH keeps launch resolution hermetic on hosts with a real agent-browser installed.
    vi.stubEnv("PATH", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("probes without a shell on every platform", async () => {
    for (const platform of ["win32", "linux"] as const) {
      spawnMock.mockClear();
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      await expect(probeAgentBrowserBinary()).resolves.toMatchObject({ available: true, version: "agent-browser 1.0.0" });
      const probeCall = spawnMock.mock.calls.find(([command]) => command !== "where" && command !== "which");
      expect(probeCall?.[0]).toBe("agent-browser");
      expect(probeCall?.[2]).toMatchObject({ shell: false, windowsHide: true });
    }
  });

  it("runs a configured JS entry through node, as a Windows shim would", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    await probeAgentBrowserBinary({ binaryPath: "C:\\tools\\agent-browser\\cli.js" });
    expect(spawnMock).toHaveBeenCalledWith(process.execPath, ["C:\\tools\\agent-browser\\cli.js", "--version"], expect.objectContaining({ shell: false }));
  });
});
