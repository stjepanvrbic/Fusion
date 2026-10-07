import { afterEach, describe, expect, it, vi } from "vitest";

/*
The Bun-compiled `fn dashboard` initializes the native patch before the dashboard installs its graceful shutdown.
Signal handlers that exit synchronously preempt every async teardown step, orphaning child processes and embedded PostgreSQL with exit code 0.
*/
describe("native patch signal handling", () => {
  const bunGlobal = globalThis as { Bun?: unknown };
  const addedExitListeners: Array<(...args: unknown[]) => void> = [];

  afterEach(() => {
    for (const listener of addedExitListeners.splice(0)) process.removeListener("exit", listener);
    delete bunGlobal.Bun;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("registers no SIGINT/SIGTERM handler and never exits; cleanup runs on process exit", async () => {
    bunGlobal.Bun = { embeddedFiles: [] };
    vi.resetModules();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const before = {
      SIGINT: process.listeners("SIGINT"),
      SIGTERM: process.listeners("SIGTERM"),
      exit: process.listeners("exit"),
    };

    const { initNativePatch } = await import("../runtime/native-patch.js");
    initNativePatch();

    const added = (event: "SIGINT" | "SIGTERM" | "exit") =>
      process.listeners(event).filter((listener) => !before[event].includes(listener));
    addedExitListeners.push(...(added("exit") as Array<(...args: unknown[]) => void>));
    expect(added("SIGINT")).toEqual([]);
    expect(added("SIGTERM")).toEqual([]);
    expect(added("exit")).toHaveLength(1);
    expect(exit).not.toHaveBeenCalled();
  });
});
