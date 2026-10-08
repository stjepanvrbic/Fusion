/*
FNXC:TestInfraWindows 2026-10-08-05:48:
Proves the cross-platform PATH shim reaches a fake command through both execution paths the product uses on the CURRENT platform (native exec and Fusion's POSIX seam), can forward to the real binary, and leaves PATH exactly as it found it.
*/
import { exec } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { execPosix } from "@fusion/core";
import { installPathShim, pathEnvKey, realCommandPath, type PathShim } from "./_path-shim.js";

const execNative = promisify(exec);

describe("installPathShim", () => {
  let shim: PathShim | undefined;
  afterEach(() => {
    shim?.restore();
    shim = undefined;
  });

  it("reaches an sh shim through the POSIX seam and passes argv through", async () => {
    shim = installPathShim({ name: "fusion-shim-probe", kind: "sh", body: 'echo "sh-shim $1|$2"' });
    const { stdout } = await execPosix("fusion-shim-probe alpha 'b c'");
    expect(stdout.trim()).toBe("sh-shim alpha|b c");
  });

  it("reaches a node shim through native exec", async () => {
    shim = installPathShim({
      name: "fusion-shim-node",
      kind: "node",
      body: "process.stdout.write('node-shim ' + process.argv.slice(2).join('|'));",
    });
    const { stdout } = await execNative("fusion-shim-node one two");
    expect(stdout.trim()).toBe("node-shim one|two");
  });

  it("shadows a real command under the POSIX seam and can forward to the real binary", async () => {
    const realGit = realCommandPath("git");
    shim = installPathShim({
      name: "git",
      kind: "sh",
      body: `if [ "$1" = "shim-only" ]; then echo intercepted; exit 0; fi\nexec ${JSON.stringify(realGit)} "$@"`,
    });
    expect((await execPosix("git shim-only")).stdout.trim()).toBe("intercepted");
    expect((await execPosix("git --version")).stdout).toMatch(/^git version /);
    expect((await execNative("git shim-only")).stdout.trim()).toBe("intercepted");
  });

  it("writes into a caller-owned dir without deleting it", () => {
    const first = installPathShim({ name: "fusion-shim-a", kind: "sh", body: "exit 0" });
    try {
      const second = installPathShim({ name: "fusion-shim-b", kind: "sh", body: "exit 0", dir: first.dir });
      second.restore();
      expect(readFileSync(join(first.dir, "fusion-shim-a"), "utf8")).toContain("exit 0");
    } finally {
      first.restore();
    }
  });

  it("restores PATH byte-for-byte without adding a second PATH key", () => {
    const pathEntries = () => Object.entries(process.env).filter(([name]) => name.toUpperCase() === "PATH");
    const before = pathEntries();
    const installed = installPathShim({ name: "fusion-shim-restore", kind: "sh", body: "exit 0" });
    expect(process.env[pathEnvKey()]?.startsWith(installed.dir)).toBe(true);
    expect(pathEntries().map(([name]) => name)).toEqual(before.map(([name]) => name));
    installed.restore();
    expect(pathEntries()).toEqual(before);
  });

  it("deletes PATH on restore when it was absent before install", () => {
    // Worker env objects may carry both `PATH` and `Path`; remove every spelling to model a truly absent PATH.
    const prior = Object.entries(process.env).filter(([name]) => name.toUpperCase() === "PATH");
    for (const [name] of prior) delete process.env[name];
    try {
      const installed = installPathShim({ name: "fusion-shim-absent", kind: "sh", body: "exit 0" });
      expect(process.env[pathEnvKey()]).toBe(installed.dir);
      installed.restore();
      expect(Object.keys(process.env).some((name) => name.toUpperCase() === "PATH")).toBe(false);
    } finally {
      for (const [name, value] of prior) process.env[name] = value;
    }
  });
});
