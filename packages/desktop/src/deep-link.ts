import { app, BrowserWindow } from "electron";

export interface DeepLinkResult {
  type: "task" | "project" | "unknown";
  id: string;
  raw: string;
}

const DEEP_LINK_EVENT = "deep-link";
const FUSION_SCHEME = "fusion:";

export function registerDeepLinkProtocol(): void {
  try {
    const isRegistered = app.setAsDefaultProtocolClient("fusion");
    if (!isRegistered) {
      console.warn("[desktop/deep-link] Failed to register fusion:// protocol");
      return;
    }

    console.log("[desktop/deep-link] Registered fusion:// protocol handler");
  } catch (error) {
    console.error("[desktop/deep-link] Error while registering fusion:// protocol", error);
  }
}

export function parseDeepLink(rawUrl: string): DeepLinkResult | null {
  if (!rawUrl) {
    return null;
  }

  try {
    const parsedUrl = new URL(rawUrl);

    if (parsedUrl.protocol !== FUSION_SCHEME) {
      return null;
    }

    const type = parsedUrl.hostname;
    if (type !== "task" && type !== "project") {
      return null;
    }

    const pathSegments = parsedUrl.pathname
      .split("/")
      .filter((segment) => segment.length > 0);

    const decodedId = pathSegments.length > 0 ? decodeURIComponent(pathSegments[0]) : "";

    return {
      type,
      id: decodedId,
      raw: rawUrl,
    };
  } catch {
    return null;
  }
}

function revealWindow(mainWindow: BrowserWindow): void {
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.focus();
}

export function handleDeepLink(mainWindow: BrowserWindow, url: string): void {
  const parsed = parseDeepLink(url);

  if (!parsed || parsed.type === "unknown") {
    console.warn(`[desktop/deep-link] Ignoring unsupported deep link: ${url}`);
    return;
  }

  revealWindow(mainWindow);
  mainWindow.webContents.send(DEEP_LINK_EVENT, parsed);
}

export interface DeepLinkRouter {
  /** Deliver a deep link that arrived before the main window existed. */
  flushPending(): void;
}

/*
FNXC:DesktopSingleInstance 2026-10-07-18:02:
main's run() takes the single-instance lock before boot and registers these handlers before the window exists, so the window is resolved when an event arrives and a link received during boot is held until flushPending().
Every second-instance launch reveals the window, with or without a fusion:// argument: relaunching Fusion is the operator's way back to a window hidden in the tray, so a hidden window must always be recoverable.
*/
export function setupDeepLinkHandler(getMainWindow: () => BrowserWindow | null): DeepLinkRouter {
  let pendingDeepLink: string | null = null;

  const route = (url: string): void => {
    const mainWindow = getMainWindow();
    if (!mainWindow) {
      pendingDeepLink = url;
      return;
    }
    handleDeepLink(mainWindow, url);
  };

  app.on("open-url", (event, url) => {
    event.preventDefault();
    route(url);
  });

  app.on("second-instance", (_event, argv) => {
    const deepLink = argv.find((arg) => arg.startsWith("fusion://"));
    const mainWindow = getMainWindow();
    if (mainWindow) {
      revealWindow(mainWindow);
    }
    if (deepLink) {
      route(deepLink);
    }
  });

  return {
    flushPending: () => {
      const mainWindow = getMainWindow();
      if (!pendingDeepLink || !mainWindow) return;
      const url = pendingDeepLink;
      pendingDeepLink = null;
      handleDeepLink(mainWindow, url);
    },
  };
}
