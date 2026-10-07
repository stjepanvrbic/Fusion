import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/*
FNXC:TestInfraWindows 2026-10-07-15:30:
Test git fixtures are written in POSIX shell (single-quoted messages, `VAR=value cmd` prefixes, `&&` chains).
Under cmd.exe on Windows those fail before the test body runs, which made ~100 engine tests fail for environment reasons only.
*/
describe("vitest-setup execSync shell", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it("runs POSIX-shell fixture commands (quoted messages, env prefixes, && chains) on every platform", () => {
    const repo = mkdtempSync(join(tmpdir(), "fusion-posix-shell-"));
    dirs.push(repo);
    execSync("git init -q && git config user.email t@example.com && git config user.name 'Test User'", { cwd: repo });
    execSync("GIT_AUTHOR_DATE='2000-01-01T00:00:00Z' GIT_COMMITTER_DATE='2000-01-01T00:00:00Z' git commit -q --allow-empty -m 'feat: quoted message'", { cwd: repo });
    expect(execSync("git log -1 --format=%s", { cwd: repo, encoding: "utf8" }).trim()).toBe("feat: quoted message");
    expect(execSync("git log -1 --format=%ad --date=iso-strict", { cwd: repo, encoding: "utf8" }).trim()).toMatch(/^2000-01-01T00:00:00/);
  });

  it("keeps native Windows paths intact for commands without POSIX-only syntax", () => {
    const repo = mkdtempSync(join(tmpdir(), "fusion-native-path-"));
    const remote = mkdtempSync(join(tmpdir(), "fusion-native-remote-"));
    dirs.push(repo, remote);
    execSync("git init -q", { cwd: repo });
    execSync(`git remote add origin ${remote}`, { cwd: repo });
    expect(execSync("git remote get-url origin", { cwd: repo, encoding: "utf8" }).trim()).toBe(remote);
  });

  it("checks fixture files out with LF regardless of the machine's autocrlf", () => {
    const repo = mkdtempSync(join(tmpdir(), "fusion-eol-"));
    dirs.push(repo);
    execSync("git init -q && git config user.email t@example.com && git config user.name 'Test User'", { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "line one\nline two\n");
    execSync("git add a.txt && git commit -q -m 'add a'", { cwd: repo });
    rmSync(join(repo, "a.txt"));
    execSync("git checkout -- a.txt", { cwd: repo });
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("line one\nline two\n");
  });

  it("keeps an explicitly chosen shell", () => {
    if (process.platform !== "win32") return;
    expect(execSync("echo %OS%", { shell: "cmd.exe", encoding: "utf8" }).trim()).toBe("Windows_NT");
  });
});
