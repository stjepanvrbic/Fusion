import { beforeEach, describe, expect, it, vi } from "vitest";
import { runDashboardStartup } from "../nativeShellStartup";
import { __resetShellHostContextForTests, detectShellHostContext } from "../shell-host";

/*
 * The packaged mobile app is this dashboard bundle in a Capacitor WebView.
 * These run the real @fusion/mobile bootstrap through the entry's loader; only the native runtime marker and navigation are faked.
 */

const PROFILES_KEY = "CapacitorStorage.fusion.shell.connections.v1";

function nativeTarget(href: string) {
  const session = new Map<string, string>();
  return {
    Capacitor: { isNativePlatform: () => true },
    location: { href, assign: vi.fn() },
    sessionStorage: {
      getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => void session.set(key, value),
    },
    document: new EventTarget(),
    open: vi.fn(),
  } as unknown as Window & { fusionShell?: unknown; location: { assign: ReturnType<typeof vi.fn> } };
}

beforeEach(() => {
  window.localStorage.clear();
  __resetShellHostContextForTests();
});

describe("dashboard startup in the packaged mobile app", () => {
  it("mounts synchronously in a browser without loading the mobile shell", () => {
    const startApp = vi.fn();
    const load = vi.fn();

    expect(runDashboardStartup(startApp, { target: window, load })).toBeUndefined();
    expect(startApp).toHaveBeenCalledTimes(1);
    expect(load).not.toHaveBeenCalled();
  });

  it("installs the native shell bridge and mobile host context before the dashboard mounts", async () => {
    const target = nativeTarget("https://localhost/");
    const seen: Array<{ bridge: boolean; host: string }> = [];

    await runDashboardStartup(() => {
      seen.push({ bridge: target.fusionShell !== undefined, host: detectShellHostContext(target).kind });
    }, { target });

    expect(seen).toEqual([{ bridge: true, host: "mobile-shell" }]);
    expect(target.location.assign).not.toHaveBeenCalled();
  });

  it("hands a saved server off without mounting the dashboard on the bundled origin", async () => {
    window.localStorage.setItem(PROFILES_KEY, JSON.stringify({
      activeProfileId: "prod",
      profiles: [{ id: "prod", name: "Prod", serverUrl: "https://fusion.example.com", authToken: "secret-token", createdAt: "x", updatedAt: "x" }],
    }));
    const target = nativeTarget("https://localhost/");
    const startApp = vi.fn();

    await runDashboardStartup(startApp, { target });

    expect(startApp).not.toHaveBeenCalled();
    const url = new URL(target.location.assign.mock.calls[0]![0] as string);
    expect(url.origin).toBe("https://fusion.example.com");
    expect(url.searchParams.get("token")).toBe("secret-token");
    expect(url.searchParams.get("shellKind")).toBe("mobile");
  });

  it("still mounts when the mobile shell fails to load", async () => {
    const startApp = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await runDashboardStartup(startApp, { target: nativeTarget("https://localhost/"), load: () => Promise.reject(new Error("chunk failed")) });

    expect(startApp).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
