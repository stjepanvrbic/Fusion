/*
FNXC:DesktopShutdown 2026-10-07-18:02:
Every desktop quit path (Windows window close, tray Quit, menu Quit, System-panel restart) funnels into Electron's before-quit.
Electron exits as soon as before-quit returns, so a fire-and-forget runtime stop killed in-flight merges and agent sessions with leases unreleased, left the engine lock fresh for the relaunched process, and never honored the Windows "stop or leave PostgreSQL" answer.
The coordinator vetoes the first quit, awaits teardown, then quits once more; if teardown outlives the bound it force-exits so a hung stop cannot keep a zombie process alive.
*/

/** Upper bound on runtime teardown (engine stop, CentralCore close, backend shutdown) before force-exit. */
export const DESKTOP_SHUTDOWN_TIMEOUT_MS = 15_000;

export interface QuitCoordinatorApp {
  on(event: "before-quit", listener: (event: { preventDefault(): void }) => void): unknown;
  quit(): void;
  exit(code?: number): void;
}

export interface QuitCoordinatorOptions {
  /** Runtime teardown awaited before the process may exit. */
  teardown: () => Promise<unknown> | unknown;
  /** Synchronous bookkeeping run on every before-quit, such as marking the app as quitting. */
  onBeforeQuit?: () => void;
  timeoutMs?: number;
  log?: (message: string, error?: unknown) => void;
}

export function installQuitCoordinator(app: QuitCoordinatorApp, options: QuitCoordinatorOptions): void {
  const timeoutMs = options.timeoutMs ?? DESKTOP_SHUTDOWN_TIMEOUT_MS;
  const log = options.log ?? ((message: string, error?: unknown) => console.error(`[desktop/quit] ${message}`, error ?? ""));
  let phase: "running" | "tearing-down" | "done" = "running";

  app.on("before-quit", (event) => {
    options.onBeforeQuit?.();
    if (phase === "done") return;
    event.preventDefault();
    if (phase === "tearing-down") return;
    phase = "tearing-down";

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const onTeardownError = (error: unknown): "settled" => {
      log("Runtime teardown failed; quitting anyway", error);
      return "settled";
    };
    let settled: Promise<"settled">;
    try {
      settled = Promise.resolve(options.teardown()).then(() => "settled" as const, onTeardownError);
    } catch (error) {
      settled = Promise.resolve(onTeardownError(error));
    }

    void Promise.race([settled, timedOut]).then((outcome) => {
      clearTimeout(timer);
      phase = "done";
      if (outcome === "timeout") {
        log(`Runtime teardown exceeded ${timeoutMs}ms; forcing exit`);
        app.exit(0);
        return;
      }
      app.quit();
    });
  });
}
