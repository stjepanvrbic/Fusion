import path from "node:path";

/**
 * FNXC:WindowsTestPortability 2026-10-08-19:36:
 * KB-096: the dashboard touch-resize browser spec only probed macOS and Linux paths, so on win32 discovery always missed and,
 * under CI, the module threw at load (breaking even collection-only `vitest list`).
 * Discovery is a pure, injectable helper so every platform branch is unit-testable on any host.
 * win32 probes Chrome (Program Files, Program Files (x86), per-user LocalAppData) and Edge (Chromium-based), mirroring
 * `findBrowserExecutable` in scripts/browser-layout-smoke.mjs; paths use path.win32 so output is deterministic off-Windows.
 * A required-but-missing browser is a planned `fail` outcome (reported by an in-suite test), never a throw, so
 * FN-8806's "never green without Chromium" contract holds while collection always succeeds.
 */

const DEFAULT_PROGRAM_FILES = "C:\\Program Files";
const DEFAULT_PROGRAM_FILES_X86 = "C:\\Program Files (x86)";

/** Known Chromium-family executable locations for a platform, in probe order. */
export function chromiumCandidatesFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === "darwin") {
    return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"];
  }
  if (platform === "win32") {
    const programFiles = env.PROGRAMFILES || DEFAULT_PROGRAM_FILES;
    const programFilesX86 = env["PROGRAMFILES(X86)"] || DEFAULT_PROGRAM_FILES_X86;
    const chromeSuffix = path.win32.join("Google", "Chrome", "Application", "chrome.exe");
    const edgeSuffix = path.win32.join("Microsoft", "Edge", "Application", "msedge.exe");
    return [
      path.win32.join(programFiles, chromeSuffix),
      path.win32.join(programFilesX86, chromeSuffix),
      ...(env.LOCALAPPDATA ? [path.win32.join(env.LOCALAPPDATA, chromeSuffix)] : []),
      path.win32.join(programFilesX86, edgeSuffix),
      path.win32.join(programFiles, edgeSuffix),
    ];
  }
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
}

export interface ResolveChromiumOptions {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists: (candidate: string) => boolean;
}

/** First existing executable: FUSION_BROWSER_SMOKE_BROWSER, then CHROME_BIN, then platform candidates. */
export function resolveChromiumExecutable({ platform, env, exists }: ResolveChromiumOptions): string | undefined {
  const ordered = [env.FUSION_BROWSER_SMOKE_BROWSER, env.CHROME_BIN, ...chromiumCandidatesFor(platform, env)];
  return ordered.find((candidate): candidate is string => Boolean(candidate) && exists(candidate as string));
}

/**
 * FNXC:WindowsTestPortability 2026-10-08-19:36:
 * KB-096: the shared vitest setup redirects USERPROFILE to a throwaway test home. On win32, branded Chrome (154 observed) then
 * refuses Playwright's --remote-debugging-pipe with "DevTools remote debugging requires a non-default data directory" even
 * though --user-data-dir is passed, and exits before the lane runs (Edge is unaffected).
 * The browser child gets the real OS profile directory back; the test process itself stays redirected.
 * Returns undefined off-win32 so Playwright keeps inheriting the environment unchanged there.
 *
 * FNXC:WindowsTestPortability 2026-10-10-20:42:
 * KB-096: the profile directory is read lazily, on win32 only. The spec supplies os.userInfo().homedir, which throws on POSIX hosts
 * whose uid has no passwd entry (containers started with an arbitrary uid), and the darwin/linux launch path must stay unchanged.
 */
export function chromiumLaunchEnv(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, realProfileDir: () => string): NodeJS.ProcessEnv | undefined {
  if (platform !== "win32") return undefined;
  return { ...env, USERPROFILE: realProfileDir() };
}

export type ChromiumDiscoveryPlan =
  | { kind: "run"; executablePath: string }
  | { kind: "skip" }
  | { kind: "fail"; message: string };

export interface PlanChromiumDiscoveryOptions {
  executablePath: string | undefined;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

/**
 * Decide how the browser lane proceeds. Required (CI or FUSION_BROWSER_SMOKE_REQUIRE=1) with no browser yields `fail`
 * with an actionable message; a bare local run self-gates via `skip`. Never throws.
 */
export function planChromiumDiscovery({ executablePath, env, platform }: PlanChromiumDiscoveryOptions): ChromiumDiscoveryPlan {
  if (executablePath) return { kind: "run", executablePath };
  const required = Boolean(env.CI) || env.FUSION_BROWSER_SMOKE_REQUIRE === "1";
  if (!required) return { kind: "skip" };
  const probed = chromiumCandidatesFor(platform, env).join(", ");
  return {
    kind: "fail",
    message:
      `[task-modal-touch-resize] Chromium is required for task-title stability coverage but none was found on ${platform}. `
      + `Probed: ${probed}. Set FUSION_BROWSER_SMOKE_BROWSER or CHROME_BIN to a Chromium-based browser executable.`,
  };
}
