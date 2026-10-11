import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import vitestConfig from "../../vitest.config";
import { LocalRuntimeManager } from "../local-runtime";

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

type AliasMap = Record<string, string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Alias maps of every inline project in the desktop vitest config, keyed by project name. */
function projectAliasMaps(): Map<string, AliasMap> {
  const maps = new Map<string, AliasMap>();
  const projects: unknown[] = vitestConfig.test?.projects ?? [];
  for (const [index, project] of projects.entries()) {
    if (!isRecord(project)) continue;
    const test = project.test;
    const name = isRecord(test) && typeof test.name === "string" ? test.name : `project #${index}`;
    const resolveOptions = project.resolve;
    const alias = isRecord(resolveOptions) ? resolveOptions.alias : undefined;
    if (!isRecord(alias) || !Object.values(alias).every((target) => typeof target === "string")) {
      throw new Error(`${name} has no string-keyed resolve.alias object`);
    }
    maps.set(name, alias as AliasMap);
  }
  if (maps.size === 0) throw new Error("desktop vitest config has no inline project");
  return maps;
}

/** Vite's string-alias rule: first key in order that equals the specifier or prefixes it before a `/` wins. */
function resolveAlias(aliases: AliasMap, specifier: string): string | undefined {
  for (const [key, target] of Object.entries(aliases)) {
    if (specifier === key || specifier.startsWith(`${key}/`)) return target + specifier.slice(key.length);
  }
  return undefined;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" || entry.name === "node_modules" ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) && !/\.(test\.tsx?|d\.ts)$/.test(entry.name) ? [path] : [];
  });
}

function collectMatches(dir: string, pattern: RegExp): Set<string> {
  const found = new Set<string>();
  for (const path of sourceFiles(dir)) {
    for (const match of readFileSync(path, "utf8").matchAll(pattern)) found.add(match[1]);
  }
  return found;
}

/*
FNXC:DesktopTests 2026-10-11-16:16:
A direct run of this file must pass in a checkout with nothing built.
Every plugin entry that dashboard server source imports, and every workspace package those plugin sources import, must be mapped to source in the desktop vitest config, because their export maps point at dist/.
The static cases exist because the dashboard-loading case cannot see a missing mapping once dist/ is built.
*/
const pluginSpecifiers = collectMatches(
  join(workspaceRoot, "packages", "dashboard", "src"),
  /["'](@fusion-plugin-examples\/[a-z0-9-]+(?:\/[a-z0-9-]+)*)["']/g,
);

function pluginShortName(specifier: string): string {
  return specifier.split("/")[1];
}

function pluginSourceDir(short: string): string {
  return join(workspaceRoot, "plugins", `fusion-plugin-${short}`, "src");
}

describe("desktop runtime package resolution", () => {
  it("resolves @fusion/core and @fusion/dashboard from desktop vitest project", async () => {
    const core = await import("@fusion/core");
    const dashboard = await import("@fusion/dashboard");

    expect(core.TaskStore).toBeTypeOf("function");
    expect(core.Database).toBeTypeOf("function");
    expect(core.PluginStore).toBeTypeOf("function");
    expect(dashboard.createServer).toBeTypeOf("function");
    // FN-9295: Vite transforms the full dashboard (and its plugin graph) on
    // import; 15s is too aggressive on CI runners. 30s still fails fast on
    // genuine resolution errors.
  }, 30000);

  it("can instantiate LocalRuntimeManager without relying on built dist artifacts", () => {
    const manager = new LocalRuntimeManager({ rootDir: process.cwd() });
    expect(manager.getStatus().state).toBe("stopped");
  });

  it("maps every plugin entry that dashboard server source imports to plugin source", () => {
    expect(pluginSpecifiers.size).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const [project, aliases] of projectAliasMaps()) {
      for (const specifier of pluginSpecifiers) {
        const short = pluginShortName(specifier);
        if (!existsSync(join(workspaceRoot, "plugins", `fusion-plugin-${short}`, "package.json"))) {
          offenders.push(`${project}: ${specifier} -> no plugins/fusion-plugin-${short} package`);
          continue;
        }
        const target = resolveAlias(aliases, specifier);
        if (!target?.startsWith(pluginSourceDir(short) + sep) || !existsSync(target)) {
          offenders.push(`${project}: ${specifier} -> ${target ?? "unmapped"}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("maps every workspace package that the mapped plugin sources import", () => {
    const packageNames = new Set<string>();
    for (const short of new Set([...pluginSpecifiers].map(pluginShortName))) {
      const sourceDir = pluginSourceDir(short);
      if (!existsSync(sourceDir)) continue;
      for (const name of collectMatches(sourceDir, /["'](@fusion\/[a-z0-9-]+)(?:\/[^"'\s]*)?["']/g)) {
        packageNames.add(name);
      }
    }
    expect(packageNames.size).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const [project, aliases] of projectAliasMaps()) {
      for (const name of packageNames) {
        const target = resolveAlias(aliases, name);
        if (!target?.startsWith(join(workspaceRoot, "packages") + sep) || !existsSync(target)) {
          offenders.push(`${project}: ${name} -> ${target ?? "unmapped"}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("resolves every alias key to its own existing source file", () => {
    const offenders: string[] = [];
    for (const [project, aliases] of projectAliasMaps()) {
      for (const [key, target] of Object.entries(aliases)) {
        const resolved = resolveAlias(aliases, key);
        if (resolved !== target) offenders.push(`${project}: ${key} -> ${resolved} (shadowed)`);
        else if (!existsSync(target)) offenders.push(`${project}: ${key} -> ${target} (missing)`);
        else if (target.split(/[\\/]/).includes("dist")) offenders.push(`${project}: ${key} -> ${target} (dist)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("loads the claude runtime plugin through its probes entry, as the dashboard lane does", () => {
    const expected = join(pluginSourceDir("claude-runtime"), "probes-entry.ts");
    for (const [project, aliases] of projectAliasMaps()) {
      expect(resolveAlias(aliases, "@fusion-plugin-examples/claude-runtime"), project).toBe(expected);
    }
  });
});
