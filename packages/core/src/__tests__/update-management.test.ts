import { describe, expect, it } from "vitest";
import {
  EXTERNALLY_MANAGED_UPDATE_MESSAGE,
  resolveExternallyManagedUpdateMessage,
  resolveUpdatesExternallyManaged,
} from "../config/update-management.js";

const nodeVersions = { node: "22.5.0" } as NodeJS.ProcessVersions;
const electronVersions = { node: "22.5.0", electron: "35.0.0" } as NodeJS.ProcessVersions;

const resolve = (value: string | undefined) =>
  resolveUpdatesExternallyManaged(value === undefined ? {} : { FUSION_UPDATES_EXTERNALLY_MANAGED: value }, nodeVersions);

describe("resolveUpdatesExternallyManaged", () => {
  it.each(["1", "true", "TRUE", " yes ", "on"])("accepts %j", (value) => {
    expect(resolve(value)).toBe(true);
  });

  it.each([undefined, "", "0", "false", "no", "off", "enabled"])("rejects %j", (value) => {
    expect(resolve(value)).toBe(false);
  });

  /*
   * C-045: the Fusion desktop app embeds the dashboard in Electron, where `npm install -g` can never
   * change the running app. Every in-app npm update surface must treat that host as externally managed,
   * whatever the environment declares.
   */
  it.each([undefined, "0", "1"])("treats an Electron host as externally managed when the declaration is %j", (value) => {
    const env = value === undefined ? {} : { FUSION_UPDATES_EXTERNALLY_MANAGED: value };
    expect(resolveUpdatesExternallyManaged(env, electronVersions)).toBe(true);
  });
});

describe("resolveExternallyManagedUpdateMessage", () => {
  it("points a desktop operator at the desktop updater instead of the environment declaration", () => {
    const message = resolveExternallyManagedUpdateMessage(electronVersions);
    expect(message).toMatch(/desktop app/i);
    expect(message).toMatch(/Check for Updates/);
    expect(message).not.toContain("FUSION_UPDATES_EXTERNALLY_MANAGED");
  });

  it("keeps the deployment declaration message outside Electron", () => {
    expect(resolveExternallyManagedUpdateMessage(nodeVersions)).toBe(
      EXTERNALLY_MANAGED_UPDATE_MESSAGE,
    );
  });
});
