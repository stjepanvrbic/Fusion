import { afterEach, describe, expect, it, vi } from "vitest";

async function loadConfig(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value as string);
  return (await import("../../capacitor.config.js")).default;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("packaged Capacitor config", () => {
  it("keeps the WebView on an operator-chosen server and reloads the bundled app when that server fails to load", async () => {
    const config = await loadConfig({ FUSION_LIVE_RELOAD: undefined });

    expect(config.webDir).toBe("../dashboard/dist/client");
    expect(config.server?.url).toBeUndefined();
    // Saved servers are arbitrary hosts, so any host must stay in the WebView instead of opening the system browser.
    expect(config.server?.allowNavigation).toEqual(["*"]);
    expect(config.server?.errorPath).toBe("index.html");
  });

  it("still points live reload at the dev server", async () => {
    const config = await loadConfig({ FUSION_LIVE_RELOAD: "true", FUSION_SERVER_URL: "http://10.0.2.2:5173" });

    expect(config.server?.url).toBe("http://10.0.2.2:5173");
    expect(config.server?.cleartext).toBe(true);
  });
});
