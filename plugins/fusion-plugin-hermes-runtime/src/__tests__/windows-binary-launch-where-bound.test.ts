import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

import {
  NEGATIVE_RESULT_TTL_MS,
  WHERE_LOOKUP_TIMEOUT_MS,
  __resetHermesLaunchCacheForTests,
  resolveHermesBinaryPath,
  resolveHermesLaunch,
} from "../windows-binary-launch.js";

/*
FNXC:HermesCli 2026-10-12-10:58:
The default Windows `where` lookup is bounded: a hung lookup is killed at WHERE_LOOKUP_TIMEOUT_MS, resolves as unresolved for every waiting caller, and is not cached, while a real miss keeps the negative cache.
These cases use no injected runWhere so the default runner and the process cache are exercised.
*/
const windows = { platform: "win32" as const, env: { PATH: "C:\\shims", PATHEXT: ".COM;.EXE;.BAT;.CMD" } };

interface FakeWhereChild {
  child: EventEmitter & { stdout: EventEmitter; kill: ReturnType<typeof vi.fn> };
  print(text: string): void;
  close(code: number): void;
}

function fakeWhereChild(): FakeWhereChild {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: vi.fn() });
  return {
    child,
    print: (text) => child.stdout.emit("data", Buffer.from(text, "utf8")),
    close: (code) => child.emit("close", code),
  };
}

function spawnReturns(...children: FakeWhereChild[]): void {
  for (const fake of children) mockSpawn.mockReturnValueOnce(fake.child);
}

beforeEach(() => {
  vi.useFakeTimers();
  mockSpawn.mockReset();
});

afterEach(() => {
  __resetHermesLaunchCacheForTests();
  vi.useRealTimers();
});

describe("bounded Windows where lookup", () => {
  it("kills a where child that never closes and resolves unresolved at the bound", async () => {
    const hung = fakeWhereChild();
    spawnReturns(hung);
    let settled = false;
    const lookup = resolveHermesBinaryPath("hermes", windows).finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(WHERE_LOOKUP_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(hung.child.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(lookup).resolves.toBeUndefined();
    expect(mockSpawn).toHaveBeenCalledWith("where", ["hermes"], expect.objectContaining({ windowsHide: true }));
    expect(hung.child.kill).toHaveBeenCalledTimes(1);

    hung.print("C:\\shims\\hermes.cmd\r\n");
    hung.close(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(hung.child.kill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not cache a timed-out lookup, so the next call runs where again", async () => {
    const hung = fakeWhereChild();
    const found = fakeWhereChild();
    spawnReturns(hung, found);

    const first = resolveHermesBinaryPath("hermes", windows);
    await vi.advanceTimersByTimeAsync(WHERE_LOOKUP_TIMEOUT_MS);
    await expect(first).resolves.toBeUndefined();

    const second = resolveHermesBinaryPath("hermes", windows);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    found.print("C:\\shims\\hermes.cmd\r\n");
    found.close(0);
    await expect(second).resolves.toBe("C:\\shims\\hermes.cmd");
    expect(found.child.kill).not.toHaveBeenCalled();
  });

  it("resolves every caller sharing one hung lookup at the bound", async () => {
    const hung = fakeWhereChild();
    spawnReturns(hung);

    const callers = [resolveHermesBinaryPath("hermes", windows), resolveHermesBinaryPath("hermes", windows)];
    await vi.advanceTimersByTimeAsync(WHERE_LOOKUP_TIMEOUT_MS);

    await expect(Promise.all(callers)).resolves.toEqual([undefined, undefined]);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(hung.child.kill).toHaveBeenCalledTimes(1);
  });

  it("keeps caching a real miss for the negative-result window and clears the bound timer", async () => {
    const miss = fakeWhereChild();
    spawnReturns(miss);

    const first = resolveHermesBinaryPath("hermes", windows);
    await vi.advanceTimersByTimeAsync(0);
    miss.close(1);
    await expect(first).resolves.toBeUndefined();
    expect(miss.child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(NEGATIVE_RESULT_TTL_MS - 1);
    await expect(resolveHermesBinaryPath("hermes", windows)).resolves.toBeUndefined();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("falls back to the bare binary launch when the lookup times out", async () => {
    spawnReturns(fakeWhereChild());

    const launch = resolveHermesLaunch("hermes", ["--version"], windows);
    await vi.advanceTimersByTimeAsync(WHERE_LOOKUP_TIMEOUT_MS);

    const spec = await launch;
    expect(spec).toEqual({ command: "hermes", args: ["--version"], resolvedBinaryPath: undefined });
    expect(spec.windowsVerbatimArguments).toBeUndefined();
  });
});
