import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import vitestConfig from "../../vitest.config";

const cliRoot = join(__dirname, "..", "..");
const workspaceRoot = join(cliRoot, "..", "..");
const hiddenDistRootPrefix = ".tmp-fn-vitest-workspace-resolution-";
const hiddenDistRoot = join(workspaceRoot, `${hiddenDistRootPrefix}${process.pid}`);

const internalPackages = ["core", "engine", "dashboard"] as const;
const movedDistDirs: Array<{ from: string; to: string }> = [];

type AliasEntry = { find: string | RegExp; replacement: string };

function sourceFiles(dir: string, includeTests: boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return includeTests || entry.name !== "__tests__" ? sourceFiles(path, includeTests) : [];
    }
    if (!includeTests && /\.test\.tsx?$/.test(entry.name)) return [];
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function aliasMatches(find: string | RegExp, specifier: string) {
  return typeof find === "string" ? find === specifier : find.test(specifier);
}

function aliasEntries(): readonly AliasEntry[] {
  const aliases = vitestConfig.resolve?.alias;
  return Array.isArray(aliases) ? (aliases as readonly AliasEntry[]) : [];
}

/** The alias Vite applies to `specifier`: the first anchored pattern that matches it. */
function effectiveAlias(specifier: string): AliasEntry | undefined {
  return aliasEntries().find((entry) => entry.find instanceof RegExp && entry.find.test(specifier));
}

/*
FNXC:CliTests 2026-10-11-13:45:
Every plugin entry that dashboard server source or CLI source imports must be aliased to plugin source, because each plugin's export map points its "import" condition at `dist/`.
The set is derived from the imports themselves, never hardcoded, and the dist-absent case moves the `dist` of exactly these plugin packages aside, so a missing alias fails in a built checkout too instead of being satisfied by a stale build.
Dashboard tests are skipped because the CLI graph never loads them; CLI tests are included because they import plugin entries directly.
*/
const pluginSpecifiers: ReadonlyMap<string, string> = (() => {
  const specifiers = new Map<string, string>();
  const files = [
    ...sourceFiles(join(workspaceRoot, "packages", "dashboard", "src"), false),
    ...sourceFiles(join(cliRoot, "src"), true),
  ];
  for (const path of files) {
    for (const match of readFileSync(path, "utf8").matchAll(/["'](@fusion-plugin-examples\/([a-z0-9-]+)(?:\/[a-z0-9-]+)*)["']/g)) {
      specifiers.set(match[1], match[2]);
    }
  }
  return specifiers;
})();
const pluginShortNames = [...new Set(pluginSpecifiers.values())];

function rmSyncWithRetry(path: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EPERM" && code !== "EEXIST") {
        throw error;
      }
      if (attempt === 4) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}

function cleanupStaleHiddenDistRoots() {
  for (const entry of readdirSync(workspaceRoot)) {
    if (!entry.startsWith(hiddenDistRootPrefix)) {
      continue;
    }

    const fullPath = join(workspaceRoot, entry);
    try {
      if (!lstatSync(fullPath).isDirectory()) {
        continue;
      }
      rmSyncWithRetry(fullPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function hideDistDir(name: string, distPath: string) {
  if (!existsSync(distPath)) {
    return;
  }

  const hiddenPath = join(hiddenDistRoot, `${name}-dist`);
  if (existsSync(hiddenPath)) {
    rmSyncWithRetry(hiddenPath);
  }
  renameSync(distPath, hiddenPath);
  movedDistDirs.push({ from: distPath, to: hiddenPath });
}

function hideInternalPackageDistDirs() {
  cleanupStaleHiddenDistRoots();
  mkdirSync(hiddenDistRoot, { recursive: true });

  for (const pkg of internalPackages) {
    hideDistDir(pkg, join(workspaceRoot, "packages", pkg, "dist"));
  }

  for (const short of pluginShortNames) {
    hideDistDir(`plugin-${short}`, join(workspaceRoot, "plugins", `fusion-plugin-${short}`, "dist"));
  }
}

function restoreInternalPackageDistDirs() {
  for (let i = movedDistDirs.length - 1; i >= 0; i--) {
    const { from, to } = movedDistDirs[i];
    if (!existsSync(to)) {
      continue;
    }

    if (existsSync(from)) {
      rmSyncWithRetry(from);
    }

    renameSync(to, from);
  }
  movedDistDirs.length = 0;
  rmSyncWithRetry(hiddenDistRoot);
}

describe("vitest workspace temp dir cleanup", () => {
  it("cleans stale workspace-resolution temp dirs without touching unrelated tmp dirs", () => {
    const staleDir = join(workspaceRoot, `${hiddenDistRootPrefix}stale-test-${process.pid}-${Date.now()}`);
    const staleMarker = join(staleDir, "marker.txt");
    const unrelatedTmpDir = join(workspaceRoot, ".tmp-fn-other-marker-test");

    rmSyncWithRetry(staleDir);
    rmSyncWithRetry(unrelatedTmpDir);

    mkdirSync(staleDir, { recursive: true });
    writeFileSync(staleMarker, "stale");
    mkdirSync(unrelatedTmpDir, { recursive: true });

    cleanupStaleHiddenDistRoots();

    expect(existsSync(staleDir)).toBe(false);
    expect(existsSync(unrelatedTmpDir)).toBe(true);

    rmSyncWithRetry(unrelatedTmpDir);
  });
});

describe("CLI Vitest workspace resolution", () => {
  beforeAll(() => {
    hideInternalPackageDistDirs();
  });

  afterAll(() => {
    restoreInternalPackageDistDirs();
  });

  it("uses exact source-entry aliases for internal workspace packages", () => {
    const aliases = vitestConfig.resolve?.alias;
    expect(Array.isArray(aliases)).toBe(true);

    const normalized = (aliases ?? []).map((entry) => ({
      find: String(entry.find),
      replacement: String(entry.replacement),
    }));

    expect(normalized).toEqual(
      expect.arrayContaining([
        {
          find: String(/^@fusion\/core\/gh-cli$/),
          replacement: join(workspaceRoot, "packages", "core", "src", "gh-cli.ts"),
        },
        {
          find: String(/^@fusion\/core\/mcp-builtin-servers$/),
          replacement: join(workspaceRoot, "packages", "core", "src", "config", "mcp-builtin-servers.ts"),
        },
        {
          find: String(/^@fusion\/core\/memory-mcp$/),
          replacement: join(workspaceRoot, "packages", "core", "src", "memory", "mcp", "index.ts"),
        },
        {
          find: String(/^@fusion\/core$/),
          replacement: join(workspaceRoot, "packages", "core", "src", "index.ts"),
        },
        {
          find: String(/^@fusion\/engine$/),
          replacement: join(workspaceRoot, "packages", "engine", "src", "index.ts"),
        },
        {
          find: String(/^@fusion\/dashboard\/planning$/),
          replacement: join(workspaceRoot, "packages", "dashboard", "src", "planning.ts"),
        },
        {
          find: String(/^@fusion\/dashboard$/),
          replacement: join(workspaceRoot, "packages", "dashboard", "src", "index.ts"),
        },
        {
          find: String(/^@fusion-plugin-examples\/droid-runtime\/probe$/),
          replacement: join(workspaceRoot, "plugins", "fusion-plugin-droid-runtime", "src", "probe.ts"),
        },
        {
          find: String(/^@fusion-plugin-examples\/droid-runtime$/),
          replacement: join(workspaceRoot, "plugins", "fusion-plugin-droid-runtime", "src", "index.ts"),
        },
        ...[
          "hermes",
          "openclaw",
          "cursor",
          "grok",
          "antigravity",
          "omp",
          "paperclip",
        ].map((runtime) => ({
          find: String(new RegExp(`^@fusion-plugin-examples/${runtime}-runtime$`)),
          replacement: join(workspaceRoot, "plugins", `fusion-plugin-${runtime}-runtime`, "src", "index.ts"),
        })),
        {
          find: String(/^@fusion\/test-utils$/),
          replacement: join(workspaceRoot, "packages", "core", "src", "__test-utils__", "workspace.ts"),
        },
      ]),
    );

    /*
    FNXC:CliTests 2026-08-23-16:25:
    THIS GUARD IS ABOUT INTERNAL WORKSPACE PACKAGES, AND ONLY THEY CAN OBEY IT. The alias list also
    carries a THIRD-PARTY dedupe entry (`@earendil-works/pi-coding-agent`), added so peer-hashed pnpm
    instances collapse onto one resolved path and `vi.mock` — which is resolved-path scoped — reaches
    dashboard and engine. That package ships no source in node_modules, so its replacement is a `dist`
    entry by necessity; holding it to the source-entry rule would ban the alias that keeps the mock
    scope guard working. Scope the sweep to workspace-owned finds and pin the third-party alias
    separately, so a workspace package silently regressing to `dist` still fails here.
    */
    const internalAliases = normalized.filter((entry) => entry.find.includes("@fusion"));
    expect(internalAliases.length).toBeGreaterThan(0);
    for (const entry of internalAliases) {
      expect(
        entry.replacement.includes(`${join("packages", "")}`) ||
          entry.replacement.includes(`${join("plugins", "")}`),
      ).toBe(true);
      expect(entry.replacement).toContain(`${join("src", "")}`);
      expect(entry.replacement).not.toContain(`${join("dist", "")}`);
    }

    const piAlias = normalized.find((entry) => entry.find === String(/^@earendil-works\/pi-coding-agent$/));
    expect(piAlias?.replacement).toBe(
      join(cliRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"),
    );
    expect(normalized.filter((entry) => !entry.find.includes("@fusion"))).toEqual([piAlias]);

    const coreGhCliIndex = normalized.findIndex((entry) => entry.find === String(/^@fusion\/core\/gh-cli$/));
    const coreIndex = normalized.findIndex((entry) => entry.find === String(/^@fusion\/core$/));
    const planningIndex = normalized.findIndex((entry) => entry.find === String(/^@fusion\/dashboard\/planning$/));
    const dashboardIndex = normalized.findIndex((entry) => entry.find === String(/^@fusion\/dashboard$/));

    expect(coreGhCliIndex).toBeGreaterThanOrEqual(0);
    expect(coreIndex).toBeGreaterThan(coreGhCliIndex);
    expect(planningIndex).toBeGreaterThanOrEqual(0);
    expect(dashboardIndex).toBeGreaterThan(planningIndex);
  });

  /*
  FNXC:CliTests 2026-10-11-12:01:
  The `@fusion/core` export map points every subpath's "import" condition at `dist/`. A core subpath that CLI source imports must therefore be aliased to a source file, ahead of the `@fusion/core` root alias.
  Without the alias, a checkout with no built core fails with "Cannot find package", and a built checkout loads built code beside source `@fusion/core`.
  The scan covers every CLI source and test file so a new subpath import fails here by name, not as unrelated-looking failures in whichever test loads it first.
  */
  it("aliases every core subpath the CLI source imports, ahead of the core root alias", () => {
    const aliases = vitestConfig.resolve?.alias;
    const entries = Array.isArray(aliases) ? aliases : [];
    const coreRootIndex = entries.findIndex((entry) => String(entry.find) === String(/^@fusion\/core$/));
    expect(coreRootIndex).toBeGreaterThanOrEqual(0);

    const coreSourceRoot = join(workspaceRoot, "packages", "core", "src", "");
    const coreSubpathAliases = entries.filter((entry) =>
      String(entry.find).replaceAll("\\", "").includes("@fusion/core/"),
    );
    expect(coreSubpathAliases.length).toBeGreaterThan(0);
    for (const entry of coreSubpathAliases) {
      const pattern = String(entry.find);
      expect(entries.indexOf(entry), pattern).toBeLessThan(coreRootIndex);
      expect(entry.replacement.startsWith(coreSourceRoot), pattern).toBe(true);
      expect(existsSync(entry.replacement), pattern).toBe(true);
    }

    const importedSpecifiers = new Set<string>();
    for (const path of sourceFiles(join(cliRoot, "src"), true)) {
      for (const match of readFileSync(path, "utf8").matchAll(/["'](@fusion\/core\/[a-z0-9-]+)["']/g)) {
        importedSpecifiers.add(match[1]);
      }
    }
    expect(importedSpecifiers.size).toBeGreaterThan(0);
    for (const specifier of importedSpecifiers) {
      expect(
        coreSubpathAliases.some((entry) => aliasMatches(entry.find, specifier)),
        specifier,
      ).toBe(true);
    }
  });

  it("resolves the core subpath aliases from source when core dist is absent", async () => {
    expect(existsSync(join(workspaceRoot, "packages", "core", "dist"))).toBe(false);

    const { MemoryMcpHandler, createMemoryMcpBackends } = await import("@fusion/core/memory-mcp");
    const { buildFusionMemoryBuiltIns } = await import("@fusion/core/mcp-builtin-servers");
    const { isGhAvailable } = await import("@fusion/core/gh-cli");

    expect(typeof MemoryMcpHandler).toBe("function");
    expect(typeof createMemoryMcpBackends).toBe("function");
    expect(typeof buildFusionMemoryBuiltIns).toBe("function");
    expect(typeof isGhAvailable).toBe("function");
  });

  it("aliases every plugin entry that dashboard and CLI source import to plugin source", () => {
    expect(pluginSpecifiers.size).toBeGreaterThan(0);

    for (const [specifier, short] of pluginSpecifiers) {
      const pluginRoot = join(workspaceRoot, "plugins", `fusion-plugin-${short}`);
      const manifestPath = join(pluginRoot, "package.json");
      expect(existsSync(manifestPath), specifier).toBe(true);
      expect((JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string }).name, specifier).toBe(
        `@fusion-plugin-examples/${short}`,
      );

      const alias = effectiveAlias(specifier);
      expect(alias, `${specifier} has no source alias`).toBeDefined();
      expect(alias?.replacement.startsWith(join(pluginRoot, "src", "")), specifier).toBe(true);
      expect(existsSync(alias?.replacement ?? ""), specifier).toBe(true);
    }
  });

  it("has no plugin entry alias shadowed by an earlier entry with the same pattern", () => {
    const patterns = aliasEntries().map((entry) => String(entry.find));
    const duplicated = patterns.filter((pattern, index) => patterns.indexOf(pattern) !== index);
    expect(duplicated).toEqual([]);
  });

  it("pins the plugin entry the Claude and Antigravity runtime aliases resolve to", () => {
    expect(effectiveAlias("@fusion-plugin-examples/claude-runtime")?.replacement).toBe(
      join(workspaceRoot, "plugins", "fusion-plugin-claude-runtime", "src", "probes-entry.ts"),
    );
    expect(effectiveAlias("@fusion-plugin-examples/claude-runtime/probe")?.replacement).toBe(
      join(workspaceRoot, "plugins", "fusion-plugin-claude-runtime", "src", "probe.ts"),
    );
    expect(effectiveAlias("@fusion-plugin-examples/antigravity-runtime")?.replacement).toBe(
      join(workspaceRoot, "plugins", "fusion-plugin-antigravity-runtime", "src", "index.ts"),
    );
    expect(effectiveAlias("@fusion-plugin-examples/antigravity-runtime/probe")?.replacement).toBe(
      join(workspaceRoot, "plugins", "fusion-plugin-antigravity-runtime", "src", "probe.ts"),
    );
  });

  it("resolves non-mocked symbols from internal workspace packages and Claude runtime when dist outputs are absent", async () => {
    const [
      { tempWorkspace },
      { PRIORITY_EXECUTE },
      { createRuntimeLogger },
      { parseAgentResponse },
      { probeClaudeBinary, discoverClaudeProviderModels },
      { probeAntigravityBinary },
    ] = await Promise.all([
      import("@fusion/test-utils"),
      import("@fusion/engine"),
      import("@fusion/dashboard"),
      import("@fusion/dashboard/planning"),
      import("@fusion-plugin-examples/claude-runtime"),
      import("@fusion-plugin-examples/antigravity-runtime/probe"),
    ]);

    expect(typeof tempWorkspace).toBe("function");
    expect(typeof PRIORITY_EXECUTE).toBe("number");
    expect(typeof createRuntimeLogger).toBe("function");
    expect(typeof probeClaudeBinary).toBe("function");
    expect(typeof discoverClaudeProviderModels).toBe("function");
    expect(typeof probeAntigravityBinary).toBe("function");
    expect(parseAgentResponse('{"type":"question","data":{"id":"q","type":"confirm","question":"Ok?","description":"desc"}}')).toEqual({
      type: "question",
      data: {
        id: "q",
        type: "confirm",
        question: "Ok?",
        description: "desc",
      },
    });
  }, 30_000);
});
