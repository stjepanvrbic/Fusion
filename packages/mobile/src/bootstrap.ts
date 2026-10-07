import { Capacitor } from "@capacitor/core";
import { MobileNativeShellBridge } from "./plugins/native-shell.js";
import { buildMobileShellHandoff } from "./plugins/shell-handoff.js";
import type { ShellConnectionState } from "./types.js";

/*
FNXC:MobileShell 2026-10-07-19:30:
The packaged Android/iOS app loads the bundled dashboard from the WebView's local origin, which has no Fusion backend.
Before the dashboard mounts, the shell must install `window.fusionShell` (saved connection profiles, QR scan, connection manager), start Android Back routing, and mark the host as the mobile shell.
With a saved active profile the WebView then hands off to that server in place; without one the dashboard shows native-shell onboarding.
A handoff is attempted automatically once per app session: a page reached again after a handoff (Back from the server, or Capacitor's errorPath after the server failed to load) stays on the bundled dashboard so the connection manager can recover instead of looping.
An explicit profile change from onboarding or the connection manager always hands off.
This module is the browser-bound entry, so its import graph must stay free of Node builtins.

FNXC:MobileShell 2026-10-07-19:30:
Handoff needs `server.allowNavigation: ["*"]` because saved servers are arbitrary hosts, and iOS injects the Capacitor bridge into every main-frame page it allows.
Saved profiles (including auth tokens) are readable through that bridge, so clicks on links to any origin other than the current page or a saved server are opened outside the WebView (Capacitor iOS hands window.open to Safari).
*/

export const MOBILE_SHELL_HANDOFF_MARKER_KEY = "fusion.mobile.handoff.v1";
export const MOBILE_SHELL_HOST_CONTEXT_KEY = "__FUSION_SHELL_HOST_CONTEXT__";

/** The parts of the page the bootstrap reads; it publishes `fusionShell` and the host context onto the same object. */
export type MobileShellBootstrapTarget = Pick<Window, "location" | "sessionStorage"> & Partial<Pick<Window, "document" | "open">>;

type PublishedGlobals = { fusionShell?: unknown; [MOBILE_SHELL_HOST_CONTEXT_KEY]?: unknown };

export interface MobileShellBootstrapOptions {
  target?: MobileShellBootstrapTarget;
  isNativePlatform?: () => boolean;
  createBridge?: () => MobileNativeShellBridge;
}

export type MobileShellDashboardReason =
  | "no-active-profile"
  | "missing-profile"
  | "invalid-server-url"
  | "on-server"
  | "returned-from-handoff";

export type MobileShellBootstrapResult =
  | { kind: "web" }
  | { kind: "handoff"; url: string; bridge: MobileNativeShellBridge }
  | { kind: "dashboard"; reason: MobileShellDashboardReason; bridge: MobileNativeShellBridge };

type HandoffDecision = { kind: "handoff"; url: string } | { kind: "dashboard"; reason: MobileShellDashboardReason };

const EMPTY_STATE: ShellConnectionState = { host: "mobile-shell", activeProfileId: null, profiles: [] };

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function readMarker(target: MobileShellBootstrapTarget): boolean {
  try {
    return target.sessionStorage.getItem(MOBILE_SHELL_HANDOFF_MARKER_KEY) !== null;
  } catch {
    return false;
  }
}

function writeMarker(target: MobileShellBootstrapTarget, url: string): void {
  try {
    target.sessionStorage.setItem(MOBILE_SHELL_HANDOFF_MARKER_KEY, originOf(url) ?? url);
  } catch {
    // Storage disabled: the handoff still proceeds; only the back-loop guard is lost.
  }
}

function decideHandoff(target: MobileShellBootstrapTarget, state: ShellConnectionState, automatic: boolean): HandoffDecision {
  const handoff = buildMobileShellHandoff(state);
  if (handoff.kind === "fallback") return { kind: "dashboard", reason: handoff.reason };
  if (originOf(target.location.href) === originOf(handoff.launch.serverBaseUrl)) return { kind: "dashboard", reason: "on-server" };
  if (automatic && readMarker(target)) return { kind: "dashboard", reason: "returned-from-handoff" };
  return { kind: "handoff", url: handoff.url };
}

function activeProfileKey(state: ShellConnectionState): string {
  const active = state.profiles.find((profile) => profile.id === state.activeProfileId);
  return active ? `${active.id}\n${active.serverUrl}\n${active.authToken ?? ""}` : "";
}

function navigate(target: MobileShellBootstrapTarget, url: string): void {
  writeMarker(target, url);
  // assign keeps the bundled page in history so Back from the server returns to the connection manager.
  target.location.assign(url);
}

function publishHostContext(target: MobileShellBootstrapTarget, state: ShellConnectionState): void {
  const active = state.profiles.find((profile) => profile.id === state.activeProfileId);
  (target as PublishedGlobals)[MOBILE_SHELL_HOST_CONTEXT_KEY] = {
    kind: "mobile-shell",
    mode: "remote",
    canOpenConnectionManager: true,
    ...(active ? { connectionId: active.id, serverUrl: active.serverUrl } : {}),
  };
}

function installForeignLinkGuard(target: MobileShellBootstrapTarget, trustedOrigins: () => Set<string>): void {
  const document = target.document;
  const open = target.open;
  if (!document || typeof open !== "function") return;
  document.addEventListener(
    "click",
    (event) => {
      const anchor = (event.target as { closest?: (selector: string) => HTMLAnchorElement | null } | null)?.closest?.("a[href]");
      if (!anchor || anchor.hasAttribute("download")) return;
      const destination = originOf(anchor.href);
      if (!destination || !/^https?:/.test(anchor.href)) return;
      if (destination === originOf(target.location.href) || trustedOrigins().has(destination)) return;
      event.preventDefault();
      open.call(target, anchor.href, "_blank", "noopener");
    },
    true,
  );
}

function savedServerOrigins(state: ShellConnectionState): Set<string> {
  const origins = new Set<string>();
  for (const profile of state.profiles) {
    const origin = originOf(profile.serverUrl);
    if (origin) origins.add(origin);
  }
  return origins;
}

/**
 * Install the native mobile shell before the dashboard mounts and hand off to the active server when appropriate.
 * Returns `web` without side effects outside a native Capacitor platform.
 */
export async function bootstrapMobileShell({
  target = window,
  isNativePlatform = () => Capacitor.isNativePlatform(),
  createBridge = () => new MobileNativeShellBridge(),
}: MobileShellBootstrapOptions = {}): Promise<MobileShellBootstrapResult> {
  if (!isNativePlatform()) return { kind: "web" };

  const bridge = createBridge();
  (target as PublishedGlobals).fusionShell = bridge;
  try {
    await bridge.initializeNativeBackButton();
  } catch (error) {
    console.warn("Failed to initialize native Back handling", error);
  }

  let state: ShellConnectionState;
  try {
    state = await bridge.getState();
  } catch (error) {
    console.warn("Failed to read saved shell connections", error);
    state = EMPTY_STATE;
  }
  publishHostContext(target, state);

  let trustedOrigins = savedServerOrigins(state);
  installForeignLinkGuard(target, () => trustedOrigins);

  let currentKey = activeProfileKey(state);
  bridge.subscribe((next) => {
    trustedOrigins = savedServerOrigins(next);
    const nextKey = activeProfileKey(next);
    if (nextKey === currentKey) return;
    currentKey = nextKey;
    const decision = decideHandoff(target, next, false);
    if (decision.kind === "handoff") navigate(target, decision.url);
  });

  const decision = decideHandoff(target, state, true);
  if (decision.kind === "handoff") {
    navigate(target, decision.url);
    return { kind: "handoff", url: decision.url, bridge };
  }
  return { kind: "dashboard", reason: decision.reason, bridge };
}
