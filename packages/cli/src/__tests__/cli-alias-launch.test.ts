/*
FNXC:CliAlias 2026-10-08-04:35:
KB-030 regression: npm's Windows cmd-shim runs `node <pkg>\<bin target>`, so the alias package must encode the
"no args → dashboard" default in the runfusion.ai/runfusion bin target itself rather than sniffing argv[1].
These tests spawn each bin target exactly as the shim does and assert the forwarded argv.
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const workspaceRoot = join(__dirname, "..", "..", "..", "..");
const aliasDir = join(workspaceRoot, "packages", "cli-alias");

type AliasManifest = { bin: Record<string, string>; files: string[] };

function readAliasManifest(dir: string): AliasManifest {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as AliasManifest;
}

type ResolveLaunchArgv = (argv: string[], options?: { defaultCommand?: string | null }) => string[];

describe("runfusion.ai alias launcher", () => {
  describe("resolveLaunchArgv", () => {
    let resolveLaunchArgv: ResolveLaunchArgv;
    const winShimPath = "C:\\x\\node_modules\\runfusion.ai\\index.js";

    beforeAll(async () => {
      const mod = (await import(pathToFileURL(join(aliasDir, "launcher.js")).href)) as {
        resolveLaunchArgv: ResolveLaunchArgv;
      };
      resolveLaunchArgv = mod.resolveLaunchArgv;
    });

    it("appends the default command regardless of the argv[1] basename (Windows shim shape)", () => {
      expect(resolveLaunchArgv(["node", winShimPath], { defaultCommand: "dashboard" })).toEqual([
        "node",
        winShimPath,
        "dashboard",
      ]);
    });

    it("leaves argv unchanged without a default command", () => {
      expect(resolveLaunchArgv(["node", winShimPath], { defaultCommand: null })).toEqual(["node", winShimPath]);
      expect(resolveLaunchArgv(["node", winShimPath])).toEqual(["node", winShimPath]);
    });

    it("forwards user args verbatim", () => {
      expect(resolveLaunchArgv(["node", winShimPath, "--help"], { defaultCommand: "dashboard" })).toEqual([
        "node",
        winShimPath,
        "--help",
      ]);
      expect(
        resolveLaunchArgv(["node", winShimPath, "task", "create", "x"], { defaultCommand: "dashboard" }),
      ).toEqual(["node", winShimPath, "task", "create", "x"]);
    });

    it("tolerates an undefined argv[1]", () => {
      const result = resolveLaunchArgv(["node"], { defaultCommand: "dashboard" });
      expect(result[2]).toBe("dashboard");
    });
  });

  describe("manifest contract", () => {
    const manifest = readAliasManifest(aliasDir);

    it("gives the alias names their own entry and keeps fn/fusion on index.js", () => {
      expect(manifest.bin["runfusion.ai"]).toBe(manifest.bin.runfusion);
      expect(manifest.bin.fn).toBe("index.js");
      expect(manifest.bin.fusion).toBe("index.js");
      expect(manifest.bin["runfusion.ai"]).not.toBe("index.js");
    });

    it("publishes every bin target plus the shared launcher", () => {
      for (const target of new Set([...Object.values(manifest.bin), "launcher.js"])) {
        expect(manifest.files).toContain(target);
      }
    });
  });

  describe("shim-shape subprocess launch", () => {
    let tmp: string;
    let manifest: AliasManifest;

    beforeAll(() => {
      tmp = mkdtempSync(join(tmpdir(), "fusion-cli-alias-"));
      for (const file of ["index.js", "launcher.js", "runfusion.js", "package.json"]) {
        copyFileSync(join(aliasDir, file), join(tmp, file));
      }
      const stubDir = join(tmp, "node_modules", "@runfusion", "fusion");
      mkdirSync(join(stubDir, "dist"), { recursive: true });
      writeFileSync(
        join(stubDir, "package.json"),
        JSON.stringify({ name: "@runfusion/fusion", version: "0.0.0", type: "module" }),
      );
      writeFileSync(join(stubDir, "dist", "bin.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
      manifest = readAliasManifest(tmp);
    });

    afterAll(() => {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    });

    // Mirrors npm's cmd-shim: `node "<pkg dir>\<bin target>" %*`.
    function runTarget(target: string, args: string[] = []): unknown {
      const result = spawnSync(process.execPath, [join(tmp, target), ...args], {
        env: { ...process.env, FUSION_NO_UPDATE_CHECK: "1" },
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    }

    it.each(["runfusion.ai", "runfusion"])("%s with no args launches the dashboard", (name) => {
      expect(runTarget(manifest.bin[name])).toEqual(["dashboard"]);
    });

    it.each(["fn", "fusion"])("%s with no args forwards nothing (prints help)", (name) => {
      expect(runTarget(manifest.bin[name])).toEqual([]);
    });

    it("runfusion.ai forwards explicit args verbatim", () => {
      expect(runTarget(manifest.bin["runfusion.ai"], ["--help"])).toEqual(["--help"]);
    });

    it("index.js injects nothing, so the alias names must not target it", () => {
      expect(runTarget("index.js")).toEqual([]);
    });
  });
});
