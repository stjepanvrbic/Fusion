import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vitestConfig from "../../vitest.config";

function dashboardServerSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : dashboardServerSourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("FN-3298 regression: dashboard vitest runtime plugins resolve from source", () => {
  it("aliases hermes/openclaw/paperclip runtime plugin imports to src entrypoints", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const vitestConfigPath = join(testDir, "..", "..", "vitest.config.ts");
    const config = readFileSync(vitestConfigPath, "utf8");

    expect(config).toContain('"@fusion-plugin-examples/hermes-runtime": resolve(');
    expect(config).toContain('"../../plugins/fusion-plugin-hermes-runtime/src/index.ts"');

    expect(config).toContain('"@fusion-plugin-examples/openclaw-runtime": resolve(');
    expect(config).toContain('"../../plugins/fusion-plugin-openclaw-runtime/src/index.ts"');

    expect(config).toContain('"@fusion-plugin-examples/paperclip-runtime": resolve(');
    expect(config).toContain('"../../plugins/fusion-plugin-paperclip-runtime/src/index.ts"');

    expect(config).not.toContain('fusion-plugin-hermes-runtime/dist/index.js');
    expect(config).not.toContain('fusion-plugin-openclaw-runtime/dist/index.js');
    expect(config).not.toContain('fusion-plugin-paperclip-runtime/dist/index.js');
  });

  // FN-3888/FN-6111 regression: bundled dashboard views must not depend on
  // plugins/*/dist/, which goes stale when plugin source is edited without a
  // manual rebuild and surfaces in the UI as "Bundled plugin view unavailable".
  it("aliases bundled dashboard view plugin imports to src in vite and vitest configs", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const dashboardDir = join(testDir, "..", "..");

    for (const configFile of ["vite.config.ts", "vitest.config.ts"]) {
      const config = readFileSync(join(dashboardDir, configFile), "utf8");
      expect(
        config,
        `${configFile} must alias the dependency-graph dashboard-view to src`,
      ).toContain('"@fusion-plugin-examples/dependency-graph/dashboard-view": resolve(');
      expect(config).toContain(
        '"../../plugins/fusion-plugin-dependency-graph/src/dashboard-view.tsx"',
      );
      expect(config).not.toContain("fusion-plugin-dependency-graph/dist/");
      expect(
        config,
        `${configFile} must alias the compound-engineering dashboard-view to src`,
      ).toContain('"@fusion-plugin-examples/compound-engineering/dashboard-view": resolve(');
      expect(config).toContain(
        '"../../plugins/fusion-plugin-compound-engineering/src/dashboard-view.tsx"',
      );
      expect(config).toContain('"@fusion-plugin-examples/compound-engineering": resolve(');
      expect(config).toContain(
        '"../../plugins/fusion-plugin-compound-engineering/src/index.ts"',
      );
      expect(config).not.toContain("fusion-plugin-compound-engineering/dist/");
      expect(
        config,
        `${configFile} must alias the linear-import dashboard-view to src`,
      ).toContain('"@fusion-plugin-examples/linear-import/dashboard-view": resolve(');
      expect(config).toContain(
        '"../../plugins/fusion-plugin-linear-import/src/dashboard-view.tsx"',
      );
      expect(config).toContain('"@fusion-plugin-examples/linear-import": resolve(');
      expect(config).toContain(
        '"../../plugins/fusion-plugin-linear-import/src/index.ts"',
      );
      expect(config).not.toContain("fusion-plugin-linear-import/dist/");
    }
  });

  /*
  FNXC:DashboardTests 2026-10-11-13:58:
  Every plugin entry that dashboard server source imports must have a source alias, because each plugin's export map points its "import" condition at dist/, which a fresh checkout does not have.
  String aliases match by prefix, so only a key exactly equal to the specifier is a correct mapping; the set is derived from the imports so a new plugin import fails here by name.
  */
  it("aliases every plugin entry that dashboard server source imports to plugin source", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const dashboardSrc = join(testDir, "..");
    const workspaceRoot = join(dashboardSrc, "..", "..", "..");
    const aliases = vitestConfig.resolve?.alias;
    const aliasMap: Record<string, string> =
      aliases && !Array.isArray(aliases) ? (aliases as Record<string, string>) : {};

    const specifiers = new Map<string, string>();
    for (const path of dashboardServerSourceFiles(dashboardSrc)) {
      for (const match of readFileSync(path, "utf8").matchAll(/["'](@fusion-plugin-examples\/([a-z0-9-]+)(?:\/[a-z0-9-]+)*)["']/g)) {
        specifiers.set(match[1], match[2]);
      }
    }
    expect(specifiers.size).toBeGreaterThan(0);

    for (const [specifier, short] of specifiers) {
      const target = aliasMap[specifier];
      expect(target, `${specifier} has no exact source alias`).toBeDefined();
      expect(
        target?.startsWith(join(workspaceRoot, "plugins", `fusion-plugin-${short}`, "src", "")),
        specifier,
      ).toBe(true);
      expect(existsSync(target ?? ""), specifier).toBe(true);
    }
  });
});
