import { describe, expect, it } from "vitest";
import type { WorkerGlobalState } from "vitest";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import vitestConfig from "../../vitest.config";

const cliRoot = join(__dirname, "..", "..");
const workspaceRoot = join(cliRoot, "..", "..");
const realWorkspaceRoot = realpathSync(workspaceRoot);

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
The set is derived from the imports themselves, never hardcoded.
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
/**
FNXC:CliTests 2026-10-11-14:15:
The guard must prove that workspace packages resolve from source without moving, renaming or deleting any shared build output.
Parallel test files and a concurrent package lane read the same checkout, and an owner-blind cleanup of moved output could delete what a killed or concurrent run had moved aside.
It inspects the modules this test file actually loaded through Vitest's evaluated module graph, which is reachable only through the `__vitest_worker__` global, and fails when that state is missing so a Vitest upgrade cannot turn the check into a silent pass.
Returns the absolute paths of every loaded file; builtins and virtual ids are dropped.
*/
function loadedModuleFiles(): string[] {
  const evaluated = (globalThis as { __vitest_worker__?: WorkerGlobalState }).__vitest_worker__?.evaluatedModules;
  if (!evaluated) {
    throw new Error("Vitest worker state __vitest_worker__.evaluatedModules is unavailable; cannot inspect loaded modules");
  }
  const files: string[] = [];
  for (const key of evaluated.fileToModulesMap.keys()) {
    const path = key.startsWith("file:")
      ? fileURLToPath(key)
      : key.startsWith("///")
        ? fileURLToPath(`file:${key}`)
        : key;
    if (isAbsolute(path)) files.push(resolve(path));
  }
  return files;
}

/** A loaded file inside the workspace, outside `node_modules`, under a `dist` directory. */
function isWorkspaceBuildOutput(path: string): boolean {
  const fromRoot = relative(realWorkspaceRoot, path);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) return false;
  const segments = fromRoot.split(sep).flatMap((segment) => segment.split("/"));
  return !segments.includes("node_modules") && segments.includes("dist");
}

/** Fails if any loaded module came from workspace `dist`, or if the source alias target of a specifier was not loaded. */
function expectLoadedFromSourceOnly(specifiers: readonly string[]) {
  const loaded = loadedModuleFiles();
  const buildOutput = loaded.filter(isWorkspaceBuildOutput).map((path) => relative(realWorkspaceRoot, path));
  expect(buildOutput, `modules loaded from workspace dist:\n${buildOutput.join("\n")}`).toEqual([]);

  for (const specifier of specifiers) {
    const target = effectiveAlias(specifier)?.replacement;
    expect(target, `${specifier} has no source alias`).toBeDefined();
    const realTarget = realpathSync(target ?? "");
    expect(
      loaded.some((path) => relative(realTarget, path) === ""),
      `${specifier} source entry ${target} was not loaded`,
    ).toBe(true);
  }
}

describe("CLI Vitest workspace resolution", () => {
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

  it("resolves the core subpath aliases from source, never from core dist", async () => {
    const { MemoryMcpHandler, createMemoryMcpBackends } = await import("@fusion/core/memory-mcp");
    const { buildFusionMemoryBuiltIns } = await import("@fusion/core/mcp-builtin-servers");
    const { isGhAvailable } = await import("@fusion/core/gh-cli");

    expect(typeof MemoryMcpHandler).toBe("function");
    expect(typeof createMemoryMcpBackends).toBe("function");
    expect(typeof buildFusionMemoryBuiltIns).toBe("function");
    expect(typeof isGhAvailable).toBe("function");
    expectLoadedFromSourceOnly(["@fusion/core/memory-mcp", "@fusion/core/mcp-builtin-servers", "@fusion/core/gh-cli"]);
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

  it("resolves non-mocked symbols from internal workspace packages and runtime plugins from source, never from workspace dist", async () => {
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
    expectLoadedFromSourceOnly([
      "@fusion/core",
      "@fusion/test-utils",
      "@fusion/engine",
      "@fusion/dashboard",
      "@fusion/dashboard/planning",
      "@fusion-plugin-examples/claude-runtime",
      "@fusion-plugin-examples/antigravity-runtime/probe",
    ]);
  }, 30_000);
});
