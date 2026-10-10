// @vitest-environment node

import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { resolveShellFreeLaunch } from "@fusion/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => ({ fn: undefined as unknown as ReturnType<typeof vi.fn> }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  spawnMock.fn = vi.fn(actual.spawn);
  return { ...actual, spawn: spawnMock.fn };
});

import {
  fnBinaryFileName,
  installLocalFnBinary,
  isPathInsideOrEqual,
  removeLocalFnShims,
  renderFnCmdShim,
  resolveFnBinaryLocalPaths,
  runStreamingCommand,
  type FnBinaryLocalPaths,
} from "../fn-binary-local-install.js";

/*
FNXC:SystemPanelFnBinary 2026-07-15-09:54:
Unit tests for the local fn install layout used by System panel link-local /
use-global actions: co-located client assets, ~/.local/bin shims, and selective
shim removal that leaves unrelated binaries alone.

FNXC:SystemPanelFnBinary 2026-10-08-19:30:
KB-097: both the Windows (`fn.exe` + `.cmd` shims) and POSIX (`fn` + symlinks) layouts are exercised on every host by passing the platform explicitly.
Host-native tests derive their expectations from `paths.shimStyle` instead of skipping, so the file runs unskipped on Windows and Linux.
*/

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTemp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

const BINARY_BYTES = "#!/bin/sh\necho ok\n";

/** A dist dir shaped like `packages/cli/dist` after the Bun compile on this host. */
function makeDist(): string {
  const dist = makeTemp("fn-bin-dist-");
  // FNXC:SystemPanelFnBinary 2026-10-08-17:49: KB-087: fixtures use the platform binary name (fn.exe on Windows) the installer reads.
  writeFileSync(join(dist, fnBinaryFileName()), BINARY_BYTES);
  chmodSync(join(dist, fnBinaryFileName()), 0o755);
  mkdirSync(join(dist, "client"), { recursive: true });
  writeFileSync(join(dist, "client", "index.html"), "<html></html>");
  mkdirSync(join(dist, "runtime", "win32-x64"), { recursive: true });
  writeFileSync(join(dist, "runtime", "win32-x64", "pty.node"), "native");
  return dist;
}

function collect(): { logs: string[]; onLog: (stream: string, text: string) => void } {
  const logs: string[] = [];
  return { logs, onLog: (_stream, text) => logs.push(text) };
}

describe("resolveFnBinaryLocalPaths", () => {
  it("uses fn.exe and .cmd shims for the win32 layout", () => {
    const home = makeTemp("fn-bin-home-");
    const paths = resolveFnBinaryLocalPaths(home, "win32");
    expect(paths.binaryPath).toBe(join(home, ".local", "share", "fusion", "fn.exe"));
    expect(paths.fnShimPath).toBe(join(home, ".local", "bin", "fn.cmd"));
    expect(paths.fusionShimPath).toBe(join(home, ".local", "bin", "fusion.cmd"));
    expect(paths.shimStyle).toBe("cmd");
    expect(paths.platform).toBe("win32");
  });

  it("keeps the extensionless binary and symlink shims for POSIX layouts", () => {
    const home = makeTemp("fn-bin-home-");
    for (const platform of ["linux", "darwin"] as const) {
      const paths = resolveFnBinaryLocalPaths(home, platform);
      expect(paths.binaryPath).toBe(join(home, ".local", "share", "fusion", "fn"));
      expect(paths.fnShimPath).toBe(join(home, ".local", "bin", "fn"));
      expect(paths.fusionShimPath).toBe(join(home, ".local", "bin", "fusion"));
      expect(paths.shimStyle).toBe("symlink");
    }
  });
});

describe("installLocalFnBinary", () => {
  it("installs the win32 layout with plain-file .cmd shims and co-located assets, idempotently", () => {
    const home = makeTemp("fn-bin-home-");
    const dist = makeDist();
    const paths = resolveFnBinaryLocalPaths(home, "win32");
    const { logs, onLog } = collect();

    installLocalFnBinary(dist, onLog, paths);
    installLocalFnBinary(dist, onLog, paths);

    expect(readFileSync(paths.binaryPath, "utf8")).toBe(BINARY_BYTES);
    expect(existsSync(join(paths.installDir, "client", "index.html"))).toBe(true);
    expect(existsSync(join(paths.installDir, "runtime", "win32-x64", "pty.node"))).toBe(true);
    const expectedShim = renderFnCmdShim(paths.binDir, paths.binaryPath);
    for (const shim of [paths.fnShimPath, paths.fusionShimPath]) {
      expect(lstatSync(shim).isSymbolicLink()).toBe(false);
      expect(lstatSync(shim).isFile()).toBe(true);
      expect(readFileSync(shim, "utf8")).toBe(expectedShim);
    }
    // The binary stays in installDir; binDir holds exactly the two shims.
    expect(readdirSync(paths.binDir).sort()).toEqual(["fn.cmd", "fusion.cmd"]);
    expect(logs.some((line) => line.startsWith("Write shim"))).toBe(true);
    expect(logs.some((line) => line.startsWith("Link "))).toBe(false);
  });

  it("renders a CRLF batch shim forwarding every argument to the binary", () => {
    expect(renderFnCmdShim("C:\\h\\.local\\bin", "C:\\h\\.local\\share\\fusion\\fn.exe")).toBe(
      '@echo off\r\n"%~dp0..\\share\\fusion\\fn.exe" %*\r\n',
    );
  });

  it("produces a shim that resolveShellFreeLaunch unwraps to the installed fn.exe", () => {
    const shimPath = "C:\\h\\.local\\bin\\fn.cmd";
    const binaryPath = "C:\\h\\.local\\share\\fusion\\fn.exe";
    const body = renderFnCmdShim("C:\\h\\.local\\bin", binaryPath);
    const files = new Map([[shimPath, body], [binaryPath, "MZ"]]);
    const launch = resolveShellFreeLaunch("fn", ["--version"], {
      platform: "win32",
      env: { PATH: "C:\\h\\.local\\bin", PATHEXT: ".EXE;.CMD" },
      isFile: (path) => files.has(path),
      readFile: (path) => {
        const content = files.get(path);
        if (content === undefined) throw new Error(`ENOENT ${path}`);
        return content;
      },
    });
    expect(launch).toEqual({ command: binaryPath, args: ["--version"], resolvedPath: binaryPath });
  });

  it("installs the host-native layout without elevated privileges", () => {
    const home = makeTemp("fn-bin-home-");
    const dist = makeDist();
    const paths = resolveFnBinaryLocalPaths(home);
    const { logs, onLog } = collect();

    installLocalFnBinary(dist, onLog, paths);

    expect(logs.some((line) => line.includes("Installing binary"))).toBe(true);
    expect(readFileSync(paths.binaryPath, "utf8")).toBe(BINARY_BYTES);
    for (const shim of [paths.fnShimPath, paths.fusionShimPath]) {
      if (paths.shimStyle === "symlink") {
        expect(readlinkSync(shim)).toBe(paths.binaryPath);
      } else {
        expect(lstatSync(shim).isSymbolicLink()).toBe(false);
        expect(readFileSync(shim, "utf8")).toBe(renderFnCmdShim(paths.binDir, paths.binaryPath));
      }
    }
  });
});

describe("isPathInsideOrEqual", () => {
  const winDir = "C:\\Users\\a\\.local\\share\\fusion";

  it("applies win32 rules: backslashes, case-insensitivity, no sibling prefixes", () => {
    expect(isPathInsideOrEqual(winDir, "C:\\Users\\a\\.local\\share\\fusion\\fn.exe", "win32")).toBe(true);
    expect(isPathInsideOrEqual(winDir, "c:\\users\\A\\.LOCAL\\share\\Fusion\\fn.exe", "win32")).toBe(true);
    expect(isPathInsideOrEqual(winDir, "C:\\Users\\a\\.local\\share\\fusion\\runtime\\fn.exe", "win32")).toBe(true);
    expect(isPathInsideOrEqual(winDir, winDir, "win32")).toBe(true);
    expect(isPathInsideOrEqual(winDir, "C:\\Users\\a\\.local\\share\\fusion-other\\fn.exe", "win32")).toBe(false);
    expect(isPathInsideOrEqual(winDir, "C:\\Users\\a\\.local\\bin\\fn.cmd", "win32")).toBe(false);
  });

  it("applies posix rules: case-sensitive, no sibling prefixes", () => {
    const dir = "/home/a/.local/share/fusion";
    expect(isPathInsideOrEqual(dir, "/home/a/.local/share/fusion/fn", "linux")).toBe(true);
    expect(isPathInsideOrEqual(dir, dir, "linux")).toBe(true);
    expect(isPathInsideOrEqual(dir, "/home/a/.local/share/fusion-other/fn", "linux")).toBe(false);
    expect(isPathInsideOrEqual(dir, "/home/a/.local/bin/fn", "linux")).toBe(false);
    expect(isPathInsideOrEqual(dir, "/home/a/.local/share/Fusion/fn", "linux")).toBe(false);
  });
});

describe("removeLocalFnShims", () => {
  function installWin32(): FnBinaryLocalPaths {
    const home = makeTemp("fn-bin-home-rm-");
    const paths = resolveFnBinaryLocalPaths(home, "win32");
    installLocalFnBinary(makeDist(), () => {}, paths);
    return paths;
  }

  it("removes win32 .cmd shims that forward into the local install", () => {
    const paths = installWin32();
    const otherTool = join(paths.binDir, "other-tool");
    writeFileSync(otherTool, "keep-me");
    const { logs, onLog } = collect();

    const result = removeLocalFnShims(onLog, paths);

    expect(result.removed).toEqual([paths.fnShimPath, paths.fusionShimPath]);
    expect(existsSync(paths.fnShimPath)).toBe(false);
    expect(existsSync(paths.fusionShimPath)).toBe(false);
    expect(logs.some((line) => line.includes("Removed local shim"))).toBe(true);
    expect(readFileSync(otherTool, "utf8")).toBe("keep-me");
    expect(existsSync(paths.binaryPath)).toBe(true);
  });

  it("leaves .cmd shims that forward elsewhere or are not recognized shims", () => {
    const paths = installWin32();
    const foreign = '@echo off\r\n"%~dp0..\\other\\fn.exe" %*\r\n';
    writeFileSync(paths.fnShimPath, foreign);
    writeFileSync(paths.fusionShimPath, "garbage that is not a shim");
    const { logs, onLog } = collect();

    const result = removeLocalFnShims(onLog, paths);

    expect(result.removed).toEqual([]);
    expect(readFileSync(paths.fnShimPath, "utf8")).toBe(foreign);
    expect(readFileSync(paths.fusionShimPath, "utf8")).toBe("garbage that is not a shim");
    expect(logs.filter((line) => line.startsWith("Leaving")).length).toBe(2);
  });

  it("removes the host-native shims after a host-native install", () => {
    const home = makeTemp("fn-bin-home-rm-");
    const paths = resolveFnBinaryLocalPaths(home);
    installLocalFnBinary(makeDist(), () => {}, paths);
    const otherTool = join(paths.binDir, "other-tool");
    writeFileSync(otherTool, "keep-me");
    const { logs, onLog } = collect();

    const result = removeLocalFnShims(onLog, paths);

    expect(result.removed).toEqual([paths.fnShimPath, paths.fusionShimPath]);
    expect(logs.some((line) => line.includes("Removed local shim"))).toBe(true);
    expect(existsSync(paths.fnShimPath)).toBe(false);
    expect(existsSync(paths.fusionShimPath)).toBe(false);
    expect(readFileSync(otherTool, "utf8")).toBe("keep-me");
  });
});

describe("runStreamingCommand", () => {
  afterEach(() => {
    spawnMock.fn.mockClear();
  });

  it("passes shell metacharacter arguments verbatim through a shell-free spawn", async () => {
    const dir = makeTemp("fn-bin-echo-");
    const scriptPath = join(dir, "echo-args.js");
    writeFileSync(scriptPath, "process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\\n');\n");
    const args = ["a&echo injected", "x y", '"q"'];
    const { onLog } = collect();

    const result = await runStreamingCommand(scriptPath, args, { timeoutMs: 20_000, onLog });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual(args);
    expect(spawnMock.fn).toHaveBeenCalledWith(
      expect.any(String),
      [scriptPath, ...args],
      expect.objectContaining({ shell: false }),
    );
  });

  const npmShim = "C:\\n\\npm.cmd";
  const npmCli = "C:\\n\\node_modules\\npm\\bin\\npm-cli.js";
  const nodeExe = "C:\\n\\node.exe";

  function launchDeps(shimBody: string) {
    const files = new Map([[npmShim, shimBody], [npmCli, ""], [nodeExe, ""]]);
    return {
      platform: "win32" as const,
      env: { PATH: "C:\\n", PATHEXT: ".EXE;.CMD" },
      execPath: nodeExe,
      isElectron: false,
      isFile: (path: string) => files.has(path),
      readFile: (path: string) => {
        const content = files.get(path);
        if (content === undefined) throw new Error(`ENOENT ${path}`);
        return content;
      },
    };
  }

  it("unwraps a Windows npm .cmd shim to node <npm-cli.js> with shell:false", async () => {
    spawnMock.fn.mockImplementationOnce(() => {
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; pid: number };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 4242;
      setImmediate(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    });
    const { onLog } = collect();

    const result = await runStreamingCommand("npm", ["install", "-g", "x"], {
      timeoutMs: 20_000,
      onLog,
      launchDeps: launchDeps('@ECHO off\r\n"%~dp0node_modules\\npm\\bin\\npm-cli.js" %*\r\n'),
    });

    expect(result.exitCode).toBe(0);
    expect(result.command).toBe("npm install -g x");
    expect(spawnMock.fn).toHaveBeenCalledTimes(1);
    expect(spawnMock.fn).toHaveBeenCalledWith(
      nodeExe,
      [npmCli, "install", "-g", "x"],
      expect.objectContaining({ shell: false }),
    );
  });

  it("fails without spawning when the command could only run through a shell", async () => {
    const { logs, onLog } = collect();

    const result = await runStreamingCommand("npm", ["install"], {
      timeoutMs: 20_000,
      onLog,
      launchDeps: launchDeps("@echo off\r\necho not a shim\r\n"),
    });

    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain("without a command shell");
    expect(logs.some((line) => line.includes("without a command shell"))).toBe(true);
    expect(spawnMock.fn).not.toHaveBeenCalled();
  });
});
