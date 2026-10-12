import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectIntegrationBranch } from "@fusion/core";

const { execMock, execFileMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  execFileMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  exec: execMock,
  execFile: execFileMock,
}));

import {
  __resetIntegrationBranchCacheForTests,
  INTEGRATION_BRANCH_FALLBACK,
  resolveIntegrationBranch,
} from "../merge/integration-branch.js";

const ORIGIN_HEAD = ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"];
const LOCAL_BRANCHES = ["for-each-ref", "--format=%(refname:short)", "refs/heads/"];
const CURRENT_HEAD = ["symbolic-ref", "--quiet", "--short", "HEAD"];
const ORIGIN_BRANCHES = ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/"];
const REMOTES = ["remote"];

const TIMEOUT_MS = 5000;
const MAX_BUFFER = 1048576;

type GitAnswer = string | Error;
type GitResponder = (args: string[]) => GitAnswer;
type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;
type ShellCallback = (error: Error | null, stdout: string, stderr: string) => void;

const key = (args: readonly string[]): string => args.join(" ");

/** Answers by argument list; an argument list without an entry fails like a git read that found nothing. */
function byArgs(answers: Record<string, GitAnswer>): GitResponder {
  return (args) => answers[key(args)] ?? new Error(`git ${key(args)} failed`);
}

function answerAsync(respond: GitResponder): void {
  execFileMock.mockImplementation((_file: string, args: string[], _opts: object, callback: ExecFileCallback) => {
    const answer = respond(args);
    if (answer instanceof Error) callback(answer, "", "");
    else callback(null, answer, "");
    return {};
  });
}

const launchedArgs = (mock: typeof execFileMock): string[][] => mock.mock.calls.map((call) => call[1] as string[]);

describe("integration-branch resolver", () => {
  beforeEach(() => {
    __resetIntegrationBranchCacheForTests();
    execMock.mockReset();
    execFileMock.mockReset();
    /*
    FNXC:IntegrationBranchReadiness 2026-10-12-02:45:
    Branch resolution launches git without a shell, so the shell launcher answers with a failure instead of staying silent.
    A resolver that reached it would then return its fallback and fail the case's assertion, instead of waiting on a callback that never comes.
    */
    execMock.mockImplementation((_command: string, _opts: object, callback: ShellCallback) => {
      callback(new Error("exec must not be reached"), "", "");
      return {};
    });
  });

  afterEach(() => {
    expect(execMock).not.toHaveBeenCalled();
    __resetIntegrationBranchCacheForTests();
    vi.restoreAllMocks();
  });

  it("integrationBranch override wins over baseBranch and origin/HEAD", async () => {
    const settings = { integrationBranch: " trunk ", baseBranch: "develop" } as any;

    expect(await resolveIntegrationBranch("/repo", settings)).toBe("trunk");

    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("baseBranch wins over origin/HEAD", async () => {
    const settings = { baseBranch: " develop " } as any;

    expect(await resolveIntegrationBranch("/repo", settings)).toBe("develop");

    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("strips refs/remotes/origin and origin prefixes", async () => {
    execFileMock.mockImplementationOnce((_file: string, _args: string[], _opts: object, callback: ExecFileCallback) => {
      callback(null, "refs/remotes/origin/master\n", "");
      return {};
    });
    execFileMock.mockImplementationOnce((_file: string, _args: string[], _opts: object, callback: ExecFileCallback) => {
      callback(null, "origin/develop\n", "");
      return {};
    });

    const first = await resolveIntegrationBranch("/repo-a", {} as any);
    const second = await resolveIntegrationBranch("/repo-b", {} as any);

    expect(first).toBe("master");
    expect(second).toBe("develop");
  });

  it("treats whitespace and empty settings as unset", async () => {
    answerAsync(() => "origin/master\n");

    const resolved = await resolveIntegrationBranch("/repo", { integrationBranch: "   ", baseBranch: "" } as any);

    expect(resolved).toBe("master");
  });

  it("reads origin/HEAD with one shell-free git launch and stops there when it is set", async () => {
    answerAsync(byArgs({ [key(ORIGIN_HEAD)]: "origin/release\n" }));

    await expect(resolveIntegrationBranch("/repo", undefined)).resolves.toBe("release");

    expect(execFileMock.mock.calls).toEqual([
      ["git", ORIGIN_HEAD, { cwd: "/repo", encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER }, expect.any(Function)],
    ]);
  });

  it("launches the inference reads as argument lists with explicit bounds, then lists remotes when nothing is inferred", async () => {
    answerAsync(byArgs({ [key(LOCAL_BRANCHES)]: "", [key(ORIGIN_BRANCHES)]: "", [key(REMOTES)]: "" }));

    await expect(resolveIntegrationBranch("/repo", undefined, { logger: { warn: vi.fn() } })).resolves.toBe(INTEGRATION_BRANCH_FALLBACK);

    const launched = launchedArgs(execFileMock);
    expect(launched).toHaveLength(5);
    expect(launched[0]).toEqual(ORIGIN_HEAD);
    expect(launched.slice(1, 4)).toEqual(expect.arrayContaining([LOCAL_BRANCHES, CURRENT_HEAD, ORIGIN_BRANCHES]));
    expect(launched[4]).toEqual(REMOTES);
    for (const call of execFileMock.mock.calls) {
      expect(call[0]).toBe("git");
      expect(call[2]).toEqual({ cwd: "/repo", encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER });
    }
  });

  it("does not list remotes when a branch is inferred", async () => {
    answerAsync(byArgs({ [key(LOCAL_BRANCHES)]: "develop\n", [key(CURRENT_HEAD)]: "develop\n", [key(ORIGIN_BRANCHES)]: "" }));

    await expect(resolveIntegrationBranch("/repo", undefined, { logger: { warn: vi.fn() } })).resolves.toBe("develop");

    const launched = launchedArgs(execFileMock);
    expect(launched).toHaveLength(4);
    expect(launched[0]).toEqual(ORIGIN_HEAD);
    expect(launched.slice(1)).toEqual(expect.arrayContaining([LOCAL_BRANCHES, CURRENT_HEAD, ORIGIN_BRANCHES]));
  });

  it("passes each ref prefix as one argument beside an unquoted format argument", async () => {
    answerAsync(byArgs({ [key(LOCAL_BRANCHES)]: "", [key(ORIGIN_BRANCHES)]: "" }));

    await resolveIntegrationBranch("/repo", undefined, { logger: { warn: vi.fn() } });

    const listings = launchedArgs(execFileMock).filter((args) => args[0] === "for-each-ref");
    expect(listings).toHaveLength(2);
    for (const args of listings) {
      expect(args).toHaveLength(3);
      expect(args[1]).toBe("--format=%(refname:short)");
    }
    expect(listings.map((args) => args[2]).sort()).toEqual(["refs/heads/", "refs/remotes/origin/"]);
  });

  it("falls back to main and warns once per rootDir", async () => {
    answerAsync(() => new Error("no symbolic ref"));
    const warn = vi.fn();

    const first = await resolveIntegrationBranch("/repo", undefined, { logger: { warn } });
    const second = await resolveIntegrationBranch("/repo", undefined, { logger: { warn } });

    expect(first).toBe(INTEGRATION_BRANCH_FALLBACK);
    expect(second).toBe(INTEGRATION_BRANCH_FALLBACK);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("origin/HEAD unset and no project override"));
  });

  it("falls back to main with actionable guidance when origin is absent but gitlab remote exists", async () => {
    answerAsync(byArgs({
      [key(LOCAL_BRANCHES)]: "",
      [key(CURRENT_HEAD)]: "",
      [key(ORIGIN_BRANCHES)]: "",
      [key(REMOTES)]: "gitlab\n",
    }));
    const warn = vi.fn();

    const resolved = await resolveIntegrationBranch("/repo", undefined, { logger: { warn } });

    expect(resolved).toBe(INTEGRATION_BRANCH_FALLBACK);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("auto-detect checks origin/HEAD");
    expect(warn.mock.calls[0]?.[0]).toContain("origin is absent");
    expect(warn.mock.calls[0]?.[0]).toContain("found remote gitlab");
    expect(warn.mock.calls[0]?.[0]).toContain("set integrationBranch manually");
  });

  it("warns once per rootDir when origin exists but has no HEAD", async () => {
    answerAsync(byArgs({
      [key(LOCAL_BRANCHES)]: "",
      [key(CURRENT_HEAD)]: "",
      [key(ORIGIN_BRANCHES)]: "",
      [key(REMOTES)]: "origin\ngitlab\norigin\n",
    }));
    const warn = vi.fn();

    await expect(resolveIntegrationBranch("/repo", undefined, { logger: { warn } })).resolves.toBe(INTEGRATION_BRANCH_FALLBACK);
    await expect(resolveIntegrationBranch("/repo", undefined, { logger: { warn } })).resolves.toBe(INTEGRATION_BRANCH_FALLBACK);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("origin/HEAD is unset");
    expect(warn.mock.calls[0]?.[0]).toContain("found remote origin, gitlab");
  });

  it("adopts the only local master branch instead of naming main", async () => {
    answerAsync(byArgs({
      [key(LOCAL_BRANCHES)]: "master\n",
      [key(CURRENT_HEAD)]: "master\n",
      [key(ORIGIN_BRANCHES)]: "",
      [key(REMOTES)]: "",
    }));
    const warn = vi.fn();

    await expect(resolveIntegrationBranch("/master-only", undefined, { logger: { warn } })).resolves.toBe("master");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("'master'"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("well-known-local"));
  });

  it("prefers a well-known local branch when multiple local branches exist", async () => {
    answerAsync(byArgs({
      [key(LOCAL_BRANCHES)]: "develop\nmain\n",
      [key(CURRENT_HEAD)]: "develop\n",
      [key(ORIGIN_BRANCHES)]: "",
      [key(REMOTES)]: "",
    }));

    await expect(resolveIntegrationBranch("/multiple-local", undefined, { logger: { warn: vi.fn() } })).resolves.toBe("main");
  });

  it("adopts an unambiguous remote-only branch", async () => {
    answerAsync(byArgs({
      [key(LOCAL_BRANCHES)]: "",
      [key(ORIGIN_BRANCHES)]: "origin/develop\n",
      [key(REMOTES)]: "",
    }));

    await expect(resolveIntegrationBranch("/remote-only", undefined, { logger: { warn: vi.fn() } })).resolves.toBe("develop");
  });

  it("drops origin's HEAD entry from the remote-tracking list", async () => {
    answerAsync(byArgs({
      [key(LOCAL_BRANCHES)]: "",
      [key(ORIGIN_BRANCHES)]: "origin/HEAD\norigin/develop\n",
      [key(REMOTES)]: "",
    }));

    await expect(resolveIntegrationBranch("/remote-head", undefined, { logger: { warn: vi.fn() } })).resolves.toBe("develop");
  });

  it("falls back when every inferred branch is a Fusion sibling", async () => {
    answerAsync(byArgs({
      [key(LOCAL_BRANCHES)]: "fusion/fn-123\n",
      [key(ORIGIN_BRANCHES)]: "origin/fusion/fn-456\n",
      [key(REMOTES)]: "",
    }));

    await expect(resolveIntegrationBranch("/fusion-only", undefined, { logger: { warn: vi.fn() } })).resolves.toBe(INTEGRATION_BRANCH_FALLBACK);
  });

  it("resolves inference to the branch the shared selector picks", async () => {
    answerAsync(byArgs({
      [key(LOCAL_BRANCHES)]: "",
      [key(ORIGIN_BRANCHES)]: "origin/develop\n",
      [key(REMOTES)]: "",
    }));
    const expected = selectIntegrationBranch({
      localBranches: [],
      currentBranch: "",
      remoteBranches: ["develop"],
    });

    const resolved = await resolveIntegrationBranch("/parity", undefined, { logger: { warn: vi.fn() } });

    expect(expected).toEqual({ branch: "develop", source: "remote-tracking" });
    expect(resolved).toBe(expected?.branch);
  });

  it("swallows git failures and does not throw", async () => {
    answerAsync(() => new Error("git failed"));
    const warn = vi.fn();

    await expect(resolveIntegrationBranch("/repo", undefined, { logger: { warn } })).resolves.toBe(INTEGRATION_BRANCH_FALLBACK);

    expect(launchedArgs(execFileMock)).toHaveLength(5);
  });
});
