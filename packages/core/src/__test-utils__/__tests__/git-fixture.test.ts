import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitFixture, gitFixtureSync } from "../git-fixture";

/*
FNXC:TestInfraWindows 2026-10-07-18:04:
Fixture git commands written as shell strings (`git commit -m 'chore: base'`, `&&` chains) fail under cmd.exe, and rerouting async exec through bash would hide product bugs on the same seam.
The shared fixture helper passes argv straight to git with no shell, so quoting, spaces and shell metacharacters reach git verbatim on every platform.
*/
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "fusion-git-fixture-"));
  roots.push(root);
  gitFixtureSync(root, ["init", "-b", "main"]);
  gitFixtureSync(root, ["config", "user.email", "test@example.com"]);
  gitFixtureSync(root, ["config", "user.name", "Test User"]);
  return root;
}

describe("git fixture helper", () => {
  const message = `chore: it's "quoted" && $(not expanded) | ^{tree} %PATH%`;

  it("passes argv to git verbatim without a shell, synchronously", () => {
    const root = repo();
    writeFileSync(join(root, "note.txt"), "base\n");
    gitFixtureSync(root, ["add", "note.txt"]);
    gitFixtureSync(root, ["commit", "-m", message]);

    expect(gitFixtureSync(root, ["log", "-1", "--format=%s"])).toBe(message);
    expect(gitFixtureSync(root, ["rev-parse", "HEAD^{tree}"])).toMatch(/^[0-9a-f]{40}$/);
  });

  it("passes argv to git verbatim without a shell, asynchronously", async () => {
    const root = repo();
    writeFileSync(join(root, "note.txt"), "base\n");
    await gitFixture(root, ["add", "note.txt"]);
    await gitFixture(root, ["commit", "-m", message]);

    expect(await gitFixture(root, ["log", "-1", "--format=%s"])).toBe(message);
  });

  it("rejects with git's stderr when a command fails", async () => {
    const root = repo();
    await expect(gitFixture(root, ["rev-parse", "--verify", "does-not-exist"])).rejects.toThrow(/does-not-exist|Needed a single revision/);
    expect(() => gitFixtureSync(root, ["rev-parse", "--verify", "does-not-exist"])).toThrow(/does-not-exist|Needed a single revision/);
  });
});
