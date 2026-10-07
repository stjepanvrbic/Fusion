import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DESKTOP_SHUTDOWN_TIMEOUT_MS, installQuitCoordinator } from "../quit-coordinator.ts";

type BeforeQuitEvent = { preventDefault: ReturnType<typeof vi.fn> };

function createFakeApp() {
  const listeners: Array<(event: BeforeQuitEvent) => void> = [];
  const app = {
    on: vi.fn((event: string, listener: (event: BeforeQuitEvent) => void) => {
      if (event === "before-quit") listeners.push(listener);
      return app;
    }),
    quit: vi.fn(),
    exit: vi.fn(),
  };
  const emitBeforeQuit = (): BeforeQuitEvent => {
    const event = { preventDefault: vi.fn() };
    for (const listener of listeners) listener(event);
    return event;
  };
  return { app, emitBeforeQuit };
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/*
 * C-041: every quit path (Windows window close, tray Quit, menu Quit, System-panel restart) funnels
 * into Electron's before-quit. The process must never exit before runtime teardown settles or the
 * bound expires.
 */
describe("installQuitCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("vetoes the first quit, awaits teardown, then quits exactly once more", async () => {
    const { app, emitBeforeQuit } = createFakeApp();
    const stop = deferred();
    const teardown = vi.fn(() => stop.promise);
    installQuitCoordinator(app, { teardown });

    const first = emitBeforeQuit();
    expect(first.preventDefault).toHaveBeenCalledTimes(1);
    expect(teardown).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(app.quit).not.toHaveBeenCalled();

    stop.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(app.exit).not.toHaveBeenCalled();

    const second = emitBeforeQuit();
    expect(second.preventDefault).not.toHaveBeenCalled();
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("keeps vetoing repeated quit requests while teardown runs without starting it twice", async () => {
    const { app, emitBeforeQuit } = createFakeApp();
    const stop = deferred();
    const teardown = vi.fn(() => stop.promise);
    installQuitCoordinator(app, { teardown });

    emitBeforeQuit();
    const repeated = emitBeforeQuit();

    expect(repeated.preventDefault).toHaveBeenCalledTimes(1);
    expect(teardown).toHaveBeenCalledTimes(1);
    stop.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it("still quits when teardown fails", async () => {
    const { app, emitBeforeQuit } = createFakeApp();
    const stop = deferred();
    const log = vi.fn();
    installQuitCoordinator(app, { teardown: () => stop.promise, log });

    emitBeforeQuit();
    stop.reject(new Error("engine stop failed"));
    await vi.advanceTimersByTimeAsync(0);

    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalled();
  });

  it("force-exits when teardown outlives the bound", async () => {
    const { app, emitBeforeQuit } = createFakeApp();
    installQuitCoordinator(app, { teardown: () => new Promise<void>(() => undefined) });

    emitBeforeQuit();
    await vi.advanceTimersByTimeAsync(DESKTOP_SHUTDOWN_TIMEOUT_MS - 1);
    expect(app.exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(app.exit).toHaveBeenCalledWith(0);
    expect(app.quit).not.toHaveBeenCalled();
  });

  it("runs synchronous quit bookkeeping on every before-quit", () => {
    const { app, emitBeforeQuit } = createFakeApp();
    const onBeforeQuit = vi.fn();
    installQuitCoordinator(app, { teardown: () => new Promise<void>(() => undefined), onBeforeQuit });

    emitBeforeQuit();
    emitBeforeQuit();

    expect(onBeforeQuit).toHaveBeenCalledTimes(2);
  });
});
