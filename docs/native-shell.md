# Native Shell Connection Guide

[← Docs index](./README.md)

This is the canonical guide for how Fusion native shells (mobile and desktop) connect to remote Fusion dashboards, persist saved connections, and hand off shell state to the dashboard.

## Overview

Native shells expose a shared `window.fusionShell` bridge that the dashboard reads through `ShellContext`.

- **Mobile shell** always runs in remote mode and requires an active connection profile.
- **Desktop shell** supports both **Local Fusion** and **Remote Server** modes.
- **Web/PWA** does not use shell onboarding.

## First-run onboarding flow

The dashboard gates first-run shell onboarding in `requiresNativeShellOnboarding(...)` (`packages/dashboard/app/App.tsx`):

- `host === "mobile-shell"`: onboarding is required until `activeProfileId` is set.
- `host === "desktop-shell"`:
  - `desktopMode === "local"`: onboarding is not required.
  - `desktopMode === "remote"` (or unset): onboarding is required until `activeProfileId` is set.

`NativeShellOnboardingModal` then provides:

1. **Desktop mode choice** (desktop only):
   - **Local Fusion** → calls `setDesktopMode("local")`.
   - **Remote Server** → stays in remote flow.
2. **Remote connection entry** (mobile + desktop remote mode):
   - **Scan QR** (`startQrScan()`)
   - Manual fields: profile name, server URL, optional auth token
3. **Continue**:
   - Saves profile via `saveProfile(...)`
   - Sets desktop mode to remote when relevant
   - Activates profile via `setActiveProfile(...)`
   - Redirects to selected remote dashboard URL (adds `token=<token>` query when token is present)

## QR scan and manual fallback

QR scan is optional convenience. Manual entry is always supported.

QR payload parsing accepts either:

- JSON payload with `serverUrl` and optional `authToken`
- URL payload, reading token from `authToken` or `rt`

If scanning fails or is unavailable, users can continue with manual URL + token entry.

## Saved connection profiles

Profiles are first-class saved objects shared by onboarding and Connection Manager:

- `name`
- `serverUrl`
- optional `authToken`
- timestamps (`createdAt`, `updatedAt`, `lastUsedAt`)

Connection Manager supports:

- **Desktop Switch server** presents the built-in **Local Server** separately from saved **Remote servers**. Local Server is always available in the desktop shell; selecting it calls `setDesktopMode("local")` and returns the shell to the embedded/local Fusion server without deleting remote profiles. Choosing **Local Server** or a remote profile from this in-dashboard menu navigates the renderer to the selected server's origin (the running local runtime's `baseUrl`, or the remote profile's `serverUrl`) — the same end result as switching modes from the native desktop menu (FN-7527).
- **Add remote server** is the desktop CTA for saving another Fusion server profile. The remote profile editor stays collapsed until a user chooses **Add remote server** or edits an existing saved profile, so local-only desktop users do not see an empty setup form.
- **Use** (activate a saved remote profile). In desktop local mode, using a remote profile first switches desktop mode back to `remote`, then activates the selected profile.
- **Edit** (update name/URL/token)
- **Delete**
- **Mobile Add connection / Scan QR** remains focused on remote profile setup and does not show the desktop-only Local Server guidance.

Activation updates `activeProfileId` and stamps `lastUsedAt` on the selected profile.

## Mobile packaged startup and handoff

The Android/iOS app is the dashboard bundle running in a Capacitor WebView. Before React mounts, the client entry (`packages/dashboard/app/nativeShellStartup.ts`) detects the native runtime and runs `bootstrapMobileShell` from `@fusion/mobile/bootstrap`:

- installs `window.fusionShell`, starts Android Back routing, and marks the host as `mobile-shell`
- with no saved active profile, the dashboard mounts and shows native-shell onboarding
- with a saved active profile, the WebView navigates to that server with the shell launch parameters and the profile token (`token`), and the bundled dashboard is not mounted
- choosing a server later in onboarding or the Connection Manager hands off again

Automatic handoff happens once per app session. If the server fails to load, Capacitor loads `errorPath` (the bundled app); that page, or Back from the server, stays on the bundled dashboard, whose error page offers **Manage Connection**.

Saved servers are arbitrary hosts, so `capacitor.config.ts` sets `server.allowNavigation: ["*"]`. iOS injects the plugin bridge into every page it allows, so the bootstrap opens links to any origin other than the current page or a saved server outside the WebView.

## Desktop remote handoff behavior

Desktop shell stores shell settings separately from Fusion project/global settings.

When desktop mode is `remote` and an active profile exists, `App.tsx` redirects to that profile URL and appends `token` when a token exists. `token` is the single shell → dashboard credential param used by the onboarding modal, the desktop remote switch, the desktop main process, and the mobile bootstrap handoff. For compatibility with older shell builds that wrote `?rt=<token>`, the dashboard still captures a legacy `rt` param when `token` is absent, except on `/remote-login`, where `rt` remains the server-side remote-access login token.

When desktop mode is `local` and the local server reports `ready` with a port, `App.tsx` redirects to `http://localhost:<port>`.

## Persistence model

- **Mobile shell**: connection profiles + active profile are persisted through Capacitor Preferences (`packages/mobile/src/plugins/connection-profiles.ts`).
- **Desktop shell**: shell settings are persisted in app-owned JSON at `app.getPath("userData")/shell-connections.json` (`packages/desktop/src/shell-settings.ts`).

## Security guidance

Tokenized URLs and QR payloads are secrets.

- Treat `rt`/`authToken` values like passwords.
- Do not paste tokenized links into chats, screenshots, or tickets.
- Prefer short-lived token workflows when sharing access.

For canonical token caveats and operator guidance, see [Remote Access runbook](./remote-access.md).

## Related docs

- [Dashboard Guide](./dashboard-guide.md)
- [Architecture](./architecture.md)
- [Mobile Development Guide](../MOBILE.md)
- [Remote Access runbook](./remote-access.md)
