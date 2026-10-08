import {execFileSync} from "node:child_process";
import {mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {canonicalizePath, isPathInside, isSamePath, normalizeAbsolutePath, pathIdentityKey, stripWin32NamespacePrefix} from "../fs/path-identity.js";

const win32 = {platform: "win32" as const};
const posix = {platform: "linux" as const};

describe("path identity: win32 semantics", () => {
  it("treats drive, component case, separator and trailing-slash variants as one identity", () => {
    const spellings = [
      "C:\\Work\\Repo\\.fusion\\worktrees\\fn-1",
      "c:\\work\\repo\\.fusion\\worktrees\\fn-1",
      "C:/Work/Repo/.fusion/worktrees/fn-1",
      "C:\\WORK\\Repo\\.fusion\\worktrees\\FN-1\\",
      "C:\\Work\\\\Repo\\.fusion\\worktrees\\fn-1",
    ];
    const keys = new Set(spellings.map((spelling) => pathIdentityKey(spelling, win32)));
    expect(keys.size).toBe(1);
    for (const spelling of spellings) expect(isSamePath(spelling, spellings[0]!, win32)).toBe(true);
  });

  it("strips extended-length and device drive prefixes and the UNC namespace", () => {
    expect(stripWin32NamespacePrefix("\\\\?\\C:\\Work\\x")).toBe("C:\\Work\\x");
    expect(stripWin32NamespacePrefix("//?/C:/Work/x")).toBe("C:/Work/x");
    expect(stripWin32NamespacePrefix("\\\\.\\C:\\Work\\x")).toBe("C:\\Work\\x");
    expect(stripWin32NamespacePrefix("\\\\?\\UNC\\srv\\share\\x")).toBe("\\\\srv\\share\\x");
    expect(stripWin32NamespacePrefix("\\\\.\\pipe\\fusion")).toBe("\\\\.\\pipe\\fusion");
    expect(isSamePath("\\\\?\\C:\\Work\\x", "c:\\work\\X", win32)).toBe(true);
    expect(isSamePath("\\\\?\\UNC\\srv\\share\\x", "\\\\SRV\\share\\x", win32)).toBe(true);
    expect(normalizeAbsolutePath("\\\\?\\C:\\Work\\x", win32)).toBe("C:\\Work\\x");
  });

  it("keeps distinct directories distinct", () => {
    expect(isSamePath("C:\\Work\\fn-1", "C:\\Work\\fn-10", win32)).toBe(false);
    expect(isSamePath("C:\\Work\\fn-1", "D:\\Work\\fn-1", win32)).toBe(false);
  });

  it("decides containment over identity keys", () => {
    expect(isPathInside("C:\\Users\\A\\Fusion", "c:\\users\\a\\fusion\\.worktrees\\fn-1", win32)).toBe(true);
    expect(isPathInside("C:\\Users\\A\\Fusion", "C:\\users\\a\\fusion", win32)).toBe(false);
    expect(isPathInside("C:\\Users\\A\\Fusion", "C:\\users\\a\\fusion", {...win32, allowEqual: true})).toBe(true);
    expect(isPathInside("C:\\Users\\A\\Fusion", "C:\\Users\\A\\Fusion-other\\x", win32)).toBe(false);
    expect(isPathInside("C:\\Users\\A\\Fusion", "C:\\Users\\A\\..foo", win32)).toBe(false);
    expect(isPathInside("C:\\", "c:\\anything", win32)).toBe(true);
    expect(isPathInside("C:\\Work", "D:\\Work\\x", win32)).toBe(false);
  });
});

describe("path identity: POSIX semantics", () => {
  it("is case-sensitive and normalizes only lexical spelling", () => {
    expect(isSamePath("/work/Repo", "/work/repo", posix)).toBe(false);
    expect(isSamePath("/work//repo/", "/work/repo", posix)).toBe(true);
    expect(isPathInside("/work/repo", "/work/repo/.worktrees/fn-1", posix)).toBe(true);
    expect(isPathInside("/work/repo", "/work/repo-2", posix)).toBe(false);
    expect(stripWin32NamespacePrefix("/plain/path")).toBe("/plain/path");
  });
});

describe("path identity: host filesystem", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true}); });
  function fixture(): string {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "fusion-path-identity-")));
    dirs.push(dir);
    return dir;
  }

  it("keeps a stable identity for a path whose final components do not exist", () => {
    const dir = fixture();
    const absent = join(dir, "trees", "fn-1");
    expect(canonicalizePath(absent)).toBe(absent);
    mkdirSync(absent, {recursive: true});
    expect(pathIdentityKey(absent)).toBe(pathIdentityKey(join(dir, "trees", "fn-1")));
  });

  it("resolves junction and symlink aliases of existing and absent paths to the target", () => {
    const dir = fixture();
    const target = join(dir, "real");
    mkdirSync(target);
    const alias = join(dir, "alias");
    symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
    expect(isSamePath(alias, target)).toBe(true);
    expect(isSamePath(join(alias, "absent", "leaf"), join(target, "absent", "leaf"))).toBe(true);
    expect(isPathInside(target, join(alias, "child"))).toBe(true);
  });

  it.skipIf(process.platform !== "win32")("returns on-disk case for case-variant spellings of an existing directory", () => {
    const dir = fixture();
    const existing = join(dir, "MixedCase");
    mkdirSync(existing);
    expect(canonicalizePath(existing.toLowerCase())).toBe(existing);
    expect(canonicalizePath(`\\\\?\\${existing.toUpperCase()}`)).toBe(existing);
    expect(isSamePath(existing.toUpperCase(), existing)).toBe(true);
    expect(isSamePath(join(existing.toLowerCase(), "absent"), join(existing, "ABSENT"))).toBe(true);
  });

  /*
  FNXC:PathIdentity 2026-10-08-10:05:
  KB-066: the GitHub Windows runner's temp is an 8.3 short alias (`RUNNER~1`) while git reports the long name, so a short and a long spelling of one checkout must be one identity, including for absent suffixes under an aliased ancestor.
  Node's `realpathSync.native` is the oracle; the volume may generate no alias, in which case the long-form identities still hold.
  */
  it.runIf(process.platform === "win32")("treats an 8.3 short alias and its long spelling as one identity", () => {
    const dir = fixture();
    const long = join(dir, "long checkout name with spaces");
    mkdirSync(long);
    const short = execFileSync("cmd.exe", ["/d", "/c", `for %I in ("${long}") do @echo %~sI`], {encoding: "utf8", windowsVerbatimArguments: true}).trim();
    const oracle = realpathSync.native(long);

    expect(realpathSync.native(short)).toBe(oracle);
    expect(canonicalizePath(short)).toBe(oracle);
    expect(isSamePath(short, long)).toBe(true);
    expect(pathIdentityKey(short)).toBe(pathIdentityKey(long));
    expect(isPathInside(long, join(short, "missing", "child"))).toBe(true);
    expect(isPathInside(short, join(long, "missing", "child"))).toBe(true);
    expect(canonicalizePath(join(short, "missing"))).toBe(join(oracle, "missing"));
  });

  it.skipIf(process.platform !== "linux")("keeps case variants distinct on a case-sensitive filesystem", () => {
    const dir = fixture();
    mkdirSync(join(dir, "Repo"));
    mkdirSync(join(dir, "repo"));
    expect(isSamePath(join(dir, "Repo"), join(dir, "repo"))).toBe(false);
  });
});
