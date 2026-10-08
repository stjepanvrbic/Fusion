import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync as realReadFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/*
FNXC:CliTests 2026-10-08-19:08:
KB-091: the ancestor fixtures used to walk up from the real checkout path of the scaffold module.
The GitHub Windows runner checks out at D:\a\Fusion\Fusion, which puts packages/cli/src/commands only seven levels below the drive root, so resolve(dir, "..") saturated at D:\ and the "ninth ancestor" override landed on the eighth ancestor, which the walker correctly reads (expected '^9.9.9' to be '^0.39.0').
The product walk is correct; the fixture's depth basis was not portable.
The scaffold's own readOwnCliVersion call is now redirected to the real walker started at a synthetic directory with at least nine distinct ancestors on every platform, the URL the scaffold passes is still pinned to its own module, and a precondition fails loudly if the nine ancestor paths ever collapse again.
*/
const manifestOverrides = vi.hoisted(() => new Map<string, string>());
const syntheticScaffoldModule = vi.hoisted(() => "/fn-scaffold-depth/a/b/c/d/e/f/g/h/i/commands/plugin-scaffold.ts");
const readOwnCliVersionUrls = vi.hoisted(() => [] as string[]);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync(path: Parameters<typeof actual.existsSync>[0]) {
      const pathString = String(path);
      if (manifestOverrides.has(pathString)) {
        return true;
      }
      // FNXC:CliTests 2026-10-08-14:45: KB-061 — the product builds manifest paths with resolve(), so win32 paths use backslashes; normalize before the suffix filter.
      const normalized = pathString.replace(/\\/g, "/");
      if (normalized.endsWith("/package.json") && !normalized.includes("fn-scaffold-version-")) {
        return false;
      }
      return actual.existsSync(path);
    },
    readFileSync(path: Parameters<typeof actual.readFileSync>[0], ...args: Parameters<typeof actual.readFileSync>[1][]) {
      const pathString = String(path);
      const manifest = manifestOverrides.get(pathString);
      if (manifest !== undefined) {
        return manifest;
      }
      return actual.readFileSync(path, ...args);
    },
  };
});

vi.mock("../cli-version.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cli-version.js")>();
  const { resolve: resolvePath } = await import("node:path");
  const { pathToFileURL: toFileUrl } = await import("node:url");
  const syntheticStartUrl = toFileUrl(resolvePath(syntheticScaffoldModule)).href;
  return {
    ...actual,
    readOwnCliVersion(importMetaUrl?: string) {
      readOwnCliVersionUrls.push(String(importMetaUrl));
      return actual.readOwnCliVersion(syntheticStartUrl);
    },
  };
});

import { runPluginNew } from "../commands/plugin-scaffold.js";

const scaffoldModuleDir = dirname(fileURLToPath(new URL("../commands/plugin-scaffold.ts", import.meta.url)));
const syntheticModuleDir = dirname(resolve(syntheticScaffoldModule));
const tmpBase = join(tmpdir(), `fn-scaffold-version-${Date.now()}-${Math.random().toString(36).slice(2)}`);

function ancestorManifestPath(index: number): string {
  let directory = syntheticModuleDir;
  for (let current = 0; current < index; current += 1) {
    directory = resolve(directory, "..");
  }
  return join(directory, "package.json");
}

async function scaffoldVersion(outputName: string): Promise<string> {
  const output = join(tmpBase, outputName);
  await runPluginNew("version-fixture", { output });
  const manifest = JSON.parse(realReadFileSync(join(output, "package.json"), "utf-8")) as {
    devDependencies: Record<string, string>;
  };
  return manifest.devDependencies["@runfusion/fusion"];
}

describe("plugin scaffold Fusion caret version characterization", () => {
  beforeEach(() => {
    manifestOverrides.clear();
    readOwnCliVersionUrls.length = 0;
    mkdirSync(tmpBase, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("starts from a directory with nine distinct ancestors", () => {
    const ancestors = Array.from({ length: 9 }, (_, index) => ancestorManifestPath(index));
    expect(new Set(ancestors).size).toBe(9);
  });

  it("passes the scaffold module's own import.meta.url to the shared walker", async () => {
    await scaffoldVersion("own-module-url");
    expect(readOwnCliVersionUrls.length).toBeGreaterThan(0);
    for (const url of readOwnCliVersionUrls) {
      expect(dirname(fileURLToPath(url))).toBe(scaffoldModuleDir);
    }
  });

  it("stops before the ninth ancestor and reaches the eighth", async () => {
    manifestOverrides.set(
      ancestorManifestPath(8),
      JSON.stringify({ name: "@runfusion/fusion", version: "9.9.9" }),
    );
    expect(await scaffoldVersion("ninth-ancestor")).toBe("^0.39.0");

    manifestOverrides.clear();
    manifestOverrides.set(
      ancestorManifestPath(7),
      JSON.stringify({ name: "@runfusion/fusion", version: "9.9.9" }),
    );
    expect(await scaffoldVersion("eighth-ancestor")).toBe("^9.9.9");
  });

  it("falls back when no matching Fusion manifest exists", async () => {
    manifestOverrides.set(
      ancestorManifestPath(2),
      JSON.stringify({ name: "@fusion/dashboard", version: "1.0.0" }),
    );

    const version = await scaffoldVersion("foreign-manifest");
    expect(version).toBe("^0.39.0");
    expect(version).not.toBe("^1.0.0");
  });
});
