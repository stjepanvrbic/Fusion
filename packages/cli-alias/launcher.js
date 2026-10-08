// runfusion.ai — shared launcher for the alias package's bin entries.
//
// Exposes four bins: runfusion.ai, runfusion, fn, fusion. Installing this
// package globally (`npm i -g runfusion.ai`) therefore also puts `fn` and
// `fusion` on PATH, even though `@runfusion/fusion` is only a dependency
// (npm does not link dep bins globally).

/*
FNXC:CliAlias 2026-10-08-04:35:
The `runfusion.ai` and `runfusion` names default to `dashboard` when run with no arguments, on every platform; `fn` and `fusion` forward arguments verbatim (bare `fn` prints help).
The decision is encoded per bin FILE (runfusion.js vs index.js), never sniffed from `argv[1]`: npm's Windows cmd-shim runs `node <bin target>`, so `argv[1]` is the target file rather than the bin name.
npm env vars (`npm_command`, `npm_lifecycle_event`) are rejected as a signal because global-install shims run outside npm and `npx` does not record which bin was chosen.
This module has no side effects on import so the argv decision stays testable without starting the CLI.
*/

import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";

/**
 * FNXC:CliAlias 2026-10-08-04:35:
 * Pure argv decision. Appends `defaultCommand` only when one is given and no user args exist; never inspects `argv[1]`.
 * @param {string[]} argv
 * @param {{ defaultCommand?: string | null }} [options]
 * @returns {string[]}
 */
export function resolveLaunchArgv(argv, { defaultCommand = null } = {}) {
  if (typeof defaultCommand === "string" && defaultCommand.length > 0 && argv.slice(2).length === 0) {
    return [argv[0], argv[1], defaultCommand];
  }
  return [...argv];
}

/**
 * FNXC:CliAlias 2026-10-08-04:35:
 * Apply the per-entry default command, print the best-effort update notice, then hand off to the real CLI.
 * @param {{ defaultCommand?: string | null }} [options]
 */
export async function launch({ defaultCommand = null } = {}) {
  const processRef = globalThis.process;
  processRef.argv = resolveLaunchArgv(processRef.argv, { defaultCommand });
  maybeAnnounceUpdateAndRefresh();
  await import("@runfusion/fusion/dist/bin.js");
}

// ──────────────────────────────────────────────────────────────────────────
// Update notice & background refresh.
//
// Reads the existing `~/.fusion/update-check.json` cache that the dashboard
// server writes (packages/dashboard/src/update-check.ts). If a newer version
// is available, prints a one-line stderr notice. To avoid coupling the
// launcher to the dashboard bundle and to keep it fast, we never import
// dashboard code here — we just consume the cache file by its known shape.
//
// If the cache is missing or older than 24h, fires a non-blocking fetch
// against the npm registry and rewrites the cache so users who never open
// the dashboard still pick up updates eventually. Skipped in CI, when
// stderr isn't a TTY, or when FUSION_NO_UPDATE_CHECK=1 is set.
function maybeAnnounceUpdateAndRefresh() {
  try {
    if (globalThis.process.env.FUSION_NO_UPDATE_CHECK === "1") return;
    if (globalThis.process.env.CI) return;
    if (!globalThis.process.stderr.isTTY) return;

    const fusionDir = resolveFusionDir();
    const cachePath = join(fusionDir, "update-check.json");
    const currentVersion = readBundledFusionVersion();

    let cache = null;
    try {
      cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    } catch { /* missing or corrupt — treat as no cache */ }

    if (
      cache &&
      cache.updateAvailable === true &&
      typeof cache.latestVersion === "string" &&
      cache.currentVersion === currentVersion
    ) {
      const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
      const dim = (s) => `\x1b[2m${s}\x1b[0m`;
      globalThis.process.stderr.write(
        yellow(
          `\nFusion ${cache.latestVersion} is available (you have ${currentVersion}).\n`,
        ) +
          dim(`  Update: npx runfusion.ai@latest\n  Disable: FUSION_NO_UPDATE_CHECK=1\n\n`),
      );
    }

    const DAY_MS = 24 * 60 * 60 * 1000;
    const stale =
      !cache ||
      typeof cache.lastChecked !== "number" ||
      Date.now() - cache.lastChecked > DAY_MS ||
      cache.currentVersion !== currentVersion;
    if (stale && currentVersion) {
      backgroundRefresh(fusionDir, cachePath, currentVersion).catch(() => {});
    }
  } catch {
    // Update check is best-effort — never block or fail the launcher.
  }
}

function resolveFusionDir() {
  const home = globalThis.process.env.HOME || globalThis.process.env.USERPROFILE || homedir();
  const preferred = join(home, ".fusion");
  if (existsSync(preferred)) return preferred;
  const legacy = join(home, ".pi", "fusion");
  if (existsSync(legacy)) return legacy;
  return preferred;
}

function readBundledFusionVersion() {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("@runfusion/fusion/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

async function backgroundRefresh(fusionDir, cachePath, currentVersion) {
  const controller = new globalThis.AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 1500);
  try {
    const response = await globalThis.fetch("https://registry.npmjs.org/@runfusion%2Ffusion", {
      signal: controller.signal,
    });
    if (!response.ok) return;
    const payload = await response.json();
    const latestVersion = payload?.["dist-tags"]?.latest;
    if (typeof latestVersion !== "string") return;

    const result = {
      currentVersion,
      latestVersion,
      updateAvailable: isRemoteNewer(latestVersion, currentVersion),
      lastChecked: Date.now(),
    };

    try {
      mkdirSync(fusionDir, { recursive: true });
      writeFileSync(cachePath, JSON.stringify(result, null, 2), "utf-8");
    } catch { /* best-effort */ }
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function isRemoteNewer(remote, current) {
  const parse = (v) =>
    String(v)
      .split(".")
      .slice(0, 3)
      .map((p) => Number.parseInt(p, 10))
      .map((n) => (Number.isFinite(n) ? n : 0));
  const r = parse(remote);
  const c = parse(current);
  for (let i = 0; i < 3; i++) {
    if ((r[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((r[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}
