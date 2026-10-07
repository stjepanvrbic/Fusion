import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronApp = vi.hoisted(() => ({
  relaunch: vi.fn(),
  quit: vi.fn(),
  exit: vi.fn(),
}));

vi.mock("electron", () => ({ app: electronApp }));

/*
 * C-041: the System-panel restart must go through the graceful quit so the quit coordinator can
 * finish runtime teardown. Its own force-exit fallback only covers a quit that never starts, so it
 * may not fire before the coordinator's teardown bound has expired.
 */
describe("desktop System-panel restart", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("relaunches through a graceful quit and never force-exits inside the teardown bound", async () => {
    const { resolveDesktopSystemControl } = await import("../local-runtime.ts");
    const { DESKTOP_SHUTDOWN_TIMEOUT_MS } = await import("../quit-coordinator.ts");
    const { systemControl } = await resolveDesktopSystemControl();

    expect(systemControl?.requestRestart("system-panel")).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(electronApp.relaunch).toHaveBeenCalledTimes(1);
    expect(electronApp.quit).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(DESKTOP_SHUTDOWN_TIMEOUT_MS);
    expect(electronApp.exit).not.toHaveBeenCalled();
  });
});
