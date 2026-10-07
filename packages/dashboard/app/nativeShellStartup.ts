import type { MobileShellBootstrapOptions, MobileShellBootstrapResult } from "@fusion/mobile/bootstrap";

/*
FNXC:MobileShell 2026-10-07-19:30:
The packaged Android/iOS app is this dashboard bundle running in a Capacitor WebView, so the mobile shell must be installed here before React mounts.
ShellProvider reads `window.fusionShell` once on first render and shell-host detection runs once, so a bridge installed later would leave the app in plain web mode with no backend and no way to pick a server.
Capacitor's native runtime defines `window.Capacitor` before page scripts; only then is the mobile bootstrap loaded (a lazy chunk, so browsers never fetch it).
When the bootstrap hands the WebView off to a saved server, the dashboard does not mount on the bundled origin.
A failed bootstrap still mounts the dashboard so the operator sees an error page rather than a blank WebView.
*/

type CapacitorWindow = { Capacitor?: { isNativePlatform?: () => boolean } };

export type MobileShellLoader = () => Promise<{
  bootstrapMobileShell: (options?: MobileShellBootstrapOptions) => Promise<MobileShellBootstrapResult>;
}>;

const loadMobileShell: MobileShellLoader = () => import("@fusion/mobile/bootstrap");

export function isCapacitorNativePlatform(target: object): boolean {
  try {
    return (target as CapacitorWindow).Capacitor?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

/**
 * Run the dashboard start sequence. Outside a native shell `startApp` runs synchronously; inside one it runs after the mobile bootstrap, unless the bootstrap handed off to a server.
 */
export function runDashboardStartup(
  startApp: () => void,
  { target = window, load = loadMobileShell }: { target?: Window; load?: MobileShellLoader } = {},
): Promise<void> | void {
  if (!isCapacitorNativePlatform(target)) {
    startApp();
    return;
  }
  return load()
    .then(({ bootstrapMobileShell }) => bootstrapMobileShell({ target, isNativePlatform: () => true }))
    .then(
      (result) => {
        if (result.kind !== "handoff") startApp();
      },
      (error: unknown) => {
        console.error("[fusion] native mobile shell failed to start", error);
        startApp();
      },
    );
}
