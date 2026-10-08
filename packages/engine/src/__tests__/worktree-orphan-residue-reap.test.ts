/*
FNXC:WorktreeOrphanReap 2026-10-07-15:11:
A removal that failed on a locked file leaves a `.git`-less, unregistered folder. Once its task pointer
is cleared nothing ever reclaimed it, because every orphan sweep required `.git` to prove ownership.
The startup reaper now reclaims such residue only when ownership and abandonment are proven without
git: it sits directly under a worktrees root inside the project, has no `.git`, is not registered, is
old enough not to be a checkout mid-creation, carries no secret material, and NO task row (any column,
archived, or soft-deleted) references it. Real filesystem and real git; the store is a double.

FNXC:WorktreeOrphanReap 2026-10-07-19:23:
Abandonment is not disposability: the folder must also carry the marker a deletion-authorized removal wrote when it could not finish.
The fixture marks residue by default so each guard below is tested on its own; the unmarked cases prove preservation.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reapOrphanWorktrees, ORPHAN_RESIDUE_MIN_AGE_MS } from "../worktree/worktree-pool.js";
import { CHECKOUT_REMOVAL_RESIDUE_MARKER } from "../worktree/remove-checkout.js";
import { activeSessionRegistry } from "../agents/active-session-registry.js";

const tracked: string[] = [];

afterEach(() => {
  activeSessionRegistry.clear();
  for (const dir of tracked.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
  }
});

function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fusion-residue-reap-")));
  tracked.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, stdio: "pipe" });
  return root;
}

/** A half-deleted checkout: files left behind, no `.git`, aged past the creation window, marked by the removal unless `marked` is false. */
function residue(root: string, name = "fn-x", ageMs = ORPHAN_RESIDUE_MIN_AGE_MS + 60_000, marked = true): string {
  const dir = join(root, ".fusion", "worktrees", name);
  mkdirSync(join(dir, "locked"), { recursive: true });
  writeFileSync(join(dir, "locked", "file.txt"), "left behind\n");
  if (marked) writeFileSync(join(dir, CHECKOUT_REMOVAL_RESIDUE_MARKER), "{}\n");
  const when = new Date(Date.now() - ageMs);
  utimesSync(dir, when, when);
  return dir;
}

function store(tasks: unknown[] = []) {
  return { listTasks: vi.fn(async () => tasks) };
}

describe("reapOrphanWorktrees reclaims unreferenced checkout residue", () => {
  it("removes an aged .git-less folder that no task references, consulting archived and deleted rows", async () => {
    const root = project();
    const dir = residue(root);
    const tasks = store([{ id: "FN-OTHER", column: "archived", worktree: join(root, ".fusion", "worktrees", "fn-other") }]);

    await expect(reapOrphanWorktrees(root, {}, { store: tasks })).resolves.toBe(1);

    expect(existsSync(dir)).toBe(false);
    expect(tasks.listTasks).toHaveBeenCalledWith(expect.objectContaining({ includeArchived: true, includeDeleted: true }));
  });

  it("preserves an aged unreferenced .git-less folder that no deletion-authorized removal marked", async () => {
    const root = project();
    const dir = residue(root, "fn-x", ORPHAN_RESIDUE_MIN_AGE_MS + 60_000, false);

    await expect(reapOrphanWorktrees(root, {}, { store: store() })).resolves.toBe(0);
    expect(existsSync(join(dir, "locked", "file.txt"))).toBe(true);
  });

  it.each([
    ["unmarked", false, 0],
    ["marked", true, 1],
  ] as const)("treats a %s dangling-gitdir folder by its removal marker", async (_label, marked, expected) => {
    const root = project();
    const dir = residue(root, "fn-dangling", ORPHAN_RESIDUE_MIN_AGE_MS + 60_000, marked);
    writeFileSync(join(dir, ".git"), `gitdir: ${join(root, ".git", "worktrees", "fn-dangling")}\n`);

    await expect(reapOrphanWorktrees(root, {}, { store: store() })).resolves.toBe(expected);
    expect(existsSync(join(dir, "locked", "file.txt"))).toBe(!marked);
  });

  it.each([
    ["a live task pointer", (dir: string) => [{ id: "FN-X", column: "todo", worktree: dir }]],
    ["a soft-deleted task pointer", (dir: string) => [{ id: "FN-X", column: "done", deletedAt: "2026-10-01T00:00:00Z", worktree: dir }]],
    ["a workspace member pointer", (dir: string) => [{ id: "FN-X", column: "in-review", workspaceWorktrees: { "repo-a": { worktreePath: dir } } }]],
  ])("keeps residue referenced by %s", async (_label, tasksFor) => {
    const root = project();
    const dir = residue(root);

    await expect(reapOrphanWorktrees(root, {}, { store: store(tasksFor(dir)) })).resolves.toBe(0);
    expect(existsSync(join(dir, "locked", "file.txt"))).toBe(true);
  });

  it("keeps residue younger than the creation window", async () => {
    const root = project();
    const dir = residue(root, "fn-x", 1_000);

    await expect(reapOrphanWorktrees(root, {}, { store: store() })).resolves.toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it("fails closed without a task store or when the store cannot be read", async () => {
    const root = project();
    const dir = residue(root);

    await expect(reapOrphanWorktrees(root, {})).resolves.toBe(0);
    await expect(reapOrphanWorktrees(root, {}, { store: { listTasks: vi.fn(async () => { throw new Error("db down"); }) } })).resolves.toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it("keeps residue that holds secret material or is bound to a live session", async () => {
    const root = project();
    const secret = residue(root, "fn-secret");
    writeFileSync(join(secret, ".env"), "TOKEN=x\n");
    const live = residue(root, "fn-live");
    activeSessionRegistry.registerPath(live, { taskId: "FN-LIVE", kind: "executor", ownerKey: "executor:FN-LIVE" });

    await expect(reapOrphanWorktrees(root, {}, { store: store() })).resolves.toBe(0);
    expect(existsSync(join(secret, ".env"))).toBe(true);
    expect(existsSync(live)).toBe(true);
  });

  /*
  FNXC:ActiveSessionRegistry 2026-10-07-23:34:
  The reaper canonicalizes its candidates, so a live session registered under another spelling of the same checkout (a junction or symlink alias, an 8.3 short name, another letter case on Windows) must still protect it.
  */
  it("keeps residue bound to a live session registered under another spelling of the checkout", async () => {
    const root = project();
    const live = residue(root, "fn-live");
    const alias = `${root}-alias`;
    symlinkSync(root, alias, "junction");
    tracked.push(alias);
    const spellings = [join(alias, ".fusion", "worktrees", "fn-live"), ...(process.platform === "win32" ? [live.toUpperCase()] : [])];

    for (const spelling of spellings) {
      activeSessionRegistry.clear();
      activeSessionRegistry.registerPath(spelling, { taskId: "FN-LIVE", kind: "executor", ownerKey: "executor:FN-LIVE" });
      await expect(reapOrphanWorktrees(root, {}, { store: store() })).resolves.toBe(0);
      expect(existsSync(join(live, "locked", "file.txt"))).toBe(true);
    }
  });

  it("never reclaims .git-less folders under a worktrees root outside the project", async () => {
    const root = project();
    const external = realpathSync(mkdtempSync(join(tmpdir(), "fusion-residue-shared-root-")));
    tracked.push(external);
    const dir = join(external, "fn-x");
    mkdirSync(dir);
    writeFileSync(join(dir, "file.txt"), "someone else's\n");
    const when = new Date(Date.now() - ORPHAN_RESIDUE_MIN_AGE_MS - 60_000);
    utimesSync(dir, when, when);

    await expect(reapOrphanWorktrees(root, { worktreesDir: external }, { store: store() })).resolves.toBe(0);
    expect(existsSync(join(dir, "file.txt"))).toBe(true);
  });
});
