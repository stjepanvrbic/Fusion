import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The packaged app's startup path: bootstrapMobileShell runs before the dashboard mounts.
 * Only Capacitor's native surfaces are faked; the bridge, saved profiles and handoff are the real modules.
 */

const preferences = vi.hoisted(() => new Map<string, string>());
const native = vi.hoisted(() => ({
  isNative: true,
  backButton: undefined as undefined | ((event: { canGoBack: boolean }) => void),
  exitApp: undefined as unknown as ReturnType<typeof import("vitest").vi.fn>,
}));

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: preferences.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => {
      preferences.set(key, value);
    },
  },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => native.isNative },
}));

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: async (event: string, listener: (event: { canGoBack: boolean }) => void) => {
      if (event === "backButton") native.backButton = listener;
      return { remove: async () => {} };
    },
    exitApp: (...args: unknown[]) => native.exitApp(...args),
  },
}));

const PROFILES_KEY = "fusion.shell.connections.v1";
const ANDROID_BUNDLED = "https://localhost/";
const IOS_BUNDLED = "capacitor://localhost/";

function saveProfiles(activeProfileId: string | null, profiles: Array<Record<string, unknown>>): void {
  preferences.set(PROFILES_KEY, JSON.stringify({ activeProfileId, profiles }));
}

const prodProfile = {
  id: "prod",
  name: "Prod",
  serverUrl: "https://fusion.example.com",
  authToken: "secret-token",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function createTarget(href: string, session = new Map<string, string>()) {
  return {
    location: { href, assign: vi.fn() },
    sessionStorage: {
      getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => void session.set(key, value),
    },
  } as unknown as Window & Record<string, unknown>;
}

async function load() {
  return import("../bootstrap.js");
}

beforeEach(() => {
  vi.resetModules();
  preferences.clear();
  native.isNative = true;
  native.backButton = undefined;
  native.exitApp = vi.fn(async () => {});
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

describe("bootstrapMobileShell", () => {
  it("does nothing in a plain browser", async () => {
    const { bootstrapMobileShell } = await load();
    native.isNative = false;
    const target = createTarget("https://fusion.example.com/");

    expect(await bootstrapMobileShell({ target })).toEqual({ kind: "web" });
    expect(target.fusionShell).toBeUndefined();
    expect(target.location.assign).not.toHaveBeenCalled();
  });

  for (const [platform, bundled] of [["android", ANDROID_BUNDLED], ["ios", IOS_BUNDLED]] as const) {
    describe(`${platform} startup`, () => {
      it("installs the shell bridge and host context on a fresh install and stays for onboarding", async () => {
        const { bootstrapMobileShell, MOBILE_SHELL_HOST_CONTEXT_KEY } = await load();
        const target = createTarget(bundled);

        const result = await bootstrapMobileShell({ target });

        expect(result).toMatchObject({ kind: "dashboard", reason: "no-active-profile" });
        expect(target.location.assign).not.toHaveBeenCalled();
        expect(await target.fusionShell!.getState()).toEqual({ host: "mobile-shell", activeProfileId: null, profiles: [] });
        expect(target[MOBILE_SHELL_HOST_CONTEXT_KEY]).toEqual({ kind: "mobile-shell", mode: "remote", canOpenConnectionManager: true });
      });

      it("hands a saved active profile off to its server with the auth token and shell launch context", async () => {
        const { bootstrapMobileShell } = await load();
        saveProfiles("prod", [prodProfile]);
        const target = createTarget(bundled);

        const result = await bootstrapMobileShell({ target });

        expect(result.kind).toBe("handoff");
        expect(target.location.assign).toHaveBeenCalledTimes(1);
        const url = new URL(vi.mocked(target.location.assign).mock.calls[0]![0] as string);
        expect(url.origin).toBe("https://fusion.example.com");
        expect(Object.fromEntries(url.searchParams)).toMatchObject({
          shellKind: "mobile",
          shellMode: "remote",
          profileId: "prod",
          serverBaseUrl: "https://fusion.example.com",
          token: "secret-token",
          shellCanOpenConnectionManager: "1",
        });
        expect(url.searchParams.has("rt")).toBe(false);
      });

      it("hands off a saved profile without an auth token carrying no credential param", async () => {
        const { bootstrapMobileShell } = await load();
        const { authToken: _omitted, ...tokenlessProfile } = prodProfile;
        saveProfiles("prod", [tokenlessProfile]);
        const target = createTarget(bundled);

        const result = await bootstrapMobileShell({ target });

        expect(result.kind).toBe("handoff");
        const url = new URL(vi.mocked(target.location.assign).mock.calls[0]![0] as string);
        expect(url.searchParams.has("token")).toBe(false);
        expect(url.searchParams.has("rt")).toBe(false);
      });

      it("does not hand off to a saved profile whose server URL is invalid", async () => {
        const { bootstrapMobileShell } = await load();
        saveProfiles("bad", [{ ...prodProfile, id: "bad", serverUrl: "javascript:alert(1)" }]);
        const target = createTarget(bundled);

        expect(await bootstrapMobileShell({ target })).toMatchObject({ kind: "dashboard", reason: "no-active-profile" });
        expect(target.location.assign).not.toHaveBeenCalled();
      });

      it("stays on the bundled dashboard with a working connection manager after the server failed to load", async () => {
        const { bootstrapMobileShell } = await load();
        saveProfiles("prod", [prodProfile]);
        const session = new Map<string, string>();
        await bootstrapMobileShell({ target: createTarget(bundled, session) });

        // Capacitor's errorPath (or Back from the server) reloads the bundled app in the same session.
        const reloaded = createTarget(bundled, session);
        vi.resetModules();
        const { bootstrapMobileShell: bootstrapAgain } = await load();
        const result = await bootstrapAgain({ target: reloaded });

        expect(result).toMatchObject({ kind: "dashboard", reason: "returned-from-handoff" });
        expect(reloaded.location.assign).not.toHaveBeenCalled();
        const dispatched: string[] = [];
        globalThis.window = { dispatchEvent: (event: Event) => dispatched.push(event.type) } as unknown as Window & typeof globalThis;
        await reloaded.fusionShell!.openConnectionManager();
        expect(dispatched).toEqual(["shell:open-connection-manager"]);
      });

      it("hands off again when the operator picks a server in the connection manager", async () => {
        const { bootstrapMobileShell } = await load();
        saveProfiles("prod", [prodProfile]);
        const session = new Map<string, string>([["fusion.mobile.handoff.v1", "https://fusion.example.com"]]);
        const target = createTarget(bundled, session);
        await bootstrapMobileShell({ target });
        expect(target.location.assign).not.toHaveBeenCalled();

        const saved = await target.fusionShell!.saveProfile({ name: "Staging", serverUrl: "http://192.168.1.20:4040" });
        await target.fusionShell!.setActiveProfile(saved.id);

        await vi.waitFor(() => expect(target.location.assign).toHaveBeenCalledTimes(1));
        expect(new URL(vi.mocked(target.location.assign).mock.calls[0]![0] as string).origin).toBe("http://192.168.1.20:4040");
      });

      it("keeps the bridge without re-navigating when the page is already the active server", async () => {
        const { bootstrapMobileShell, MOBILE_SHELL_HOST_CONTEXT_KEY } = await load();
        saveProfiles("prod", [prodProfile]);
        const target = createTarget("https://fusion.example.com/?shellKind=mobile");

        expect(await bootstrapMobileShell({ target })).toMatchObject({ kind: "dashboard", reason: "on-server" });
        expect(target.location.assign).not.toHaveBeenCalled();
        expect(target.fusionShell).toBeDefined();
        expect(target[MOBILE_SHELL_HOST_CONTEXT_KEY]).toMatchObject({ kind: "mobile-shell", connectionId: "prod", serverUrl: "https://fusion.example.com" });
      });
    });
  }

  it("routes Android Back through the dashboard's native-back event before React mounts", async () => {
    const { bootstrapMobileShell } = await load();
    const events = new EventTarget();
    const history = { back: vi.fn() };
    globalThis.window = Object.assign(events, { history }) as unknown as Window & typeof globalThis;
    await bootstrapMobileShell({ target: createTarget(ANDROID_BUNDLED) });
    expect(native.backButton).toBeTypeOf("function");

    events.addEventListener("fusion:native-back", (event) => event.preventDefault(), { once: true });
    native.backButton!({ canGoBack: true });
    expect(history.back).not.toHaveBeenCalled();

    native.backButton!({ canGoBack: true });
    expect(history.back).toHaveBeenCalledTimes(1);

    native.backButton!({ canGoBack: false });
    expect(native.exitApp).toHaveBeenCalledTimes(1);
  });
});

describe("foreign-origin link guard", () => {
  function createGuardedTarget(href: string) {
    const document = new EventTarget();
    const target = Object.assign(createTarget(href), { document, open: vi.fn() });
    return { target, document };
  }

  function click(document: EventTarget, anchorHref: string): Event {
    const event = new Event("click", { cancelable: true });
    const anchor = { href: anchorHref, hasAttribute: () => false };
    Object.defineProperty(event, "target", { value: { closest: (selector: string) => (selector.startsWith("a") ? anchor : null) } });
    document.dispatchEvent(event);
    return event;
  }

  it("opens links to other origins outside the WebView so they never get the native bridge", async () => {
    const { bootstrapMobileShell } = await load();
    saveProfiles("prod", [prodProfile]);
    const { target, document } = createGuardedTarget("https://fusion.example.com/");
    await bootstrapMobileShell({ target });

    const foreign = click(document, "https://evil.example/steal");
    expect(foreign.defaultPrevented).toBe(true);
    expect(target.open).toHaveBeenCalledWith("https://evil.example/steal", "_blank", "noopener");
  });

  it("leaves same-origin and saved-server links in the WebView", async () => {
    const { bootstrapMobileShell } = await load();
    saveProfiles("prod", [prodProfile, { ...prodProfile, id: "lan", name: "LAN", serverUrl: "http://192.168.1.20:4040" }]);
    const { target, document } = createGuardedTarget("https://fusion.example.com/");
    await bootstrapMobileShell({ target });

    expect(click(document, "https://fusion.example.com/tasks/FN-1").defaultPrevented).toBe(false);
    expect(click(document, "http://192.168.1.20:4040/").defaultPrevented).toBe(false);
    expect(click(document, "mailto:ops@example.com").defaultPrevented).toBe(false);
    expect(target.open).not.toHaveBeenCalled();
  });
});

describe("browser-bound mobile sources", () => {
  it("import no Node builtins, because they run inside the packaged WebView", () => {
    const srcDir = fileURLToPath(new URL("..", import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          if (entry !== "__tests__") walk(path);
          continue;
        }
        if (!path.endsWith(".ts")) continue;
        const source = readFileSync(path, "utf8");
        if (/(?:from\s+|import\s*\(\s*)["']node:/.test(source)) offenders.push(relative(srcDir, path));
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });
});
