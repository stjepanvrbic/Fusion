import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  applyStashBySha,
  defaultTaggedStashGitRunner,
  dropStashBySha,
  findStashRefBySha,
  makeUniqueStashLabel,
  pushTaggedStash,
  TaggedStashUnresolvedError,
  type TaggedStashGitRunner,
} from "../merge/tagged-stash.js";

/*
FNXC:WorktreeStashIsolation 2026-10-08-08:29:
Real git: the defect is a property of git's single shared stash reflog across linked worktrees (KB-008), so every scenario runs a primary checkout plus a sibling `git worktree add` that pushes "foreign" entries into the same list.
*/

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString("utf-8").trim();
}

interface StashRow { sha: string; ref: string; subject: string }

function stashRows(cwd: string): StashRow[] {
  const out = git(cwd, ["stash", "list", "--format=%H%x09%gd%x09%gs"]);
  return out.split("\n").filter(Boolean).map((line) => {
    const [sha, ref, subject] = line.split("\t");
    return { sha: sha!, ref: ref!, subject: subject! };
  });
}

function pushForeign(sibling: string, label = "foreign-session"): string {
  writeFileSync(join(sibling, "foreign.txt"), "foreign work\n");
  git(sibling, ["stash", "push", "--include-untracked", "-m", label]);
  return stashRows(sibling).find((r) => r.subject.endsWith(`: ${label}`))!.sha;
}

describe("tagged-stash (real git, shared stash list across worktrees)", () => {
  let root: string;
  let primary: string;
  let sibling: string;

  beforeEach(() => {
    root = mkdtempSync(join(process.env.FUSION_TEST_WORKER_ROOT ?? tmpdir(), "tagged-stash-"));
    primary = join(root, "primary");
    sibling = join(root, "sibling");
    execFileSync("git", ["init", "-b", "main", primary], { stdio: "pipe" });
    git(primary, ["config", "user.email", "test@example.com"]);
    git(primary, ["config", "user.name", "Test"]);
    writeFileSync(join(primary, "file.txt"), "base\n");
    git(primary, ["add", "file.txt"]);
    git(primary, ["commit", "-m", "init"]);
    git(primary, ["worktree", "add", "-b", "sib", sibling]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("(a) applies only its own entry when a sibling pushes a newer foreign entry", async () => {
    writeFileSync(join(primary, "file.txt"), "my edit\n");
    writeFileSync(join(primary, "mydraft.txt"), "draft\n");
    const label = makeUniqueStashLabel("own");
    const handle = await pushTaggedStash(primary, label, { includeUntracked: true });
    expect(handle).not.toBeNull();
    expect(existsSync(join(primary, "mydraft.txt"))).toBe(false);

    const foreignSha = pushForeign(sibling);
    expect(stashRows(primary)[0]!.sha).toBe(foreignSha);

    const result = await applyStashBySha(primary, handle!.sha);
    expect(result).toEqual({ ok: true });
    expect(readFileSync(join(primary, "file.txt"), "utf-8")).toBe("my edit\n");
    expect(readFileSync(join(primary, "mydraft.txt"), "utf-8")).toBe("draft\n");
    expect(existsSync(join(primary, "foreign.txt"))).toBe(false);
    // apply never drops: both entries remain.
    expect(stashRows(primary).map((r) => r.sha).sort()).toEqual([foreignSha, handle!.sha].sort());
  });

  it("(b) drops its own entry by SHA and leaves the foreign entry intact", async () => {
    writeFileSync(join(primary, "file.txt"), "my edit\n");
    const handle = (await pushTaggedStash(primary, makeUniqueStashLabel("own")))!;
    const foreignSha = pushForeign(sibling);
    expect(await findStashRefBySha(primary, handle.sha)).toBe("stash@{1}");

    expect(await dropStashBySha(primary, handle.sha)).toEqual({ dropped: true });
    const rows = stashRows(primary);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sha: foreignSha, ref: "stash@{0}" });
    expect(rows[0]!.subject.endsWith(": foreign-session")).toBe(true);
  });

  it("(c) round-trips untracked-only dirt via --include-untracked", async () => {
    writeFileSync(join(primary, "untracked.txt"), "new file\n");
    const handle = (await pushTaggedStash(primary, makeUniqueStashLabel("own"), { includeUntracked: true }))!;
    expect(existsSync(join(primary, "untracked.txt"))).toBe(false);
    expect(await applyStashBySha(primary, handle.sha)).toEqual({ ok: true });
    expect(readFileSync(join(primary, "untracked.txt"), "utf-8")).toBe("new file\n");
    expect(await dropStashBySha(primary, handle.sha)).toEqual({ dropped: true });
    expect(stashRows(primary)).toHaveLength(0);
  });

  it("(d) returns null for a clean tree", async () => {
    expect(await pushTaggedStash(primary, makeUniqueStashLabel("own"), { includeUntracked: true })).toBeNull();
    expect(stashRows(primary)).toHaveLength(0);
  });

  it("(e) refuses to guess when the label is ambiguous and leaves the list unchanged", async () => {
    const label = "duplicate-label";
    writeFileSync(join(sibling, "a.txt"), "a\n");
    git(sibling, ["stash", "push", "--include-untracked", "-m", label]);
    writeFileSync(join(primary, "file.txt"), "my edit\n");

    await expect(pushTaggedStash(primary, label)).rejects.toBeInstanceOf(TaggedStashUnresolvedError);
    const rows = stashRows(primary);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.subject.endsWith(`: ${label}`))).toBe(true);
  });

  it("(f) treats an already-dropped SHA as dropped without touching other entries", async () => {
    writeFileSync(join(primary, "file.txt"), "my edit\n");
    const handle = (await pushTaggedStash(primary, makeUniqueStashLabel("own")))!;
    git(primary, ["stash", "drop", "stash@{0}"]);
    const foreignSha = pushForeign(sibling);

    expect(await dropStashBySha(primary, handle.sha)).toEqual({ dropped: true });
    expect(stashRows(primary).map((r) => r.sha)).toEqual([foreignSha]);
  });

  it("(g) re-stores a foreign entry dropped in the verify-then-drop window and then drops its own", async () => {
    writeFileSync(join(primary, "file.txt"), "my edit\n");
    const handle = (await pushTaggedStash(primary, makeUniqueStashLabel("own")))!;
    let foreignSha = "";
    // Interleave: the sibling pushes right after our rev-parse verification and
    // immediately before our first positional drop, so `stash@{0}` is foreign.
    const runner: TaggedStashGitRunner = async (cwd, args, timeoutMs) => {
      if (args[0] === "stash" && args[1] === "drop" && !foreignSha) foreignSha = pushForeign(sibling);
      return defaultTaggedStashGitRunner(cwd, args, timeoutMs);
    };
    const warnings: string[] = [];

    const result = await dropStashBySha(primary, handle.sha, { runner, log: { warn: (m) => warnings.push(m) } });

    expect(result).toEqual({ dropped: true });
    const rows = stashRows(primary);
    expect(rows.map((r) => r.sha)).toEqual([foreignSha]);
    expect(rows[0]!.subject.endsWith(": foreign-session")).toBe(true);
    expect(warnings.some((w) => w.includes(foreignSha.slice(0, 7)) && w.includes("re-stored"))).toBe(true);
    // The foreign entry is still recoverable by SHA in the sibling worktree.
    git(sibling, ["stash", "apply", foreignSha]);
    expect(readFileSync(join(sibling, "foreign.txt"), "utf-8")).toBe("foreign work\n");
  });
});
