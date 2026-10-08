/*
FNXC:TestInfraWindows 2026-10-08-10:05:
KB-066 regression: the shared temp-path oracle must expand 8.3 short aliases on Windows (the GitHub runner's `RUNNER~1` temp), re-join missing suffixes under an aliased ancestor, and stay plain symlink resolution elsewhere.
*/
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitPorcelainPath, nativeRealPath, realTempDir } from "./real-path.js";

const created: string[] = [];

function tempDir(prefix: string): string {
  const dir = realTempDir(prefix);
  created.push(dir);
  return dir;
}

/** The 8.3 short spelling Windows reports for an existing path (equal to the input when the volume generates no alias). */
function win32ShortPath(path: string): string {
  return execFileSync("cmd.exe", ["/d", "/c", `for %I in ("${path}") do @echo %~sI`], {
    encoding: "utf8",
    windowsVerbatimArguments: true,
  }).trim();
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("nativeRealPath", () => {
  it("returns an existing directory in canonical form, idempotently", () => {
    const dir = tempDir("kb066-real-path-");
    expect(nativeRealPath(dir)).toBe(dir);
    expect(nativeRealPath(nativeRealPath(dir))).toBe(nativeRealPath(dir));
    expect(dir).toBe(realpathSync.native(dir));
  });

  it("re-joins missing trailing components under the nearest existing ancestor", () => {
    const dir = tempDir("kb066-real-path-missing-");
    expect(nativeRealPath(join(dir, "missing", "child"))).toBe(join(dir, "missing", "child"));
  });

  it.runIf(process.platform !== "win32")("resolves a symlinked directory to its target", () => {
    const dir = tempDir("kb066-real-path-link-");
    const target = join(dir, "target");
    mkdirSync(target);
    symlinkSync(target, join(dir, "link"), "dir");
    expect(nativeRealPath(join(dir, "link"))).toBe(target);
    expect(nativeRealPath(join(dir, "link", "missing"))).toBe(join(target, "missing"));
  });

  it.runIf(process.platform === "win32")("strips the win32 namespace prefix", () => {
    const dir = tempDir("kb066-real-path-ns-");
    expect(nativeRealPath(`\\\\?\\${dir}`)).toBe(dir);
  });

  it.runIf(process.platform === "win32")("expands an 8.3 short alias to the long spelling git reports", () => {
    const root = tempDir("kb066-real-path-alias-");
    const long = join(root, "long name with spaces");
    mkdirSync(long);
    const short = win32ShortPath(long);

    expect(nativeRealPath(short)).toBe(nativeRealPath(long));
    expect(nativeRealPath(short)).toBe(long);
    expect(nativeRealPath(join(short, "missing", "child"))).toBe(join(long, "missing", "child"));
    if (short !== long) {
      // The alias exists: JavaScript realpath keeps it, which is exactly why tests need this helper.
      expect(realpathSync(short)).not.toBe(long);
      expect(nativeRealPath(short)).not.toMatch(/~\d/);
    }
  });
});

describe("gitPorcelainPath", () => {
  it("prints separators the way git worktree list --porcelain does", () => {
    expect(gitPorcelainPath("C:\\a\\b")).toBe("C:/a/b");
    expect(gitPorcelainPath("/tmp/a")).toBe("/tmp/a");
  });
});
