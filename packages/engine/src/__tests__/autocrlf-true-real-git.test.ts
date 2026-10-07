import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitFixtureSync } from "../../../core/src/__test-utils__/git-fixture";
import { captureUncommittedModifiedFiles } from "../executor/worktree-capture-modified-files.js";

/*
FNXC:TestInfraWindows 2026-10-07-18:04:
The shared setup pins core.autocrlf=false for every git child on Windows so byte-level fixtures match Linux CI, which also hides the operator's real setting from product code under test.
Git for Windows defaults to core.autocrlf=true. This real-git test re-enables it for its own git processes and proves product dirty-file detection treats a line-ending-only checkout as clean while still reporting a real edit.
*/
const roots: string[] = [];
let savedGitConfig: Record<string, string | undefined>;

beforeEach(() => {
  savedGitConfig = Object.fromEntries(
    Object.keys(process.env).filter((key) => key.startsWith("GIT_CONFIG_")).map((key) => [key, process.env[key]]),
  );
  // Later GIT_CONFIG_* entries win, so this overrides the setup pin for every git child, product included.
  const count = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  process.env[`GIT_CONFIG_KEY_${count}`] = "core.autocrlf";
  process.env[`GIT_CONFIG_VALUE_${count}`] = "true";
  process.env.GIT_CONFIG_COUNT = String(count + 1);
});

afterEach(() => {
  for (const key of Object.keys(process.env).filter((name) => name.startsWith("GIT_CONFIG_"))) delete process.env[key];
  for (const [key, value] of Object.entries(savedGitConfig)) if (value !== undefined) process.env[key] = value;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repoWithCrlfCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), "fusion-autocrlf-true-"));
  roots.push(root);
  gitFixtureSync(root, ["init", "-b", "main"]);
  gitFixtureSync(root, ["config", "user.email", "test@example.com"]);
  gitFixtureSync(root, ["config", "user.name", "Test User"]);
  writeFileSync(join(root, "note.txt"), "first\nsecond\n");
  gitFixtureSync(root, ["add", "note.txt"]);
  gitFixtureSync(root, ["commit", "-m", "base"]);
  unlinkSync(join(root, "note.txt"));
  gitFixtureSync(root, ["checkout", "--", "note.txt"]);
  return root;
}

describe("product git seams under core.autocrlf=true", () => {
  it("checks the fixture out with CRLF line endings", () => {
    const root = repoWithCrlfCheckout();
    expect(gitFixtureSync(root, ["config", "core.autocrlf"])).toBe("true");
    expect(readFileSync(join(root, "note.txt"), "utf8")).toBe("first\r\nsecond\r\n");
  });

  it("treats a line-ending-only checkout as clean and still reports a real edit", async () => {
    const root = repoWithCrlfCheckout();
    expect(await captureUncommittedModifiedFiles(root)).toEqual([]);

    writeFileSync(join(root, "note.txt"), "first\r\nchanged\r\n");
    expect(await captureUncommittedModifiedFiles(root)).toEqual(["note.txt"]);
  });
});
