import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stagePiClaudeCliSources } from "../plugins/pi-claude-cli-staging.js";

const packagesRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RELATIVE_SPECIFIER = /(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;

function runtimeSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") files.push(...runtimeSources(full));
    } else if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

/** jiti resolves `./x.js` and extensionless `./x` to the `./x.ts` source the extension ships. */
function resolvesInside(root: string, fromFile: string, specifier: string): boolean {
  const target = resolve(dirname(fromFile), specifier);
  if (relative(root, target).startsWith("..")) return false;
  return [target, target.replace(/\.js$/, ".ts"), `${target}.ts`].some((candidate) => existsSync(candidate));
}

/*
FNXC:WindowsProcessLaunch 2026-10-07-19:34:
The published raw pi-claude-cli extension must be self-contained: every relative import resolves inside the staged tree, including the core launch seam it re-exports in the workspace.
*/
describe("pi-claude-cli staging", () => {
  let destDir: string | undefined;
  afterEach(() => {
    if (destDir) rmSync(destDir, { recursive: true, force: true });
    destDir = undefined;
  });

  it("stages a tree whose runtime relative imports all resolve inside it", () => {
    destDir = mkdtempSync(join(tmpdir(), "fusion-pi-claude-stage-"));
    stagePiClaudeCliSources(packagesRoot, destDir);

    const unresolved: string[] = [];
    for (const file of runtimeSources(destDir)) {
      for (const [, specifier] of readFileSync(file, "utf8").matchAll(RELATIVE_SPECIFIER)) {
        if (!resolvesInside(destDir, file, specifier)) unresolved.push(`${relative(destDir, file)} -> ${specifier}`);
      }
    }
    expect(unresolved).toEqual([]);
  });

  it("ships core's working launch seam in place of the workspace re-export", async () => {
    destDir = mkdtempSync(join(tmpdir(), "fusion-pi-claude-stage-"));
    stagePiClaudeCliSources(packagesRoot, destDir);

    const staged = await import(pathToFileURL(join(destDir, "src", "windows-launch.ts")).href);
    expect(staged.resolveShellFreeLaunch("claude", ["--version"], { platform: "linux" })).toEqual({
      command: "claude",
      args: ["--version"],
    });
    expect(typeof staged.killProcessTree).toBe("function");
  });

  /*
  FNXC:WindowsProcessLaunch 2026-10-07-20:58:
  The staged seam is core's windows-launch.ts copied verbatim into a tree that cannot resolve workspace packages, so it must import Node built-ins only; core's single process-tree kill lives there and the supervisor imports from it, never the reverse.
  */
  it("ships a seam that imports Node built-ins only", () => {
    destDir = mkdtempSync(join(tmpdir(), "fusion-pi-claude-stage-"));
    stagePiClaudeCliSources(packagesRoot, destDir);

    const source = readFileSync(join(destDir, "src", "windows-launch.ts"), "utf8");
    const specifiers = [...source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]);
    const dynamic = [...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect([...specifiers, ...dynamic].filter((specifier) => !specifier.startsWith("node:"))).toEqual([]);
  });
});
