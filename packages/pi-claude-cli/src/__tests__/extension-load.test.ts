import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const claudeCliEntry = join(packageRoot, "index.ts");
const droidCliEntry = resolve(packageRoot, "../droid-cli/index.ts");

/*
 * FNXC:ExtensionLoading 2026-10-10-17:40:
 * The engine hands the vendored extension entries to Pi's `discoverAndLoadExtensions`, which transpiles them with jiti under Pi's alias table.
 * Unit tests that import `index.ts` through vitest never exercise that resolver, so a pi-ai subpath import broke the Claude CLI provider in production while every unit test stayed green.
 */
describe("vendored extensions load through Pi's extension loader", () => {
  it("loads pi-claude-cli and registers its provider", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "fn-pi-ext-load-"));
    try {
      const result = await discoverAndLoadExtensions(
        [claudeCliEntry, droidCliEntry],
        packageRoot,
        agentDir,
      );

      const subpathFailures = result.errors.filter(({ error }) => error.includes("compat.js/"));
      expect(subpathFailures).toEqual([]);
      expect(result.errors.map(({ path }) => path)).not.toContain(claudeCliEntry);
      const registered = result.runtime.pendingProviderRegistrations.map(({ name }) => name);
      expect(registered).toContain("pi-claude-cli");
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  }, 30_000);
});
