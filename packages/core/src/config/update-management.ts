/*
FNXC:UpdateManagement 2026-08-21-16:37:
A packaged or pinned deployment needs an install-level declaration that updates are externally owned.
`updateCheckEnabled` is per-user and must otherwise be flipped on every host, while a successful
in-app update could silently replace an artifact owned by the staged release pipeline.
*/

export const EXTERNALLY_MANAGED_UPDATES_ENV = "FUSION_UPDATES_EXTERNALLY_MANAGED";

export const EXTERNALLY_MANAGED_UPDATE_MESSAGE =
  "This Fusion install declares updates externally managed via FUSION_UPDATES_EXTERNALLY_MANAGED. " +
  "The in-app updater is intentionally disabled so a self-update cannot bypass this deployment's release process. " +
  "Update this install the way it was deployed.";

export const DESKTOP_APP_UPDATE_MESSAGE =
  "This is the Fusion desktop app, which updates through its built-in updater (Fusion menu → Check for Updates…). " +
  "The in-app npm updater is disabled here because a global npm install cannot change the desktop app.";

const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);

/*
FNXC:UpdateManagement 2026-10-07-18:02:
The desktop app embeds the dashboard in Electron, and electron-updater owns its updates.
`npm install -g` there updated a separate global CLI and restarted the desktop into the same bundled version, so with autoUpdateAndRestart on it reinstalled and restarted on every boot, killing engines each time.
An Electron host is therefore always externally managed. Detection reads the running process, not an environment variable, so shells and CLIs spawned from the desktop keep their own update behavior.
*/
function isElectronHost(versions: NodeJS.ProcessVersions): boolean {
  return typeof (versions as NodeJS.ProcessVersions & { electron?: string }).electron === "string";
}

/** Resolves whether in-app npm updates are owned elsewhere: a deployment declaration or the Electron desktop host. */
export function resolveUpdatesExternallyManaged(
  env: NodeJS.ProcessEnv = process.env,
  versions: NodeJS.ProcessVersions = process.versions,
): boolean {
  if (isElectronHost(versions)) return true;
  const value = env[EXTERNALLY_MANAGED_UPDATES_ENV];
  return typeof value === "string" && TRUTHY_VALUES.has(value.trim().toLowerCase());
}

/** Operator guidance for a host whose updates are externally managed. */
export function resolveExternallyManagedUpdateMessage(versions: NodeJS.ProcessVersions = process.versions): string {
  return isElectronHost(versions) ? DESKTOP_APP_UPDATE_MESSAGE : EXTERNALLY_MANAGED_UPDATE_MESSAGE;
}
