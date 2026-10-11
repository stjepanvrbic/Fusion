// @vitest-environment node

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import { resolvePosixShell, resolveShellFreeLaunch } from "@fusion/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => ({ fn: undefined as unknown as ReturnType<typeof vi.fn> }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  spawnMock.fn = vi.fn(actual.spawn);
  return { ...actual, spawn: spawnMock.fn };
});

import {
  FnBinaryInUseError,
  fnBinaryFileName,
  installLocalFnBinary,
  isPathInsideOrEqual,
  removeLocalFnShims,
  renderFnCmdShim,
  renderFnShellShim,
  resolveFnBinaryLocalPaths,
  runLinkLocalFnBinary,
  runStreamingCommand,
  type FnBinaryInstallFs,
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

FNXC:SystemPanelFnBinary 2026-10-11-06:32:
KB-109: re-installing over a really running installed binary (a copy of the Node executable) must succeed, and every injected file-system failure must leave the binary, `client/` and `runtime/` on one build.
Leftover `.old-`/`.new-` copies are swept by later installs, while unrelated files in the install directory are never deleted.
*/

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    // Fixture teardown only: Windows releases the lock on an executable slightly after its process exits.
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function makeTemp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

const BINARY_BYTES = "#!/bin/sh\necho ok\n";

interface BuildContents {
  binary: string;
  client: string;
  runtime: string;
}

/** File contents of the fixture build `label`; no label is the original single-build fixture. */
function buildContents(label?: string): BuildContents {
  if (!label) return { binary: BINARY_BYTES, client: "<html></html>", runtime: "native" };
  return { binary: `${BINARY_BYTES}# ${label}\n`, client: `<html>${label}</html>`, runtime: `native-${label}` };
}

/**
 * A dist dir shaped like `packages/cli/dist` after the Bun compile on this host.
 * `label` makes the binary, `client/index.html` and the runtime file distinguishable between builds.
 */
function makeDist(label?: string, dist = makeTemp("fn-bin-dist-")): string {
  mkdirSync(dist, { recursive: true });
  const contents = buildContents(label);
  // FNXC:SystemPanelFnBinary 2026-10-08-17:49: KB-087: fixtures use the platform binary name (fn.exe on Windows) the installer reads.
  writeFileSync(join(dist, fnBinaryFileName()), contents.binary);
  chmodSync(join(dist, fnBinaryFileName()), 0o755);
  mkdirSync(join(dist, "client"), { recursive: true });
  writeFileSync(join(dist, "client", "index.html"), contents.client);
  mkdirSync(join(dist, "runtime", "win32-x64"), { recursive: true });
  writeFileSync(join(dist, "runtime", "win32-x64", "pty.node"), contents.runtime);
  return dist;
}

/** What the live install holds: the three entries' contents plus the sorted `installDir` listing. */
function readInstall(paths: FnBinaryLocalPaths): BuildContents & { entries: string[] } {
  return {
    binary: readFileSync(paths.binaryPath, "utf8"),
    client: readFileSync(join(paths.installDir, "client", "index.html"), "utf8"),
    runtime: readFileSync(join(paths.installDir, "runtime", "win32-x64", "pty.node"), "utf8"),
    entries: readdirSync(paths.installDir).sort(),
  };
}

/** Sorted names of the three live entries for `paths`. */
function liveEntries(paths: FnBinaryLocalPaths): string[] {
  return [fnBinaryFileName(paths.platform), "client", "runtime"].sort();
}

/**
 * Start the installed binary (a copy of this Node executable) and resolve once it is running.
 * The process keeps the executable open, which is what makes Windows refuse to overwrite or delete it.
 */
async function startInstalledBinary(binaryPath: string): Promise<ChildProcess> {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const child = spawn(binaryPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"], {
    stdio: ["ignore", "pipe", "ignore"],
    env,
    windowsHide: true,
  });
  await new Promise<void>((resolveReady, rejectReady) => {
    child.once("error", rejectReady);
    child.once("exit", (code, signal) => rejectReady(new Error(`installed binary exited early (${code ?? signal})`)));
    child.stdout?.once("data", () => resolveReady());
  });
  return child;
}

type FsCall = "cpSync" | "renameSync" | "rmSync";

interface InjectedFailure {
  call: FsCall;
  /** Matches the call's first path (source, or the path to delete) and, for copies and renames, its destination. */
  when: (first: string, destination?: string) => boolean;
  /** Fail every matching call instead of only the first. */
  always?: boolean;
}

/** Real file-system calls, except that each injected failure throws an EPERM error at its matching call. */
function injectFs(failures: InjectedFailure[]): FnBinaryInstallFs {
  const pending = [...failures];
  const check = (call: FsCall, first: unknown, destination?: unknown): void => {
    const index = pending.findIndex(
      (failure) => failure.call === call && failure.when(String(first), destination === undefined ? undefined : String(destination)),
    );
    if (index < 0) return;
    if (!pending[index].always) pending.splice(index, 1);
    throw Object.assign(new Error(`EPERM: operation not permitted, ${call} '${String(first)}'`), { code: "EPERM" });
  };
  return {
    cpSync: ((source, destination, options) => {
      check("cpSync", source, destination);
      cpSync(source, destination, options);
    }) as FnBinaryInstallFs["cpSync"],
    renameSync: ((source, destination) => {
      check("renameSync", source, destination);
      renameSync(source, destination);
    }) as FnBinaryInstallFs["renameSync"],
    rmSync: ((path, options) => {
      check("rmSync", path);
      rmSync(path, options);
    }) as FnBinaryInstallFs["rmSync"],
  };
}

/** A fake spawned child that closes with exit code 0 on the next tick. */
function exitedChild(): EventEmitter {
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
}

function captureError(run: () => void): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

/** How each PATH shim looks on disk, so a test can assert the shims were not touched. */
function shimState(paths: FnBinaryLocalPaths): string[] {
  return [paths.fnShimPath, paths.fusionShimPath].map((shim) =>
    lstatSync(shim).isSymbolicLink() ? `link:${readlinkSync(shim)}` : `file:${readFileSync(shim, "utf8")}`,
  );
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolveClosed) => child.once("close", () => resolveClosed()));
  child.kill();
  await closed;
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
    expect(paths.shellShimPaths).toEqual([join(home, ".local", "bin", "fn"), join(home, ".local", "bin", "fusion")]);
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
      expect(paths.shellShimPaths).toEqual([]);
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
    for (const shim of paths.shellShimPaths) {
      expect(lstatSync(shim).isSymbolicLink()).toBe(false);
      expect(lstatSync(shim).isFile()).toBe(true);
      expect(readFileSync(shim, "utf8")).toBe(renderFnShellShim(paths.binDir, paths.binaryPath));
    }
    // The binary stays in installDir; binDir holds exactly one batch and one shell shim per name.
    expect(readdirSync(paths.binDir).sort()).toEqual(["fn", "fn.cmd", "fusion", "fusion.cmd"]);
    expect(logs.some((line) => line.startsWith("Write shim"))).toBe(true);
    expect(logs.some((line) => line.startsWith("Link "))).toBe(false);
  });

  it("renders a CRLF batch shim forwarding every argument to the binary", () => {
    expect(renderFnCmdShim("C:\\h\\.local\\bin", "C:\\h\\.local\\share\\fusion\\fn.exe")).toBe(
      '@echo off\r\n"%~dp0..\\share\\fusion\\fn.exe" %*\r\n',
    );
  });

  it("renders an LF shell shim that execs the binary relative to the shim", () => {
    const body = renderFnShellShim("C:\\h\\.local\\bin", "C:\\h\\.local\\share\\fusion\\fn.exe");
    expect(body).toBe(
      [
        "#!/bin/sh",
        "case $0 in",
        "  *[/\\\\]*) basedir=${0%[/\\\\]*} ;;",
        "  *) basedir=. ;;",
        "esac",
        'exec "$basedir/../share/fusion/fn.exe" "$@"',
        "",
      ].join("\n"),
    );
    expect(body).not.toContain("\r");
  });

  it("produces a shim that resolveShellFreeLaunch unwraps to the installed fn.exe", () => {
    const shimPath = "C:\\h\\.local\\bin\\fn.cmd";
    const binaryPath = "C:\\h\\.local\\share\\fusion\\fn.exe";
    const body = renderFnCmdShim("C:\\h\\.local\\bin", binaryPath);
    // The extensionless Git Bash shim beside it is never a launch candidate.
    const shellShimPath = "C:\\h\\.local\\bin\\fn";
    const files = new Map([
      [shimPath, body],
      [shellShimPath, renderFnShellShim("C:\\h\\.local\\bin", binaryPath)],
      [binaryPath, "MZ"],
    ]);
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

  it("re-installs while the installed binary is running", async () => {
    const home = makeTemp("fn-bin-home-run-");
    const paths = resolveFnBinaryLocalPaths(home);
    installLocalFnBinary(makeDist("first"), () => {}, paths);
    cpSync(process.execPath, paths.binaryPath);
    chmodSync(paths.binaryPath, 0o755);
    const child = await startInstalledBinary(paths.binaryPath);
    try {
      const { onLog } = collect();

      installLocalFnBinary(makeDist("second"), onLog, paths);

      const installed = readInstall(paths);
      expect({ binary: installed.binary, client: installed.client, runtime: installed.runtime }).toEqual(
        buildContents("second"),
      );
      expect(child.exitCode).toBeNull();
      const binaryName = fnBinaryFileName(paths.platform);
      for (const entry of installed.entries) {
        expect(liveEntries(paths).includes(entry) || entry.startsWith(`${binaryName}.old-`)).toBe(true);
      }
    } finally {
      await stopProcess(child);
    }
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
    for (const shim of paths.shellShimPaths) {
      expect(lstatSync(shim).isFile()).toBe(true);
      expect(readFileSync(shim, "utf8")).toBe(renderFnShellShim(paths.binDir, paths.binaryPath));
    }
  });
});

/*
FNXC:SystemPanelFnBinary 2026-10-11-07:35:
Git Bash does not apply PATHEXT to `.cmd`, so after a win32-layout install `fn` and `fusion` must run by bare name through a POSIX shell.
The installed binary is a `#!/bin/sh` fake that echoes its arguments and exits 5, which MSYS and Linux shells both execute, so these cases run on Windows (Git Bash) and Linux hosts.
*/
const FAKE_BINARY = "#!/bin/sh\nprintf '<%s>' \"$@\"\nexit 5\n";

/** Prepends `/usr/bin` (which `<git>\usr\bin\bash.exe` does not add itself) and the shim directory to PATH, then runs `$2` by bare name. */
const RUN_BY_NAME =
  'PATH="/usr/bin:/bin:$PATH"; d=$1; n=$2; shift 2; ' +
  'if command -v cygpath >/dev/null 2>&1; then d=$(cygpath -u "$d"); fi; PATH="$d:$PATH"; "$n" "$@"';

/** The host POSIX shell: Git Bash on Windows (never bare `sh`, which can be the WSL launcher), `/bin/sh` elsewhere. */
function hostPosixShell(): string {
  if (process.platform !== "win32") return "/bin/sh";
  const shell = resolvePosixShell();
  expect(shell, "a Git Bash shell is required on Windows").toBeDefined();
  return shell as string;
}

/**
 * Environment whose PATH holds only system directories, so an `fn` installed on the host (for example an npm shim) can never answer for the shim under test.
 * Git's `bin\bash.exe` adds its own `/mingw64/bin:/usr/bin`; every PATH-like key is dropped first because Windows env keys are case-insensitive.
 */
function systemOnlyEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() !== "PATH") env[key] = value;
  }
  env.PATH = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "/usr/bin:/bin";
  return env;
}

function runHostShell(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(hostPosixShell(), args, {
    cwd: makeTemp("fn-bin-cwd-"),
    env: systemOnlyEnv(),
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function installWithFakeBinary(platform: NodeJS.Platform): FnBinaryLocalPaths {
  const dist = makeDist();
  writeFileSync(join(dist, fnBinaryFileName()), FAKE_BINARY);
  const paths = resolveFnBinaryLocalPaths(makeTemp("fn bin home "), platform);
  installLocalFnBinary(dist, () => {}, paths);
  return paths;
}

describe("win32 layout from a POSIX shell", () => {
  it.each(["fn", "fusion"])("runs %s by bare name with arguments and exit code passed through", (name) => {
    const paths = installWithFakeBinary("win32");

    const result = runHostShell(["-c", RUN_BY_NAME, "sh", paths.binDir, name, "a b", "c&d", ""]);

    expect(result).toEqual({
      status: 5,
      stdout: "<a b><c&d><>",
      stderr: "",
    });
  });

  it("runs the shell shim invoked by its full path from another directory", () => {
    const paths = installWithFakeBinary("win32");

    expect(runHostShell([paths.shellShimPaths[0], "x y"])).toEqual({ status: 5, stdout: "<x y>", stderr: "" });
  });

  it("replaces a legacy link at a shell shim path without touching its target", () => {
    const home = makeTemp("fn-bin-home-legacy-");
    const paths = resolveFnBinaryLocalPaths(home, "win32");
    const outsideDir = makeTemp("fn-bin-outside-");
    writeFileSync(join(outsideDir, "marker.txt"), "marker");
    mkdirSync(paths.binDir, { recursive: true });
    symlinkSync(outsideDir, paths.shellShimPaths[0], "junction");

    installLocalFnBinary(makeDist(), () => {}, paths);

    expect(lstatSync(paths.shellShimPaths[0]).isFile()).toBe(true);
    expect(readFileSync(paths.shellShimPaths[0], "utf8")).toBe(renderFnShellShim(paths.binDir, paths.binaryPath));
    expect(readFileSync(join(outsideDir, "marker.txt"), "utf8")).toBe("marker");
  });
});

/*
FNXC:SystemPanelFnBinary 2026-10-11-06:32:
KB-109: a re-install either fully replaces the binary, `client/` and `runtime/` with the new build or leaves all three on the previous build.
Each case injects one failing file-system call through the installer's `fs` seam and runs for the win32 layout and the host-native layout on every host.
*/
const LAYOUTS: Array<[string, (home: string) => FnBinaryLocalPaths]> = [
  ["win32 layout", (home) => resolveFnBinaryLocalPaths(home, "win32")],
  ["host-native layout", (home) => resolveFnBinaryLocalPaths(home)],
];

describe.each(LAYOUTS)("installLocalFnBinary staged replacement (%s)", (_name, layout) => {
  function installFirstBuild(): FnBinaryLocalPaths {
    const paths = layout(makeTemp("fn-bin-home-swap-"));
    installLocalFnBinary(makeDist("first"), () => {}, paths);
    return paths;
  }

  function expectFirstBuildIntact(paths: FnBinaryLocalPaths): void {
    expect(readInstall(paths)).toEqual({ ...buildContents("first"), entries: liveEntries(paths) });
  }

  it("replaces all three entries and leaves nothing else behind on a clean re-install", () => {
    const paths = installFirstBuild();

    installLocalFnBinary(makeDist("second"), () => {}, paths);

    expect(readInstall(paths)).toEqual({ ...buildContents("second"), entries: liveEntries(paths) });
  });

  it("removes leftovers of earlier installs and nothing else", () => {
    const paths = installFirstBuild();
    const binaryName = fnBinaryFileName(paths.platform);
    writeFileSync(join(paths.installDir, `${binaryName}.old-stale`), "stale");
    for (const dir of ["client.old-stale", "runtime.new-stale", "client-old-backup"]) {
      mkdirSync(join(paths.installDir, dir));
      writeFileSync(join(paths.installDir, dir, "file.txt"), dir);
    }
    writeFileSync(join(paths.installDir, "keep.txt"), "keep");

    installLocalFnBinary(makeDist("second"), () => {}, paths);

    expect(readInstall(paths)).toEqual({
      ...buildContents("second"),
      entries: [...liveEntries(paths), "client-old-backup", "keep.txt"].sort(),
    });
    expect(readFileSync(join(paths.installDir, "keep.txt"), "utf8")).toBe("keep");
    expect(readFileSync(join(paths.installDir, "client-old-backup", "file.txt"), "utf8")).toBe("client-old-backup");
  });

  it("keeps a previous copy that is still in use and removes it on a later install", () => {
    const paths = installFirstBuild();
    const binaryName = fnBinaryFileName(paths.platform);
    const fs = injectFs([
      { call: "rmSync", when: (path) => path.startsWith(`${paths.binaryPath}.old-`), always: true },
    ]);
    const { logs, onLog } = collect();

    installLocalFnBinary(makeDist("second"), onLog, paths, fs);

    const installed = readInstall(paths);
    expect({ binary: installed.binary, client: installed.client, runtime: installed.runtime }).toEqual(
      buildContents("second"),
    );
    const kept = installed.entries.filter((entry) => entry.startsWith(`${binaryName}.old-`));
    expect(kept).toHaveLength(1);
    expect(installed.entries).toEqual([...liveEntries(paths), kept[0]].sort());
    const keptPath = join(paths.installDir, kept[0]);
    expect(readFileSync(keptPath, "utf8")).toBe(buildContents("first").binary);
    expect(logs.some((line) => line.includes(keptPath) && /restart/i.test(line))).toBe(true);

    installLocalFnBinary(makeDist("third"), () => {}, paths);

    expect(readInstall(paths)).toEqual({ ...buildContents("third"), entries: liveEntries(paths) });
  });

  it("leaves the live install untouched when staging the new build fails", () => {
    const paths = installFirstBuild();
    const shimsBefore = shimState(paths);
    const fs = injectFs([
      { call: "cpSync", when: (_source, destination) => basename(destination ?? "").startsWith("client.new-") },
    ]);

    expect(() => installLocalFnBinary(makeDist("second"), () => {}, paths, fs)).toThrow(/Staging/);

    expectFirstBuildIntact(paths);
    expect(shimState(paths)).toEqual(shimsBefore);
  });

  it("reports fn as running when the live binary cannot be moved aside", () => {
    const paths = installFirstBuild();
    const fs = injectFs([{ call: "renameSync", when: (source) => source === paths.binaryPath }]);

    const thrown = captureError(() => installLocalFnBinary(makeDist("second"), () => {}, paths, fs));

    expect(thrown).toBeInstanceOf(FnBinaryInUseError);
    const inUse = thrown as FnBinaryInUseError;
    expect(inUse.path).toBe(paths.binaryPath);
    expect(inUse.code).toBe("EPERM");
    expect(inUse.message).toContain(paths.binaryPath);
    expect(inUse.message).toMatch(/running/i);
    expectFirstBuildIntact(paths);
  });

  it("rolls back the swapped binary and client when runtime cannot be moved aside", () => {
    const paths = installFirstBuild();
    const runtimeDir = join(paths.installDir, "runtime");
    const fs = injectFs([{ call: "renameSync", when: (source) => source === runtimeDir }]);

    const thrown = captureError(() => installLocalFnBinary(makeDist("second"), () => {}, paths, fs));

    expect(thrown).toBeInstanceOf(FnBinaryInUseError);
    expect((thrown as FnBinaryInUseError).path).toBe(runtimeDir);
    expectFirstBuildIntact(paths);
  });

  it("rolls back when promoting a staged entry fails", () => {
    const paths = installFirstBuild();
    const clientDir = join(paths.installDir, "client");
    const fs = injectFs([{ call: "renameSync", when: (_source, destination) => destination === clientDir }]);

    expect(() => installLocalFnBinary(makeDist("second"), () => {}, paths, fs)).toThrow(/client/);

    expectFirstBuildIntact(paths);
  });
});

describe("installLocalFnBinary leftovers that cannot be deleted", () => {
  it("installs anyway and logs the leftover that is still in use", () => {
    const paths = resolveFnBinaryLocalPaths(makeTemp("fn-bin-home-swap-"), "win32");
    installLocalFnBinary(makeDist("first"), () => {}, paths);
    const stale = join(paths.installDir, "fn.exe.old-stale");
    writeFileSync(stale, "stale");
    const fs = injectFs([{ call: "rmSync", when: (path) => path === stale, always: true }]);
    const { logs, onLog } = collect();

    installLocalFnBinary(makeDist("second"), onLog, paths, fs);

    expect(readInstall(paths)).toEqual({
      ...buildContents("second"),
      entries: [...liveEntries(paths), "fn.exe.old-stale"].sort(),
    });
    expect(logs.some((line) => line.includes(stale))).toBe(true);
  });
});

describe("installLocalFnBinary rollback failure", () => {
  it("names the moved-aside copy that still holds the previous binary", () => {
    const paths = resolveFnBinaryLocalPaths(makeTemp("fn-bin-home-swap-"), "win32");
    installLocalFnBinary(makeDist("first"), () => {}, paths);
    const fs = injectFs([
      { call: "renameSync", when: (source) => source === join(paths.installDir, "client") },
      {
        call: "renameSync",
        when: (source, destination) => source.startsWith(`${paths.binaryPath}.old-`) && destination === paths.binaryPath,
      },
    ]);

    const thrown = captureError(() => installLocalFnBinary(makeDist("second"), () => {}, paths, fs));

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    const stranded = readdirSync(paths.installDir).filter((entry) => entry.startsWith("fn.exe.old-"));
    expect(stranded).toHaveLength(1);
    const strandedPath = join(paths.installDir, stranded[0]);
    expect(message).toContain(strandedPath);
    expect(readFileSync(strandedPath, "utf8")).toBe(buildContents("first").binary);
  });
});

/*
FNXC:SystemPanelFnBinary 2026-10-11-06:32:
KB-109: the job log shows what `runLinkLocalFnBinary` returns, so an in-use install must come back as `{ success: false, error }` naming the path and saying fn is running.
The build and Bun compile children are faked and Bun resolves through a stubbed BUN_INSTALL, so the pipeline is hermetic on every host.
*/
describe("runLinkLocalFnBinary", () => {
  beforeEach(() => {
    spawnMock.fn.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    spawnMock.fn.mockClear();
  });

  function prepareSourceRoot(): string {
    const root = makeTemp("fn-bin-src-");
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts", "build-workspace.mjs"), "");
    mkdirSync(join(root, "packages", "cli"), { recursive: true });
    writeFileSync(join(root, "packages", "cli", "build.ts"), "");
    makeDist("second", join(root, "packages", "cli", "dist"));
    const bunInstall = makeTemp("fn-bin-bun-");
    mkdirSync(join(bunInstall, "bin"));
    writeFileSync(join(bunInstall, "bin", process.platform === "win32" ? "bun.exe" : "bun"), "");
    vi.stubEnv("BUN_INSTALL", bunInstall);
    spawnMock.fn.mockImplementationOnce(exitedChild).mockImplementationOnce(exitedChild);
    return root;
  }

  function installFirstBuild(): FnBinaryLocalPaths {
    const paths = resolveFnBinaryLocalPaths(makeTemp("fn-bin-home-link-"));
    installLocalFnBinary(makeDist("first"), () => {}, paths);
    return paths;
  }

  it("installs the compiled build at the given paths", async () => {
    const root = prepareSourceRoot();
    const paths = installFirstBuild();

    const result = await runLinkLocalFnBinary(root, () => {}, { paths });

    expect(result).toEqual({ success: true });
    expect(spawnMock.fn).toHaveBeenCalledTimes(2);
    expect(readInstall(paths)).toEqual({ ...buildContents("second"), entries: liveEntries(paths) });
  });

  it("returns the in-use message when the installed binary cannot be replaced", async () => {
    const root = prepareSourceRoot();
    const paths = installFirstBuild();
    const fs = injectFs([{ call: "renameSync", when: (source) => source === paths.binaryPath }]);

    const result = await runLinkLocalFnBinary(root, () => {}, { paths, fs });

    expect(result.success).toBe(false);
    expect(result.error).toContain(paths.binaryPath);
    expect(result.error).toMatch(/running/i);
    expect(readInstall(paths)).toEqual({ ...buildContents("first"), entries: liveEntries(paths) });
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

    expect(result.removed).toEqual([paths.fnShimPath, paths.fusionShimPath, ...paths.shellShimPaths]);
    for (const shim of result.removed) expect(existsSync(shim)).toBe(false);
    expect(logs.some((line) => line.includes("Removed local shim"))).toBe(true);
    expect(readdirSync(paths.binDir)).toEqual(["other-tool"]);
    expect(readFileSync(otherTool, "utf8")).toBe("keep-me");
    expect(existsSync(paths.binaryPath)).toBe(true);
  });

  it("leaves shell shims that forward elsewhere or are other scripts", () => {
    const paths = installWin32();
    const [fnShell, fusionShell] = paths.shellShimPaths;
    const elsewhere = renderFnShellShim(paths.binDir, paths.binaryPath).replace("../share/fusion/fn.exe", "../other/fn.exe");
    const npmShim = '#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/node_modules/@runfusion/fusion/dist/bin.js" "$@"\n';
    writeFileSync(fnShell, elsewhere);
    writeFileSync(fusionShell, npmShim);
    const { logs, onLog } = collect();

    const result = removeLocalFnShims(onLog, paths);

    expect(result.removed).toEqual([paths.fnShimPath, paths.fusionShimPath]);
    expect(readFileSync(fnShell, "utf8")).toBe(elsewhere);
    expect(readFileSync(fusionShell, "utf8")).toBe(npmShim);
    expect(logs.filter((line) => line.startsWith("Leaving"))).toEqual([
      expect.stringContaining(fnShell),
      expect.stringContaining(fusionShell),
    ]);
  });

  it("never reads a shell-shim-shaped file larger than the read cap", () => {
    const paths = installWin32();
    const oversize = `${renderFnShellShim(paths.binDir, paths.binaryPath)}#${"x".repeat(8192)}\n`;
    writeFileSync(paths.shellShimPaths[0], oversize);
    const { onLog } = collect();

    const result = removeLocalFnShims(onLog, paths);

    expect(result.removed).toEqual([paths.fnShimPath, paths.fusionShimPath, paths.shellShimPaths[1]]);
    expect(readFileSync(paths.shellShimPaths[0], "utf8")).toBe(oversize);
  });

  it("removes only the batch shims after an install that wrote no shell shims", () => {
    const paths = installWin32();
    for (const shim of paths.shellShimPaths) rmSync(shim);
    const streams: string[] = [];

    const result = removeLocalFnShims((stream) => streams.push(stream), paths);

    expect(result.removed).toEqual([paths.fnShimPath, paths.fusionShimPath]);
    expect(streams).not.toContain("stderr");
  });

  it("removes a legacy link into the install and leaves one that points elsewhere", () => {
    const paths = installWin32();
    const [fnShell, fusionShell] = paths.shellShimPaths;
    const runtimeDir = join(paths.installDir, "runtime");
    const outsideDir = makeTemp("fn-bin-outside-");
    for (const shim of paths.shellShimPaths) rmSync(shim);
    symlinkSync(runtimeDir, fnShell, "junction");
    symlinkSync(outsideDir, fusionShell, "junction");
    const { logs, onLog } = collect();

    const result = removeLocalFnShims(onLog, paths);

    expect(result.removed).toEqual([paths.fnShimPath, paths.fusionShimPath, fnShell]);
    expect(logs).toContain(`Removed legacy local shim ${fnShell}`);
    expect(existsSync(join(runtimeDir, "win32-x64", "pty.node"))).toBe(true);
    expect(lstatSync(fusionShell).isSymbolicLink()).toBe(true);
    expect(existsSync(outsideDir)).toBe(true);
  });

  it("leaves .cmd shims that forward elsewhere or are not recognized shims", () => {
    const paths = installWin32();
    const foreign = '@echo off\r\n"%~dp0..\\other\\fn.exe" %*\r\n';
    writeFileSync(paths.fnShimPath, foreign);
    writeFileSync(paths.fusionShimPath, "garbage that is not a shim");
    const { logs, onLog } = collect();

    const result = removeLocalFnShims(onLog, paths);

    expect(result.removed).toEqual(paths.shellShimPaths);
    expect(readFileSync(paths.fnShimPath, "utf8")).toBe(foreign);
    expect(readFileSync(paths.fusionShimPath, "utf8")).toBe("garbage that is not a shim");
    expect(logs.filter((line) => line.startsWith("Leaving"))).toEqual([
      expect.stringContaining(paths.fnShimPath),
      expect.stringContaining(paths.fusionShimPath),
    ]);
  });

  it("removes the host-native shims after a host-native install", () => {
    const home = makeTemp("fn-bin-home-rm-");
    const paths = resolveFnBinaryLocalPaths(home);
    installLocalFnBinary(makeDist(), () => {}, paths);
    const otherTool = join(paths.binDir, "other-tool");
    writeFileSync(otherTool, "keep-me");
    const { logs, onLog } = collect();

    const result = removeLocalFnShims(onLog, paths);

    expect(result.removed).toEqual([paths.fnShimPath, paths.fusionShimPath, ...paths.shellShimPaths]);
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
    spawnMock.fn.mockImplementationOnce(exitedChild);
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
