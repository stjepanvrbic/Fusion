// @vitest-environment node
import { describe, expect, it } from "vitest";
import { chromiumCandidatesFor, chromiumLaunchEnv, planChromiumDiscovery, resolveChromiumExecutable } from "./chromium-executable";

const winEnv: NodeJS.ProcessEnv = {
  PROGRAMFILES: String.raw`C:\Program Files`,
  "PROGRAMFILES(X86)": String.raw`C:\Program Files (x86)`,
  LOCALAPPDATA: String.raw`C:\Users\ci\AppData\Local`,
};
const chromePf = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const chromeX86 = String.raw`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`;
const chromeLocal = String.raw`C:\Users\ci\AppData\Local\Google\Chrome\Application\chrome.exe`;
const edgeX86 = String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`;
const edgePf = String.raw`C:\Program Files\Microsoft\Edge\Application\msedge.exe`;

const onlyExists = (...paths: string[]) => (candidate: string) => paths.includes(candidate);

describe("chromiumCandidatesFor", () => {
  it("lists win32 Chrome and Edge locations in probe order", () => {
    expect(chromiumCandidatesFor("win32", winEnv)).toEqual([chromePf, chromeX86, chromeLocal, edgeX86, edgePf]);
  });

  it("defaults win32 Program Files roots and omits LocalAppData when unset", () => {
    expect(chromiumCandidatesFor("win32", {})).toEqual([chromePf, chromeX86, edgeX86, edgePf]);
  });

  it("keeps the darwin and linux lists unchanged", () => {
    expect(chromiumCandidatesFor("darwin", {})).toEqual([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]);
    const linux = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
    expect(chromiumCandidatesFor("linux", {})).toEqual(linux);
    expect(chromiumCandidatesFor("freebsd", {})).toEqual(linux);
  });
});

describe("resolveChromiumExecutable", () => {
  it.each([chromePf, edgeX86, chromeLocal])("resolves the win32 browser at %s", (installed) => {
    expect(resolveChromiumExecutable({ platform: "win32", env: winEnv, exists: onlyExists(installed) })).toBe(installed);
  });

  it("prefers an existing FUSION_BROWSER_SMOKE_BROWSER over CHROME_BIN and candidates", () => {
    const env = { ...winEnv, FUSION_BROWSER_SMOKE_BROWSER: "override.exe", CHROME_BIN: "chrome-bin.exe" };
    expect(resolveChromiumExecutable({ platform: "win32", env, exists: onlyExists("override.exe", "chrome-bin.exe", chromePf) })).toBe("override.exe");
  });

  it("falls through a missing override to CHROME_BIN, then candidates", () => {
    const env = { ...winEnv, FUSION_BROWSER_SMOKE_BROWSER: "missing.exe", CHROME_BIN: "chrome-bin.exe" };
    expect(resolveChromiumExecutable({ platform: "win32", env, exists: onlyExists("chrome-bin.exe", chromePf) })).toBe("chrome-bin.exe");
    expect(resolveChromiumExecutable({ platform: "win32", env, exists: onlyExists(edgePf) })).toBe(edgePf);
  });

  it("ignores an empty CHROME_BIN", () => {
    const probed: string[] = [];
    const exists = (candidate: string) => {
      probed.push(candidate);
      return false;
    };
    expect(resolveChromiumExecutable({ platform: "linux", env: { CHROME_BIN: "" }, exists })).toBeUndefined();
    expect(probed).not.toContain("");
  });

  it("returns undefined when nothing exists", () => {
    expect(resolveChromiumExecutable({ platform: "win32", env: winEnv, exists: () => false })).toBeUndefined();
  });
});

describe("chromiumLaunchEnv", () => {
  it("restores the real profile directory for the win32 browser child only", () => {
    const env = { USERPROFILE: String.raw`C:\tmp\fake-home`, PATH: "p" };
    expect(chromiumLaunchEnv("win32", env, () => String.raw`C:\Users\ci`)).toEqual({ USERPROFILE: String.raw`C:\Users\ci`, PATH: "p" });
    expect(env.USERPROFILE).toBe(String.raw`C:\tmp\fake-home`);
    expect(chromiumLaunchEnv("linux", env, () => "/home/ci")).toBeUndefined();
    expect(chromiumLaunchEnv("darwin", env, () => "/Users/ci")).toBeUndefined();
  });

  it("never reads the profile directory off win32, where the lookup can throw", () => {
    const unavailable = () => {
      throw new Error("no passwd entry for this uid");
    };
    expect(chromiumLaunchEnv("linux", {}, unavailable)).toBeUndefined();
    expect(chromiumLaunchEnv("darwin", {}, unavailable)).toBeUndefined();
  });
});

describe("planChromiumDiscovery", () => {
  it("runs when an executable was found", () => {
    expect(planChromiumDiscovery({ executablePath: chromePf, env: { CI: "1" }, platform: "win32" })).toEqual({ kind: "run", executablePath: chromePf });
  });

  it.each([{}, { FUSION_BROWSER_SMOKE_REQUIRE: "0" }])("skips when missing and not required (%o)", (env) => {
    expect(planChromiumDiscovery({ executablePath: undefined, env, platform: "linux" })).toEqual({ kind: "skip" });
  });

  it.each([{ CI: "1" }, { FUSION_BROWSER_SMOKE_REQUIRE: "1" }])("fails when missing and required (%o)", (env) => {
    expect(planChromiumDiscovery({ executablePath: undefined, env, platform: "linux" }).kind).toBe("fail");
  });

  it("names the win32 candidates and overrides in the failure message without throwing", () => {
    const env = { ...winEnv, CI: "true" };
    expect(() => planChromiumDiscovery({ executablePath: undefined, env, platform: "win32" })).not.toThrow();
    const plan = planChromiumDiscovery({ executablePath: undefined, env, platform: "win32" });
    if (plan.kind !== "fail") throw new Error(`expected fail plan, got ${plan.kind}`);
    expect(plan.message).toContain("[task-modal-touch-resize]");
    expect(plan.message).toContain("win32");
    expect(plan.message).toContain("chrome.exe");
    expect(plan.message).toContain("msedge.exe");
    expect(plan.message).toContain("FUSION_BROWSER_SMOKE_BROWSER");
    expect(plan.message).toContain("CHROME_BIN");
  });
});
