/**
 * FNXC:AgentMemory 2026-10-11-00:59:
 * The engine's agent-memory qmd index refresh and search must launch qmd through core's shared shell-free executor.
 * On win32 an npm/bun `qmd.cmd` shim must be reached (unwrapped to `node <cli.js>`), a native `qmd.exe` runs as-is, and a command only a shell could run falls back to agent file search without spawning.
 * Every launch is unref'd so a fire-and-forget refresh never holds a short-lived caller open.
 * The win32 resolution is simulated on every platform by forcing the resolver's platform/env/fs deps and replacing `spawn`; no real process is started.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildQmdAgentMemoryCollectionAddArgs,
  buildQmdAgentMemorySearchArgs,
  createMemoryAppendTool,
  createMemorySearchTool,
  qmdAgentMemoryCollectionName,
} from "../agent-tools.js";

const NODE = "C:\\node\\node.exe";
const QMD_EXE = "C:\\npm\\qmd.exe";
const QMD_SCRIPT = "C:\\npm\\node_modules\\@tobilu\\qmd\\dist\\cli.js";
const AGENT_ID = "agent-x";
const QUERY = "needle";

/** npm cmd-shim body forwarding to a shim-relative target (same shape as core's qmd-shell-free-launch.test.ts). */
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

const QMD_SHIM_FILES: Record<string, string> = {
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

interface FakeStream extends EventEmitter {
  unref: ReturnType<typeof vi.fn>;
}

interface FakeChild extends EventEmitter {
  stdout: FakeStream;
  stderr: FakeStream;
  stdin: null;
  unref: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  closed: boolean;
}

interface Launch {
  command: string;
  args: string[];
  options: { cwd?: string; shell?: unknown } & Record<string, unknown>;
  child: FakeChild;
}

const state = vi.hoisted(() => ({
  platform: "win32" as NodeJS.Platform,
  files: {} as Record<string, string>,
  absent: false,
  agentCollection: "",
  agentAddExists: false,
  launches: [] as Array<{
    command: string;
    args: string[];
    options: Record<string, unknown>;
    child: unknown;
  }>,
}));

vi.mock("../../../core/src/process/windows-launch.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../core/src/process/windows-launch.ts")>();
  return {
    ...actual,
    resolveShellFreeLaunch: (command: string, args: readonly string[], deps?: Parameters<typeof actual.resolveShellFreeLaunch>[2]) =>
      command === "qmd"
        ? actual.resolveShellFreeLaunch(command, args, {
            platform: state.platform,
            env: { PATH: "C:\\npm", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
            execPath: NODE,
            isElectron: false,
            ...fakeFs(state.files),
          })
        : actual.resolveShellFreeLaunch(command, args, deps),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter: Emitter } = await import("node:events");
  const qmdCommands = new Set(["C:\\node\\node.exe", "qmd", "C:\\npm\\qmd.exe"]);

  const makeStream = () => Object.assign(new Emitter(), { unref: vi.fn() });

  return {
    ...actual,
    spawn: (command: string, args: string[], options: Record<string, unknown>) => {
      if (!qmdCommands.has(command)) {
        return (actual.spawn as (...a: unknown[]) => unknown)(command, args, options);
      }
      const child = Object.assign(new Emitter(), {
        stdout: makeStream(),
        stderr: makeStream(),
        stdin: null,
        unref: vi.fn(),
        kill: vi.fn(),
        closed: false,
      });
      state.launches.push({ command, args, options, child });

      const qmdArgs = command === "C:\\node\\node.exe" ? args.slice(1) : args;
      const isAgentCollection = qmdArgs.includes(state.agentCollection);
      setImmediate(() => {
        child.closed = true;
        if (state.absent) {
          child.emit("error", Object.assign(new Error("spawn qmd ENOENT"), { code: "ENOENT" }));
          return;
        }
        if (qmdArgs[0] === "search") {
          child.stdout.emit("data", Buffer.from(isAgentCollection ? '[{"path":"MEMORY.md","snippet":"needle fact about deployments","score":1}]' : "[]"));
        }
        if (qmdArgs[0] === "collection" && isAgentCollection && state.agentAddExists) {
          child.stderr.emit("data", Buffer.from("collection already exists"));
          child.emit("close", 1, null);
          return;
        }
        child.emit("close", 0, null);
      });
      return child;
    },
  };
});

describe("engine agent-memory qmd launches go through core's shell-free executor", () => {
  const tempDirs: string[] = [];
  const settings = { memoryBackendType: "qmd" };

  beforeEach(() => {
    vi.stubEnv("FUSION_ENABLE_QMD_REFRESH_IN_TESTS", "1");
    state.platform = "win32";
    state.files = QMD_SHIM_FILES;
    state.absent = false;
    state.agentCollection = "";
    state.agentAddExists = false;
    state.launches.length = 0;
  });

  /** Wait until detached refresh work (project refresh scheduled by search, agent refresh scheduled by append) has stopped launching. */
  async function settle(): Promise<void> {
    let stableChecks = 0;
    let lastCount = -1;
    while (stableChecks < 5) {
      await new Promise((resolveTick) => setTimeout(resolveTick, 10));
      const open = state.launches.some((launch) => !(launch.child as FakeChild).closed);
      if (!open && state.launches.length === lastCount) {
        stableChecks += 1;
      } else {
        stableChecks = 0;
      }
      lastCount = state.launches.length;
    }
  }

  afterEach(async () => {
    await settle();
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeRoot(): string {
    const rootDir = mkdtempSync(join(tmpdir(), "kb-076-agent-qmd-"));
    tempDirs.push(rootDir);
    state.agentCollection = qmdAgentMemoryCollectionName(rootDir, AGENT_ID);
    return rootDir;
  }

  const agentMemory = { agentId: AGENT_ID, agentName: "Agent X", memory: "needle fact about deployments" };

  async function runSearch(rootDir: string) {
    const tool = createMemorySearchTool(rootDir, settings, { agentMemory });
    const result = await tool.execute("call-1", { query: QUERY } as never, undefined as never, undefined as never, undefined as never);
    return (result.details as { results: Array<{ backend: string; snippet: string }> }).results;
  }

  function launches(): Launch[] {
    return state.launches as unknown as Launch[];
  }

  /** The search tool awaits the whole agent path before project search starts, so agent launches run up to the agent-collection search. */
  function agentSearchLaunches(): Launch[] {
    const all = launches();
    const searchIndex = all.findIndex((launch) => launch.args.includes("search") && launch.args.includes(state.agentCollection));
    return searchIndex === -1 ? [] : all.slice(0, searchIndex + 1);
  }

  it("win32 npm qmd.cmd shim: agent search launches node <cli.js> shell-free and returns indexed hits", async () => {
    const rootDir = makeRoot();

    const results = await runSearch(rootDir);

    expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ backend: "qmd-agent-memory" })]));
    expect(agentSearchLaunches().map((launch) => launch.args)).toEqual([
      [QMD_SCRIPT, ...buildQmdAgentMemoryCollectionAddArgs(rootDir, AGENT_ID)],
      [QMD_SCRIPT, "update"],
      [QMD_SCRIPT, "embed"],
      [QMD_SCRIPT, ...buildQmdAgentMemorySearchArgs(rootDir, AGENT_ID, QUERY, 5)],
    ]);
    expect(agentSearchLaunches()[3].args.slice(1)).toEqual([
      "search", QUERY, "--json", "--collection", state.agentCollection, "-n", "5",
    ]);
    await settle();
    expect(launches().length).toBeGreaterThan(4);
    for (const launch of launches()) {
      expect(launch.command).toBe(NODE);
      expect(launch.args[0]).toBe(QMD_SCRIPT);
      expect(launch.options.cwd).toBe(rootDir);
      expect(launch.options.shell).toBeFalsy();
    }
  });

  it("unrefs every launched child and its stdio", async () => {
    const rootDir = makeRoot();

    await runSearch(rootDir);
    await settle();

    expect(launches().length).toBeGreaterThan(0);
    for (const { child } of launches()) {
      expect(child.unref).toHaveBeenCalled();
      expect(child.stdout.unref).toHaveBeenCalled();
      expect(child.stderr.unref).toHaveBeenCalled();
    }
  });

  it("win32 npm qmd.cmd shim: agent append refreshes the agent index through node <cli.js>", async () => {
    const rootDir = makeRoot();
    const tool = createMemoryAppendTool(rootDir, settings, { agentMemory });

    const result = await tool.execute("call-1", { scope: "agent", layer: "long-term", content: "new fact" } as never, undefined as never, undefined as never, undefined as never);

    expect(result.content[0]).toEqual(expect.objectContaining({ text: "Appended to agent long-term memory." }));
    await vi.waitFor(() => expect(launches()).toHaveLength(3));
    expect(launches().map((launch) => launch.args)).toEqual([
      [QMD_SCRIPT, ...buildQmdAgentMemoryCollectionAddArgs(rootDir, AGENT_ID)],
      [QMD_SCRIPT, "update"],
      [QMD_SCRIPT, "embed"],
    ]);
    for (const launch of launches()) {
      expect(launch.command).toBe(NODE);
      expect(launch.options.shell).toBeFalsy();
      expect(launch.child.unref).toHaveBeenCalled();
      expect(launch.child.stdout.unref).toHaveBeenCalled();
      expect(launch.child.stderr.unref).toHaveBeenCalled();
    }
  });

  it("tolerates an agent collection that already exists and still updates, embeds, and searches", async () => {
    state.agentAddExists = true;
    const rootDir = makeRoot();

    const results = await runSearch(rootDir);

    expect(agentSearchLaunches().map((launch) => launch.args[1])).toEqual(["collection", "update", "embed", "search"]);
    expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ backend: "qmd-agent-memory" })]));
  });

  it("win32 native qmd.exe is launched directly with unchanged args", async () => {
    state.files = { [QMD_EXE]: "" };
    const rootDir = makeRoot();

    await runSearch(rootDir);

    const search = agentSearchLaunches().at(-1);
    expect(search?.command).toBe(QMD_EXE);
    expect(search?.args.slice(0, 5)).toEqual(["search", QUERY, "--json", "--collection", state.agentCollection]);
  });

  it("an unrecognized win32 qmd.bat spawns nothing and falls back to agent file search", async () => {
    state.files = { "C:\\npm\\qmd.bat": "@echo off\r\nsomething-else %*\r\n" };
    const rootDir = makeRoot();

    const results = await runSearch(rootDir);

    expect(launches()).toHaveLength(0);
    const fileHit = results.find((hit) => hit.backend === "agent-memory");
    expect(fileHit?.snippet).toContain(QUERY);
  });

  it("absent qmd reaches spawn unchanged and falls back to agent file search", async () => {
    state.files = {};
    state.absent = true;
    const rootDir = makeRoot();

    const results = await runSearch(rootDir);

    expect(launches()[0]).toEqual(expect.objectContaining({ command: "qmd" }));
    const fileHit = results.find((hit) => hit.backend === "agent-memory");
    expect(fileHit?.snippet).toContain(QUERY);
  });

  it("POSIX launches qmd as-is with the builder args", async () => {
    state.platform = "linux";
    const rootDir = makeRoot();

    await runSearch(rootDir);

    expect(agentSearchLaunches().map((launch) => [launch.command, ...launch.args])).toEqual([
      ["qmd", ...buildQmdAgentMemoryCollectionAddArgs(rootDir, AGENT_ID)],
      ["qmd", "update"],
      ["qmd", "embed"],
      ["qmd", ...buildQmdAgentMemorySearchArgs(rootDir, AGENT_ID, QUERY, 5)],
    ]);
  });
});
