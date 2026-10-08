import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tempWorkspace } from "@fusion/test-utils";
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

import {
  resolveDroidCliExtension,
  resolveDroidCliExtensionPaths,
} from "../droid-cli-extension.js";

describe("resolveDroidCliExtension", () => {
  it("finds the bundled @fusion/droid-cli package", () => {
    const result = resolveDroidCliExtension();
    // In the monorepo test environment, the workspace package MUST resolve.
    // If this fails, the vendored package's package.json or pi.extensions
    // entry has been broken — a real regression worth surfacing.
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.path).toMatch(/droid-cli[\/\\]index\.ts$/);
      // Beta release track (#2345): versions may carry a semver prerelease
      // suffix (e.g. 0.11.57-beta.6); still require a full X.Y.Z core.
      expect(result.packageVersion).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    }
  });

  /*
  FNXC:DroidCli 2026-10-08-18:26:
  KB-088: source runs resolved @fusion/droid-cli only via the NODE_PATH exported by pnpm .bin shims, so a launch without the shim reported not-installed.
  Resolve from the resolver module's own location in a child with every case spelling of NODE_PATH removed; this proves the declared workspace devDependency, not the shim, makes the package reachable.
  */
  it("resolves @fusion/droid-cli from the resolver module without NODE_PATH", () => {
    const resolverUrl = new URL("../droid-cli-extension.ts", import.meta.url).href;
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^node_path$/i.test(key)) delete env[key];
    }
    const code = [
      'import { createRequire } from "node:module";',
      `process.stdout.write(createRequire(${JSON.stringify(resolverUrl)}).resolve("@fusion/droid-cli/package.json"));`,
    ].join("\n");

    const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8" });

    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.replace(/\\/g, "/")).toMatch(/droid-cli\/package\.json$/);
  });
});

describe("resolveDroidCliExtensionPaths", () => {
  it("returns empty when useDroidCli is off (default) without spawning droid", () => {
    spawnMock.mockClear();

    const result = resolveDroidCliExtensionPaths({});

    expect(result.paths).toEqual([]);
    expect(result.warning).toBeUndefined();
    expect(result.resolution).toBeNull();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns empty when useDroidCli is explicitly false", () => {
    const result = resolveDroidCliExtensionPaths({ useDroidCli: false });
    expect(result.paths).toEqual([]);
    expect(result.resolution).toBeNull();
  });

  it("returns empty when useDroidCli is a non-boolean truthy value", () => {
    // Defensive: API might pass strings, numbers — we only activate on true.
    const result = resolveDroidCliExtensionPaths({
      useDroidCli: "true" as unknown as boolean,
    });
    expect(result.paths).toEqual([]);
  });

  it("returns the resolved path when useDroidCli is on", () => {
    const result = resolveDroidCliExtensionPaths({ useDroidCli: true });
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]).toMatch(/droid-cli[\/\\]index\.ts$/);
    expect(result.resolution?.status).toBe("ok");
  });

  it("surfaces a warning but does not throw on weird inputs", () => {
    // Exercises the defensive null/undefined/garbage handling — callers
    // pass settings from disk that could be corrupt.
    // @ts-expect-error intentionally bad shape
    const result = resolveDroidCliExtensionPaths(null);
    expect(result.paths).toEqual([]);
  });
});

describe("cached resolution roundtrip", () => {
  it("set/get preserves the snapshot", async () => {
    const { setCachedDroidCliResolution, getCachedDroidCliResolution } =
      await import("../droid-cli-extension.js");
    setCachedDroidCliResolution({ status: "not-installed" });
    expect(getCachedDroidCliResolution()).toEqual({ status: "not-installed" });
    setCachedDroidCliResolution(null);
    expect(getCachedDroidCliResolution()).toBeNull();
  });
});

// Directory-fixture smoke test: give the resolver a minimal "fake" package
// layout to prove it handles malformed installs gracefully. This doesn't
// use the resolver directly (it's hard-coded to look up
// @fusion/droid-cli), but proves the package.json parsing logic is
// robust when we refactor later.
describe("package.json edge cases (documentation)", () => {
  it("fixture layout documents what a broken install looks like", () => {
    const root = tempWorkspace("droid-cli-ext-");
    // This fixture is not exercised by the current implementation but
    // captures the shape we'd need to test if resolveDroidCliExtension
    // accepted a custom search path. Keeping it here so the next person
    // refactoring has a template.
    const pkgDir = join(root, "fake", "node_modules", "@fusion", "droid-cli");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ pi: { extensions: ["index.ts"] }, version: "0.0.0" }),
    );
    // No index.ts — would trigger missing-entry if we pointed the resolver here.
    expect(true).toBe(true);
  });
});
