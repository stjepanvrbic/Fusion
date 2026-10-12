import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { captureSingleCommitLandedMetadata } from "../merger.js";

/*
FNXC:LandedCommitMetadata 2026-10-11-22:56:
The landed-commit summary reads launch git directly with an argument list; neither goes through a shell.
The mock passes every launch through to real git and records it. The merger wraps `exec` and `execFile` with `promisify`, so each spy carries a promise-form twin under `promisify.custom`: without it the wrapped call would resolve a bare string instead of `{ stdout, stderr }` and the function under test would break for a reason unrelated to its launch path.
*/
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const util = await import("node:util");
  const exec = Object.assign(vi.fn(actual.exec), { [util.promisify.custom]: vi.fn(util.promisify(actual.exec)) });
  const execFile = Object.assign(vi.fn(actual.execFile), { [util.promisify.custom]: vi.fn(util.promisify(actual.execFile)) });
  return { ...actual, exec, execFile };
});

type Spy = ReturnType<typeof vi.fn>;
const promiseForm = (launcher: unknown): Spy => (launcher as Record<symbol, Spy>)[promisify.custom];

const execSpy = childProcess.exec as unknown as Spy;
const execPromiseSpy = promiseForm(childProcess.exec);
const execFileSpy = childProcess.execFile as unknown as Spy;
const execFilePromiseSpy = promiseForm(childProcess.execFile);

const LANDED_READ_TIMEOUT_MS = 120000;
const LANDED_READ_MAX_BUFFER = 2097152;

function git(repo: string, args: string[]): string {
  return childProcess.execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

describe("captureSingleCommitLandedMetadata (real git)", () => {
  const repos: string[] = [];

  function setupRepo(): string {
    const repo = mkdtempSync(path.join(os.tmpdir(), "fn-landed-metadata-"));
    repos.push(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    git(repo, ["config", "core.autocrlf", "false"]);
    mkdirSync(path.join(repo, "dir"), { recursive: true });
    writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n", "utf-8");
    writeFileSync(path.join(repo, "dir", "b.txt"), "removed later\n", "utf-8");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);
    return repo;
  }

  /** Lands one commit that modifies a file, deletes a file and adds a file whose name contains a space. */
  function landCommit(repo: string): string {
    writeFileSync(path.join(repo, "a.txt"), "one\nchanged\n", "utf-8");
    rmSync(path.join(repo, "dir", "b.txt"));
    writeFileSync(path.join(repo, "dir", "with space.txt"), "first\nsecond\n", "utf-8");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "landed"]);
    return git(repo, ["rev-parse", "HEAD"]);
  }

  /** The commit's totals read through a different git format than the function under test uses. */
  function numstatTotals(repo: string, sha: string): { filesChanged: number; insertions: number; deletions: number } {
    const rows = git(repo, ["show", "--numstat", "--format=", sha]).split(/\r?\n/).filter(Boolean).map((row) => row.split("\t"));
    return {
      filesChanged: rows.length,
      insertions: rows.reduce((sum, row) => sum + Number(row[0]), 0),
      deletions: rows.reduce((sum, row) => sum + Number(row[1]), 0),
    };
  }

  beforeEach(() => {
    for (const spy of [execSpy, execPromiseSpy, execFileSpy, execFilePromiseSpy]) spy.mockClear();
  });

  /*
  FNXC:LandedCommitMetadata 2026-10-11-22:56:
  The two reads run in parallel and the function rejects as soon as one fails, so its sibling can still be running when a case ends.
  A process whose working directory is the repository keeps Windows from deleting it, so cleanup first waits for every launch the function started to exit.
  */
  afterEach(async () => {
    const launches = [...execFilePromiseSpy.mock.results, ...execPromiseSpy.mock.results].map((result) => result.value);
    await Promise.allSettled(launches);
    for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
  });

  it("returns the changed paths and the commit's real totals, including a file name with a space", async () => {
    const repo = setupRepo();
    const sha = landCommit(repo);

    const metadata = await captureSingleCommitLandedMetadata(repo, sha);

    expect(metadata.landedFiles).toEqual(["a.txt", "dir/b.txt", "dir/with space.txt"]);
    expect({ filesChanged: metadata.filesChanged, insertions: metadata.insertions, deletions: metadata.deletions })
      .toEqual({ filesChanged: 3, insertions: 3, deletions: 2 });
    expect({ filesChanged: metadata.filesChanged, insertions: metadata.insertions, deletions: metadata.deletions })
      .toEqual(numstatTotals(repo, sha));
  });

  it("rejects for a commit the repository does not have", async () => {
    const repo = setupRepo();

    await expect(captureSingleCommitLandedMetadata(repo, "0123456789abcdef0123456789abcdef01234567")).rejects.toThrow();
  });

  it("launches both reads as git argument lists with an explicit directory, timeout and output bound, and no shell", async () => {
    const repo = setupRepo();
    const sha = landCommit(repo);
    for (const spy of [execSpy, execPromiseSpy, execFileSpy, execFilePromiseSpy]) spy.mockClear();

    await captureSingleCommitLandedMetadata(repo, sha);

    const options = { cwd: repo, encoding: "utf-8", timeout: LANDED_READ_TIMEOUT_MS, maxBuffer: LANDED_READ_MAX_BUFFER };
    const launches = [...execFilePromiseSpy.mock.calls].sort((left, right) => String(left[1]).localeCompare(String(right[1])));
    expect(launches).toEqual([
      ["git", ["show", "--name-only", "--format=", sha], options],
      ["git", ["show", "--shortstat", "--format=", sha], options],
    ]);
    const shellCommands = [...execSpy.mock.calls, ...execPromiseSpy.mock.calls].map((call) => String(call[0]));
    expect(shellCommands.filter((command) => command.includes("show"))).toEqual([]);
  });
});
