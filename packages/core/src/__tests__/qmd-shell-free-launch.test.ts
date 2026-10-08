/**
 * FNXC:ProjectMemory 2026-10-08-12:38:
 * KB-072: the core memory backend's default qmd executor must launch qmd (and `bun` for installQmd) shell-free through `resolveShellFreeLaunch`.
 * On win32 an npm/bun `qmd.cmd` shim is unwrapped to `node <entry.js>`; a native `qmd.exe` runs as-is; an unrecognized batch file rejects without spawning (qmd unavailable); an absent command reaches spawn unchanged and fails with ENOENT.
 * POSIX launches are identity.
 * The win32 resolution is simulated on every platform by forcing the resolver's platform/env/fs deps, so this suite proves the Windows contract on Linux CI too.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NODE = "C:\\node\\node.exe";
const QMD_SCRIPT = "C:\\npm\\node_modules\\@tobilu\\qmd\\dist\\cli.js";
const BUN_SCRIPT = "C:\\npm\\node_modules\\bun\\bin\\bun.js";

/** npm cmd-shim body (same shape as windows-launch.test.ts) forwarding to a shim-relative target. */
function npmShim(target: string): string {
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    "IF EXIST \"%dp0%\\node.exe\" (",
    "  SET \"_prog=%dp0%\\node.exe\"",
    ") ELSE (",
    "  SET \"_prog=node\"",
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`,
    "",
  ].join("\r\n");
}

const QMD_SHIM_FILES = {
  "C:\\npm\\qmd.cmd": npmShim("node_modules\\@tobilu\\qmd\\dist\\cli.js"),
  [QMD_SCRIPT]: "",
};

function fakeFs(files: Record<string, string>) {
  const lower = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    isFile: (p: string) => lower.has(p.toLowerCase()),
    readFile: (p: string) => {
      const value = lower.get(p.toLowerCase());
      if (value === undefined) throw new Error(`ENOENT ${p}`);
      return value;
    },
  };
}

interface SpawnCall {
  command: string;
  args: string[];
  options: { shell?: unknown } & Record<string, unknown>;
}

/**
 * Load memory-backend with the launch resolver forced to `platform` over a fake filesystem, and spawn recorded.
 * Each recorded launch is replaced by a real `node -e` child that exits immediately (printing `[]` for a search), or by an unlaunchable command (ENOENT) when `enoent` is set.
 */
async function loadBackend(files: Record<string, string>, opts: { platform?: NodeJS.Platform; enoent?: boolean } = {}) {
  vi.resetModules();
  const spawnCalls: SpawnCall[] = [];
  vi.doMock("../process/windows-launch.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../process/windows-launch.js")>();
    return {
      ...actual,
      resolveShellFreeLaunch: (command: string, args: readonly string[]) =>
        actual.resolveShellFreeLaunch(command, args, {
          platform: opts.platform ?? "win32",
          env: { PATH: "C:\\npm", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
          execPath: NODE,
          isElectron: false,
          ...fakeFs(files),
        }),
    };
  });
  vi.doMock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    return {
      ...actual,
      spawn: (command: string, args: string[], options: SpawnCall["options"]) => {
        spawnCalls.push({ command, args, options });
        if (opts.enoent) {
          return actual.spawn("fusion-nonexistent-qmd-xyz", [], options);
        }
        const script = args.includes("search") ? "process.stdout.write('[]')" : "";
        return actual.spawn(process.execPath, ["-e", script], options);
      },
    };
  });
  const backend = await import("../memory/memory-backend.js");
  return { backend, spawnCalls };
}

describe("default qmd executor launches shell-free via resolveShellFreeLaunch", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.doUnmock("../process/windows-launch.js");
    vi.doUnmock("node:child_process");
    vi.unstubAllEnvs();
    vi.resetModules();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeRoot(): string {
    const rootDir = mkdtempSync(join(tmpdir(), "kb-072-qmd-root-"));
    tempDirs.push(rootDir);
    mkdirSync(join(rootDir, ".fusion", "memory"), { recursive: true });
    return rootDir;
  }

  it("win32 npm qmd.cmd shim: the availability probe runs node <cli.js> --help without a shell", async () => {
    const { backend, spawnCalls } = await loadBackend(QMD_SHIM_FILES);

    await expect(backend.isQmdAvailable()).resolves.toBe(true);

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe(NODE);
    expect(spawnCalls[0].args).toEqual([QMD_SCRIPT, "--help"]);
    expect(spawnCalls[0].options.shell).toBeFalsy();
  });

  it("win32 npm qmd.cmd shim: search, project refresh, and agent refresh all launch the unwrapped script", async () => {
    vi.stubEnv("FUSION_ENABLE_QMD_REFRESH_IN_TESTS", "1");
    const { backend, spawnCalls } = await loadBackend(QMD_SHIM_FILES);
    const rootDir = makeRoot();

    const results = await new backend.QmdMemoryBackend().search(rootDir, { query: "q", limit: 5 });
    await backend.refreshQmdProjectMemoryIndex(rootDir).catch(() => {});
    expect(Array.isArray(results)).toBe(true);

    const projectCalls = spawnCalls.map((call) => call.args.slice(1));
    expect(projectCalls.some((args) => args[0] === "collection" && args[1] === "add")).toBe(true);
    expect(projectCalls.some((args) => args[0] === "search")).toBe(true);
    expect(projectCalls.some((args) => args[0] === "update")).toBe(true);
    expect(projectCalls.some((args) => args[0] === "embed")).toBe(true);

    const projectCallCount = spawnCalls.length;
    await backend.refreshQmdAgentMemoryIndex(rootDir, "agent-x", { force: true });
    const agentCalls = spawnCalls.slice(projectCallCount).map((call) => call.args.slice(1));
    expect(agentCalls.map((args) => args[0])).toEqual(["collection", "update", "embed"]);
    expect(agentCalls[0][1]).toBe("add");

    for (const call of spawnCalls) {
      expect(call.command).toBe(NODE);
      expect(call.args[0]).toBe(QMD_SCRIPT);
      expect(call.options.shell).toBeFalsy();
    }
  });

  it("win32 native qmd.exe is launched directly with unchanged args", async () => {
    const { backend, spawnCalls } = await loadBackend({ "C:\\npm\\qmd.exe": "" });

    await expect(backend.isQmdAvailable()).resolves.toBe(true);

    expect(spawnCalls).toEqual([expect.objectContaining({ command: "C:\\npm\\qmd.exe", args: ["--help"] })]);
  });

  it("win32 unrecognized qmd.bat rejects as unavailable without spawning anything", async () => {
    const { backend, spawnCalls } = await loadBackend({ "C:\\npm\\qmd.bat": "@echo off\r\nsomething-else %*\r\n" });

    await expect(backend.isQmdAvailable()).resolves.toBe(false);

    expect(spawnCalls).toHaveLength(0);
  });

  it("win32 shim whose target is missing rejects as unavailable without spawning anything", async () => {
    const { backend, spawnCalls } = await loadBackend({ "C:\\npm\\qmd.cmd": QMD_SHIM_FILES["C:\\npm\\qmd.cmd"] });

    await expect(backend.isQmdAvailable()).resolves.toBe(false);

    expect(spawnCalls).toHaveLength(0);
  });

  it("absent qmd reaches spawn unchanged and reports unavailable via ENOENT", async () => {
    const { backend, spawnCalls } = await loadBackend({}, { enoent: true });

    await expect(backend.isQmdAvailable()).resolves.toBe(false);

    expect(spawnCalls).toEqual([expect.objectContaining({ command: "qmd", args: ["--help"] })]);
  });

  it("POSIX launches are identity", async () => {
    const { backend, spawnCalls } = await loadBackend(QMD_SHIM_FILES, { platform: "linux" });

    await expect(backend.isQmdAvailable()).resolves.toBe(true);

    expect(spawnCalls).toEqual([expect.objectContaining({ command: "qmd", args: ["--help"] })]);
  });

  it("installQmd unwraps a win32 bun.cmd shim and forwards the install args", async () => {
    const { backend, spawnCalls } = await loadBackend({
      "C:\\npm\\bun.cmd": npmShim("node_modules\\bun\\bin\\bun.js"),
      [BUN_SCRIPT]: "",
    });

    await expect(backend.installQmd()).resolves.toBe(true);

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe(NODE);
    expect(spawnCalls[0].args).toEqual([BUN_SCRIPT, "install", "-g", "@tobilu/qmd"]);
    expect(spawnCalls[0].options.shell).toBeFalsy();
  });
});
