import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * C-114: the real electron-updater channel setter rejects a non-string once any channel has been set,
 * so a writable-property fake cannot catch this. These tests drive a real AppUpdater subclass whose only
 * stubs are the network check and the Electron app adapter.
 */
const harness = vi.hoisted(() => ({
  updater: null as unknown,
  settings: { updateChannel: "stable" } as { updateChannel?: string } | Error,
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp"), getVersion: vi.fn(() => "0.78.0-beta.7") },
  BrowserWindow: vi.fn(),
  dialog: {},
  Notification: Object.assign(vi.fn(), { isSupported: vi.fn(() => false) }),
}));

vi.mock("electron-updater", () => ({
  get autoUpdater() {
    return harness.updater;
  },
  get default() {
    return { autoUpdater: harness.updater };
  },
}));

vi.mock("@fusion/core", () => ({
  GlobalSettingsStore: vi.fn(function () {
    return {
      init: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => {
        if (harness.settings instanceof Error) throw harness.settings;
        return harness.settings;
      }),
    };
  }),
}));

type RealUpdater = {
  channel: string | null;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  checkForUpdates: ReturnType<typeof vi.fn>;
};

async function createRealUpdater(): Promise<RealUpdater> {
  const { AppUpdater } = await vi.importActual<{ AppUpdater: new (options: unknown, app: unknown) => object }>("electron-updater");
  class TestUpdater extends AppUpdater {
    checkForUpdates = vi.fn(async () => null);
    doDownloadUpdate(): Promise<string[]> {
      return Promise.resolve([]);
    }
  }
  const fakeApp = {
    version: "0.78.0-beta.7",
    name: "Fusion",
    isPackaged: true,
    appUpdateConfigPath: "",
    userDataPath: "",
    baseCachePath: "",
    whenReady: () => Promise.resolve(),
    onQuit: () => undefined,
    relaunch: () => undefined,
    quit: () => undefined,
  };
  return new TestUpdater(null, fakeApp) as unknown as RealUpdater;
}

async function checkWith(updateChannel: string | Error) {
  harness.settings = updateChannel instanceof Error ? updateChannel : { updateChannel };
  const { triggerUpdateCheck } = await import("../native.ts");
  return triggerUpdateCheck();
}

describe("desktop updater channel selection", () => {
  beforeEach(async () => {
    vi.resetModules();
    harness.updater = await createRealUpdater();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it.each([
    ["stable", "latest", false],
    ["beta", "beta", true],
  ])("an initial %s check selects the %s channel", async (setting, channel, allowPrerelease) => {
    const result = await checkWith(setting);
    const updater = harness.updater as RealUpdater;

    expect(result).toEqual({ status: "checking" });
    expect(updater.channel).toBe(channel);
    expect(updater.allowPrerelease).toBe(allowPrerelease);
    expect(updater.allowDowngrade).toBe(false);
  });

  it("switches beta to stable to beta in one session without ERR_UPDATER_INVALID_CHANNEL", async () => {
    const updater = harness.updater as RealUpdater;

    for (const [setting, channel, allowPrerelease] of [
      ["beta", "beta", true],
      ["stable", "latest", false],
      ["stable", "latest", false],
      ["beta", "beta", true],
    ] as const) {
      const result = await checkWith(setting);
      expect(result).toEqual({ status: "checking" });
      expect(updater.channel).toBe(channel);
      expect(updater.allowPrerelease).toBe(allowPrerelease);
      expect(updater.allowDowngrade).toBe(false);
    }
    expect(updater.checkForUpdates.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("falls back to stable after a beta check when settings become unreadable", async () => {
    const updater = harness.updater as RealUpdater;
    await checkWith("beta");

    const result = await checkWith(new Error("settings unreadable"));

    expect(result).toEqual({ status: "checking" });
    expect(updater.channel).toBe("latest");
    expect(updater.allowPrerelease).toBe(false);
  });
});
