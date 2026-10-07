import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const appHandlers = new Map<string, (...args: unknown[]) => void>();

  const app = {
    setAsDefaultProtocolClient: vi.fn(() => true),
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      appHandlers.set(event, handler);
      return app;
    }),
  };

  const browserWindow = {
    isVisible: vi.fn(() => true),
    show: vi.fn(),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    focus: vi.fn(),
    webContents: {
      send: vi.fn(),
    },
  };

  return {
    app,
    appHandlers,
    browserWindow,
  };
});

vi.mock("electron", () => ({
  app: mocks.app,
  BrowserWindow: vi.fn(function () {
    return mocks.browserWindow;
  }),
}));

async function importDeepLinkModule() {
  return import("../deep-link.ts");
}

describe("deep-link module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.appHandlers.clear();
    mocks.app.setAsDefaultProtocolClient.mockReturnValue(true);
    mocks.app.requestSingleInstanceLock.mockReturnValue(true);
    mocks.browserWindow.isVisible.mockReturnValue(true);
    mocks.browserWindow.isMinimized.mockReturnValue(false);
  });

  describe("parseDeepLink", () => {
    it("parses task deep links", async () => {
      const { parseDeepLink } = await importDeepLinkModule();

      expect(parseDeepLink("fusion://task/FN-123")).toEqual({
        type: "task",
        id: "FN-123",
        raw: "fusion://task/FN-123",
      });
    });

    it("parses project deep links", async () => {
      const { parseDeepLink } = await importDeepLinkModule();

      expect(parseDeepLink("fusion://project/my-project")).toEqual({
        type: "project",
        id: "my-project",
        raw: "fusion://project/my-project",
      });
    });

    it("returns empty id for task links without an identifier", async () => {
      const { parseDeepLink } = await importDeepLinkModule();

      expect(parseDeepLink("fusion://task/")).toEqual({
        type: "task",
        id: "",
        raw: "fusion://task/",
      });
    });

    it("returns null for fusion root URL", async () => {
      const { parseDeepLink } = await importDeepLinkModule();

      expect(parseDeepLink("fusion://")).toBeNull();
    });

    it("returns null for empty input", async () => {
      const { parseDeepLink } = await importDeepLinkModule();

      expect(parseDeepLink("")).toBeNull();
    });

    it("returns null for non-fusion scheme", async () => {
      const { parseDeepLink } = await importDeepLinkModule();

      expect(parseDeepLink("https://example.com")).toBeNull();
    });

    it("returns null for unknown fusion hosts", async () => {
      const { parseDeepLink } = await importDeepLinkModule();

      expect(parseDeepLink("fusion://unknown/something")).toBeNull();
    });

    it("ignores extra path segments", async () => {
      const { parseDeepLink } = await importDeepLinkModule();

      expect(parseDeepLink("fusion://task/FN-123/extra/path")).toEqual({
        type: "task",
        id: "FN-123",
        raw: "fusion://task/FN-123/extra/path",
      });
    });

    it("decodes URL-encoded project identifiers", async () => {
      const { parseDeepLink } = await importDeepLinkModule();

      expect(parseDeepLink("fusion://project/my%20project")).toEqual({
        type: "project",
        id: "my project",
        raw: "fusion://project/my%20project",
      });
    });
  });

  describe("registerDeepLinkProtocol", () => {
    it("registers fusion as default protocol", async () => {
      const { registerDeepLinkProtocol } = await importDeepLinkModule();

      registerDeepLinkProtocol();

      expect(mocks.app.setAsDefaultProtocolClient).toHaveBeenCalledWith("fusion");
    });

    it("does not throw when registration fails", async () => {
      const { registerDeepLinkProtocol } = await importDeepLinkModule();
      mocks.app.setAsDefaultProtocolClient.mockReturnValueOnce(false);

      expect(() => registerDeepLinkProtocol()).not.toThrow();
    });
  });

  describe("handleDeepLink", () => {
    it("sends deep-link event for task URLs", async () => {
      const { handleDeepLink } = await importDeepLinkModule();

      handleDeepLink(mocks.browserWindow as never, "fusion://task/FN-123");

      expect(mocks.browserWindow.webContents.send).toHaveBeenCalledWith("deep-link", {
        type: "task",
        id: "FN-123",
        raw: "fusion://task/FN-123",
      });
    });

    it("sends deep-link event for project URLs", async () => {
      const { handleDeepLink } = await importDeepLinkModule();

      handleDeepLink(mocks.browserWindow as never, "fusion://project/alpha");

      expect(mocks.browserWindow.webContents.send).toHaveBeenCalledWith("deep-link", {
        type: "project",
        id: "alpha",
        raw: "fusion://project/alpha",
      });
    });

    it("does not send event for invalid URLs", async () => {
      const { handleDeepLink } = await importDeepLinkModule();

      handleDeepLink(mocks.browserWindow as never, "https://example.com");

      expect(mocks.browserWindow.webContents.send).not.toHaveBeenCalled();
    });

    it("shows and focuses hidden windows", async () => {
      const { handleDeepLink } = await importDeepLinkModule();
      mocks.browserWindow.isVisible.mockReturnValueOnce(false);

      handleDeepLink(mocks.browserWindow as never, "fusion://task/FN-999");

      expect(mocks.browserWindow.show).toHaveBeenCalledTimes(1);
      expect(mocks.browserWindow.focus).toHaveBeenCalledTimes(1);
    });

    it("restores minimized windows before focus", async () => {
      const { handleDeepLink } = await importDeepLinkModule();
      mocks.browserWindow.isMinimized.mockReturnValueOnce(true);

      handleDeepLink(mocks.browserWindow as never, "fusion://task/FN-200");

      expect(mocks.browserWindow.restore).toHaveBeenCalledTimes(1);
      expect(mocks.browserWindow.focus).toHaveBeenCalledTimes(1);
    });
  });

  describe("setupDeepLinkHandler", () => {
    /*
     * C-044: the single-instance lock is taken by main's run() before boot, so registering the
     * relaunch handlers must not request it again or quit.
     */
    it("registers open-url and second-instance handlers without owning the single-instance lock", async () => {
      const { setupDeepLinkHandler } = await importDeepLinkModule();

      setupDeepLinkHandler(() => mocks.browserWindow as never);

      expect(mocks.app.on).toHaveBeenCalledWith("open-url", expect.any(Function));
      expect(mocks.app.on).toHaveBeenCalledWith("second-instance", expect.any(Function));
      expect(mocks.app.requestSingleInstanceLock).not.toHaveBeenCalled();
      expect(mocks.app.quit).not.toHaveBeenCalled();
    });

    /*
     * C-043: a hidden window must always be recoverable. Relaunching Fusion from the Start menu,
     * dock or a shortcut carries no fusion:// argument and must still reveal the window.
     */
    it.each([
      ["hidden", { visible: false, minimized: false }],
      ["minimized", { visible: true, minimized: true }],
      ["already visible", { visible: true, minimized: false }],
    ])("second-instance without a deep link reveals a %s window", async (_label, state) => {
      const { setupDeepLinkHandler } = await importDeepLinkModule();
      mocks.browserWindow.isVisible.mockReturnValue(state.visible);
      mocks.browserWindow.isMinimized.mockReturnValue(state.minimized);

      setupDeepLinkHandler(() => mocks.browserWindow as never);
      mocks.appHandlers.get("second-instance")?.({}, ["Fusion.exe"]);

      expect(mocks.browserWindow.show).toHaveBeenCalledTimes(state.visible ? 0 : 1);
      expect(mocks.browserWindow.restore).toHaveBeenCalledTimes(state.minimized ? 1 : 0);
      expect(mocks.browserWindow.focus).toHaveBeenCalledTimes(1);
      expect(mocks.browserWindow.webContents.send).not.toHaveBeenCalled();
    });

    it("second-instance with an unsupported fusion:// link still reveals the window", async () => {
      const { setupDeepLinkHandler } = await importDeepLinkModule();
      mocks.browserWindow.isVisible.mockReturnValue(false);

      setupDeepLinkHandler(() => mocks.browserWindow as never);
      mocks.appHandlers.get("second-instance")?.({}, ["Fusion.exe", "fusion://settings/general"]);

      expect(mocks.browserWindow.show).toHaveBeenCalledTimes(1);
      expect(mocks.browserWindow.focus).toHaveBeenCalledTimes(1);
      expect(mocks.browserWindow.webContents.send).not.toHaveBeenCalled();
    });

    /*
     * C-044: the handlers are registered before the window exists. A link that arrives during boot
     * is held and delivered once the window is created, instead of being dropped.
     */
    it.each(["open-url", "second-instance"] as const)("holds a %s deep link that arrives before the window and delivers it on flush", async (source) => {
      const { setupDeepLinkHandler } = await importDeepLinkModule();
      let window: typeof mocks.browserWindow | null = null;

      const router = setupDeepLinkHandler(() => window as never);
      if (source === "open-url") {
        mocks.appHandlers.get("open-url")?.({ preventDefault: vi.fn() }, "fusion://task/FN-900");
      } else {
        mocks.appHandlers.get("second-instance")?.({}, ["Fusion.exe", "fusion://task/FN-900"]);
      }
      expect(mocks.browserWindow.webContents.send).not.toHaveBeenCalled();

      window = mocks.browserWindow;
      router.flushPending();
      router.flushPending();

      expect(mocks.browserWindow.webContents.send).toHaveBeenCalledTimes(1);
      expect(mocks.browserWindow.webContents.send).toHaveBeenCalledWith("deep-link", {
        type: "task",
        id: "FN-900",
        raw: "fusion://task/FN-900",
      });
    });

    it("open-url handler prevents default and routes URL", async () => {
      const { setupDeepLinkHandler } = await importDeepLinkModule();

      setupDeepLinkHandler(() => mocks.browserWindow as never);

      const event = { preventDefault: vi.fn() };
      mocks.appHandlers.get("open-url")?.(event, "fusion://task/FN-777");

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mocks.browserWindow.webContents.send).toHaveBeenCalledWith("deep-link", {
        type: "task",
        id: "FN-777",
        raw: "fusion://task/FN-777",
      });
    });

    it("second-instance handler extracts fusion URL from argv", async () => {
      const { setupDeepLinkHandler } = await importDeepLinkModule();

      setupDeepLinkHandler(() => mocks.browserWindow as never);

      mocks.appHandlers.get("second-instance")?.({}, [
        "electron",
        "main.js",
        "--flag",
        "fusion://project/my-app",
      ]);

      expect(mocks.browserWindow.webContents.send).toHaveBeenCalledWith("deep-link", {
        type: "project",
        id: "my-app",
        raw: "fusion://project/my-app",
      });
    });

    it("second-instance handler sends no deep link when argv has none", async () => {
      const { setupDeepLinkHandler } = await importDeepLinkModule();

      setupDeepLinkHandler(() => mocks.browserWindow as never);
      mocks.appHandlers.get("second-instance")?.({}, ["electron", "main.js", "--help"]);

      expect(mocks.browserWindow.webContents.send).not.toHaveBeenCalled();
    });
  });
});
