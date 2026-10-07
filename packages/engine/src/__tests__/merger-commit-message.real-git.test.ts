import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "@fusion/core";
import { commitOrAmendMergeWithFixes } from "../merger.js";

/*
FNXC:MergeCommitMessage 2026-10-07-18:40:
Every merger-authored squash or amend commit must carry its whole multi-line body, its Fusion-Task-Id trailer and its
co-author trailer, on Windows as well as POSIX. A shell-built `-m "<body>"` was cut at the first newline by cmd.exe and
its backslash escaping corrupted `$`, backticks and quotes. This drives the real finalizer against a real repository.
*/
const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

const AUTHOR = "Co-authored-by: Fusion <noreply@runfusion.ai>";
const AI_BODY = [
  "- kept bullet one",
  "- kept bullet two with $HOME, `backticks`, \"quotes\" and a \\ backslash",
  "- kept bullet three",
].join("\n");

function finalize(dir: string, preAttemptHeadSha: string) {
  return commitOrAmendMergeWithFixes(
    dir, "FN-MSG", "task", "- feat: task commit", true, preAttemptHeadSha, AUTHOR, "1 file changed",
    { ...DEFAULT_SETTINGS, commitAuthorEnabled: true }, undefined,
    "Narrative summary line.", AI_BODY, "carry the whole message", new Set<string>(),
  );
}

function expectFullMessage(dir: string) {
  const message = git(dir, "log", "-1", "--format=%B");
  expect(message.split("\n")[0]).toBe("feat(FN-MSG): carry the whole message");
  expect(message).toContain("Narrative summary line.");
  expect(message).toContain(AI_BODY);
  expect(git(dir, "log", "-1", "--format=%(trailers:key=Fusion-Task-Id,valueonly)")).toBe("FN-MSG");
  expect(git(dir, "log", "-1", "--format=%(trailers:key=Co-authored-by,valueonly)")).toBe("Fusion <noreply@runfusion.ai>");
}

describe("merger commit message delivery", () => {
  let dir: string;

  beforeEach(() => {
    const parent = process.env.FUSION_TEST_WORKER_ROOT ?? tmpdir();
    mkdirSync(parent, { recursive: true });
    dir = mkdtempSync(join(parent, "fusion-test-merger-msg-"));
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "test@example.com");
    git(dir, "config", "user.name", "Test");
    git(dir, "config", "commit.gpgsign", "false");
    writeFileSync(join(dir, "README.md"), "# repo\n");
    git(dir, "add", "README.md");
    git(dir, "commit", "-q", "-m", "chore: initial");
    git(dir, "checkout", "-q", "-b", "task");
    writeFileSync(join(dir, "feature.txt"), "feature\n");
    git(dir, "add", "feature.txt");
    git(dir, "commit", "-q", "-m", "feat: task commit");
    git(dir, "checkout", "-q", "main");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates a fresh squash commit with the full body and recognized trailers", async () => {
    const preAttemptHeadSha = git(dir, "rev-parse", "HEAD");
    git(dir, "merge", "--squash", "task");

    await expect(finalize(dir, preAttemptHeadSha)).resolves.toMatchObject({ ok: true, reason: "committed" });

    expect(git(dir, "rev-parse", "HEAD~1")).toBe(preAttemptHeadSha);
    expectFullMessage(dir);
  });

  it("amends an agent-authored commit with the full body and recognized trailers", async () => {
    const preAttemptHeadSha = git(dir, "rev-parse", "HEAD");
    git(dir, "merge", "--squash", "task");
    git(dir, "commit", "-q", "-m", "agent wrote this");

    await expect(finalize(dir, preAttemptHeadSha)).resolves.toMatchObject({ ok: true });

    expect(git(dir, "rev-parse", "HEAD~1")).toBe(preAttemptHeadSha);
    expectFullMessage(dir);
  });
});
