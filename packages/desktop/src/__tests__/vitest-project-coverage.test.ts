/**
 * FNXC:DesktopTests 2026-10-11-13:29:
 * Every desktop test file must match the include of a desktop Vitest project, because the Vitest projects are the only lane that runs desktop tests.
 * A file outside every include runs nowhere, while `listPackageTestFiles` in `scripts/ci-test-shard.mjs` still counts it toward desktop's shard weight, so the gap stays invisible.
 * The project includes are read from `vitest.config.ts` itself, so this guard and Vitest share one source of truth.
 */
import { globSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import desktopVitestConfig from "../../vitest.config";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEST_FILE_GLOB = "**/*.test.{ts,tsx,mts,cts,js,mjs}";
const PRUNED_SEGMENTS = new Set(["node_modules", "dist", "dist-electron", "deploy", ".timings"]);

interface ProjectGlobs {
  name: string;
  include: string[];
  exclude: string[];
}

function toForwardSlashes(filePath: string): string {
  return filePath.split(sep).join("/");
}

function isPruned(filePath: string): boolean {
  return filePath.split(/[\\/]/).some((segment) => PRUNED_SEGMENTS.has(segment));
}

function expand(patterns: readonly string[]): Set<string> {
  return new Set(
    patterns.flatMap((pattern) =>
      globSync(pattern, { cwd: desktopRoot, exclude: isPruned }).map(toForwardSlashes),
    ),
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function readProjectGlobs(): ProjectGlobs[] {
  const projects: unknown = desktopVitestConfig.test?.projects;
  if (!Array.isArray(projects) || projects.length === 0) {
    throw new Error("desktop vitest.config.ts must declare a non-empty test.projects array");
  }
  return projects.map((project, index) => {
    const test = (project as { test?: { name?: unknown; include?: unknown; exclude?: unknown } } | null)?.test;
    if (typeof project !== "object" || project === null || !test) {
      throw new Error(`desktop Vitest project #${index} must be an inline config object with a test block`);
    }
    const name = typeof test.name === "string" ? test.name : `#${index}`;
    if (!isStringArray(test.include) || test.include.length === 0) {
      throw new Error(`desktop Vitest project ${name} must declare a non-empty test.include array`);
    }
    if (test.exclude !== undefined && !isStringArray(test.exclude)) {
      throw new Error(`desktop Vitest project ${name} has a non-array test.exclude`);
    }
    return { name, include: test.include, exclude: test.exclude ?? [] };
  });
}

function filesMatchedByProjects(): Set<string> {
  const matched = new Set<string>();
  for (const project of readProjectGlobs()) {
    const excluded = expand(project.exclude);
    for (const file of expand(project.include)) {
      if (!excluded.has(file)) matched.add(file);
    }
  }
  return matched;
}

describe("desktop Vitest project coverage", () => {
  it("matches every desktop test file with a project include", () => {
    const matched = filesMatchedByProjects();
    const unmatched = [...expand([TEST_FILE_GLOB])].filter((file) => !matched.has(file)).sort();
    expect(unmatched).toEqual([]);
  });

  it("expands the project includes to real test files in each test root", () => {
    const matched = [...filesMatchedByProjects()];
    expect(matched).toContain("scripts/__tests__/test-args.test.ts");
    expect(matched.some((file) => file.startsWith("src/__tests__/"))).toBe(true);
    expect(matched.some((file) => file.startsWith("src/renderer/"))).toBe(true);
  });
});
