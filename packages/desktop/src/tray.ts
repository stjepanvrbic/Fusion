import path from "node:path";
import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  Tray,
  type MenuItemConstructorOptions,
  type NativeImage,
} from "electron";

/*
FNXC:DesktopTray 2026-10-07-18:02:
Operator controls must never report a state the system is not in.
The tray's Pause/Resume Engine item only flipped its own label and a hardcoded "Fusion — Running" tooltip, with no engine, API or renderer call behind it, so an operator could leave the machine believing dispatch had stopped.
The tray has no project context for a real pause, which is per-project and lives in the dashboard's engine controls, so the tray offers only window and quit controls and claims no engine state.
*/
const TRAY_TOOLTIP = "Fusion";

export interface TrayMenuOptions {
  isWindowVisible: boolean;
}

interface TrayState {
  mainWindow: BrowserWindow;
  isQuitting: boolean;
}

function toggleMainWindow(mainWindow: BrowserWindow): void {
  if (mainWindow.isVisible()) {
    mainWindow.hide();
    return;
  }

  mainWindow.show();
  mainWindow.focus();
}

function applyTrayMenu(tray: Tray, state: TrayState): void {
  const baseTemplate = buildTrayContextMenu({
    isWindowVisible: state.mainWindow.isVisible(),
  });

  const contextTemplate = baseTemplate.map((item) => {
    if (item.type === "separator") {
      return item;
    }

    if (item.label === "Show Window" || item.label === "Hide Window") {
      return {
        ...item,
        click: () => toggleMainWindow(state.mainWindow),
      };
    }

    return {
      ...item,
      click: () => {
        state.isQuitting = true;
        app.quit();
      },
    };
  });

  tray.setToolTip(TRAY_TOOLTIP);
  tray.setContextMenu(Menu.buildFromTemplate(contextTemplate));
}

export interface TrayIconLocation {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  resourcesPath: string;
  /** Directory of the running module: `dist/` when bundled, `src/` under tests. */
  moduleDir: string;
}

/*
FNXC:DesktopTray 2026-10-07-18:02:
tray.ts is bundled into dist/main.js and nothing copies the icons beside it, so loading from the module directory produced an empty image and the Windows "Minimize to tray" default left the window hidden behind a blank notification-area slot.
Packaged builds read the icons electron-builder ships as extraResources under `<resources>/icons`; development reads them from `src/icons`.
*/
export function resolveTrayIconPath(location: TrayIconLocation): string {
  const fileName = location.platform === "darwin" ? "tray-32.png" : "tray-48.png";
  const iconDir = location.isPackaged
    ? path.join(location.resourcesPath, "icons")
    : path.join(location.moduleDir, "..", "src", "icons");
  return path.join(iconDir, fileName);
}

export function createTrayIcon(): NativeImage {
  const iconPath = resolveTrayIconPath({
    platform: process.platform,
    isPackaged: app.isPackaged === true,
    resourcesPath: process.resourcesPath ?? "",
    moduleDir: import.meta.dirname,
  });
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    console.warn(`[desktop/tray] Could not load the tray icon from ${iconPath}`);
  }

  if (process.platform === "darwin") {
    return image.resize({ width: 16, height: 16 });
  }
  return image;
}

export function buildTrayContextMenu(options: TrayMenuOptions): MenuItemConstructorOptions[] {
  return [
    {
      label: options.isWindowVisible ? "Hide Window" : "Show Window",
    },
    {
      type: "separator",
    },
    {
      label: "Quit Fusion",
    },
  ];
}

export function setupTray(mainWindow: BrowserWindow, tray: Tray): Tray {
  const state: TrayState = {
    mainWindow,
    isQuitting: false,
  };

  tray.setImage(createTrayIcon());
  applyTrayMenu(tray, state);

  tray.on("click", () => {
    toggleMainWindow(mainWindow);
  });

  mainWindow.on("show", () => {
    applyTrayMenu(tray, state);
  });

  mainWindow.on("hide", () => {
    applyTrayMenu(tray, state);
  });

  mainWindow.on("close", (event) => {
    if (state.isQuitting) {
      return;
    }

    if (process.platform === "win32") {
      return;
    }

    event.preventDefault();
    mainWindow.hide();
  });

  app.on("before-quit", () => {
    state.isQuitting = true;
  });

  return tray;
}
