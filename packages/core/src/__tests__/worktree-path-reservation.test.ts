import {randomUUID} from "node:crypto";
import {mkdir, mkdtemp, readdir, realpath, rm, symlink, utimes, writeFile} from "node:fs/promises";
import {hostname, tmpdir} from "node:os";
import {join, sep} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";

const fsFaults = vi.hoisted(() => ({writeFile: undefined as Error | undefined, rename: undefined as Error | undefined}));
/** One-shot faults raised only when the call targets the `claim` directory itself. */
const claimFaults = vi.hoisted(() => ({lstat: undefined as Error | undefined, readdir: undefined as Error | undefined, stat: undefined as Error | undefined}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const onClaim = <F extends (path: never, ...rest: never[]) => Promise<unknown>>(name: keyof typeof claimFaults, fn: F): F => (async (path: unknown, ...rest: unknown[]) => {
    const fault = claimFaults[name];
    if (fault && /[\\/]claim$/.test(String(path))) { claimFaults[name] = undefined; throw fault; }
    return (fn as unknown as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
  }) as unknown as F;
  return {
    ...actual,
    lstat: onClaim("lstat", actual.lstat),
    readdir: onClaim("readdir", actual.readdir),
    stat: onClaim("stat", actual.stat),
    writeFile: (async (...args: Parameters<typeof actual.writeFile>) => {
      const fault = fsFaults.writeFile;
      if (fault) { fsFaults.writeFile = undefined; throw fault; }
      return actual.writeFile(...args);
    }) as typeof actual.writeFile,
    rename: (async (...args: Parameters<typeof actual.rename>) => {
      const fault = fsFaults.rename;
      if (fault) { fsFaults.rename = undefined; throw fault; }
      return actual.rename(...args);
    }) as typeof actual.rename,
  };
});

import {acquireWorktreePathReservation, readWorktreePathReservation, resolveWorktreePathReservationDirectory} from "../tasks/worktree-path-reservation.js";

const DEAD_PID = 2_147_483_000;
const LONG_AGO = new Date(Date.now() - 60 * 60_000);
const dirs: string[] = [];
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "fusion-reservation-")));
  dirs.push(dir);
  return {rootDir: dir, worktreesDir: join(dir, "trees"), canonicalPath: join(dir, "trees", "pinned")};
}
afterEach(async () => {
  fsFaults.writeFile = undefined;
  fsFaults.rename = undefined;
  claimFaults.lstat = claimFaults.readdir = claimFaults.stat = undefined;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, {recursive: true, force: true})));
});

/** A claim left behind by an owner that died while holding it. */
async function plantDeadOwnerClaim(options: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const directory = await resolveWorktreePathReservationDirectory(options);
  const token = randomUUID();
  const owner = {pid: DEAD_PID, hostname: hostname(), startedAt: new Date().toISOString(), canonicalPath: options.canonicalPath, token};
  await mkdir(join(directory, "claim"), {recursive: true});
  await writeFile(join(directory, "claim", `${token}.json`), JSON.stringify(owner));
  await writeFile(join(directory, "state.json"), JSON.stringify({...owner, state: "held"}));
  return directory;
}

/** A claim directory with no published owner: a crash between claim creation and record publication. */
async function plantOwnerlessClaim(options: Awaited<ReturnType<typeof fixture>>, mtime: Date): Promise<string> {
  const directory = await resolveWorktreePathReservationDirectory(options);
  await mkdir(join(directory, "claim"), {recursive: true});
  await utimes(join(directory, "claim"), mtime, mtime);
  return directory;
}

describe("worktree path reservation", () => {
  it("excludes concurrent owners until the current owner releases", async () => {
    const options = await fixture();
    const first = await acquireWorktreePathReservation(options);
    let acquired = false;
    const second = acquireWorktreePathReservation({...options, pollMs: 1, acquireTimeoutMs: 500}).then((handle) => { acquired = true; return handle; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(acquired).toBe(false);
    await first.release();
    const handle = await second;
    expect(handle.previousState).toBe("free");
    await handle.release();
  });

  it("reconciles a quarantined path before handing it to a successor", async () => {
    const options = await fixture();
    const first = await acquireWorktreePathReservation(options);
    await first.quarantine("remove failed");
    const reconcileQuarantined = vi.fn().mockResolvedValue(undefined);

    const next = await acquireWorktreePathReservation({...options, reconcileQuarantined});

    expect(reconcileQuarantined).toHaveBeenCalledWith(options.canonicalPath);
    expect(next.previousState).toBe("quarantined");
    await next.release();
    expect(await readWorktreePathReservation(options)).toBeNull();
  });

  it("reconciles a stale held record and clears it after successful settlement", async () => {
    const options = await fixture();
    const first = await acquireWorktreePathReservation(options);
    await first.release();
    const directory = await resolveWorktreePathReservationDirectory(options);
    await writeFile(`${directory}/state.json`, JSON.stringify({
      pid: 999999,
      hostname: "stale-host",
      startedAt: new Date(0).toISOString(),
      canonicalPath: options.canonicalPath,
      state: "held",
      token: "stale-token",
    }));
    const reconcileQuarantined = vi.fn().mockResolvedValue(undefined);

    const next = await acquireWorktreePathReservation({...options, reconcileQuarantined});

    expect(next.previousState).toBe("quarantined");
    expect(reconcileQuarantined).toHaveBeenCalledWith(options.canonicalPath);
    await next.release();
    expect(await readWorktreePathReservation(options)).toBeNull();
  });

  it("keeps a quarantined path unavailable when successor reconciliation fails", async () => {
    const options = await fixture();
    const first = await acquireWorktreePathReservation(options);
    await first.quarantine("remove failed");

    await expect(acquireWorktreePathReservation({...options, reconcileQuarantined: async () => { throw new Error("still occupied"); }})).rejects.toThrow("still occupied");

    const record = await readWorktreePathReservation(options);
    expect(record?.state).toBe("quarantined");
    expect(record?.reason).toBe("still occupied");
  });

  it("times out rather than waiting forever for a live claim", async () => {
    const options = await fixture();
    const first = await acquireWorktreePathReservation(options);
    await expect(acquireWorktreePathReservation({...options, acquireTimeoutMs: 10, pollMs: 1})).rejects.toThrow("Timed out acquiring worktree reservation");
    await first.release();
  });

  it("publishes a held record that names the owner while the claim is held", async () => {
    const options = await fixture();
    const handle = await acquireWorktreePathReservation(options);
    expect(await readWorktreePathReservation(options)).toMatchObject({state: "held", pid: process.pid, hostname: hostname(), canonicalPath: options.canonicalPath, token: handle.token});
    await handle.release();
    expect(await readWorktreePathReservation(options)).toBeNull();
  });

  it("reclaims the claim of an owner that died while holding it", async () => {
    const options = await fixture();
    await plantDeadOwnerClaim(options);
    const next = await acquireWorktreePathReservation({...options, acquireTimeoutMs: 1_000, pollMs: 1});
    expect(next.previousState).toBe("quarantined");
    await next.release();
  });
});

describe("worktree path reservation: claims without a published owner", () => {
  it("never leaves an ownerless claim when owner publication fails", async () => {
    for (const fault of ["writeFile", "rename"] as const) {
      const options = await fixture();
      fsFaults[fault] = Object.assign(new Error(`injected ${fault} failure`), {code: "EIO"});
      await expect(acquireWorktreePathReservation(options)).rejects.toThrow(`injected ${fault} failure`);
      const next = await acquireWorktreePathReservation({...options, acquireTimeoutMs: 200, pollMs: 1});
      expect(next.state).toBe("held");
      await next.release();
    }
  });

  it("recovers an ownerless claim left by a crash once it is past the publication grace period", async () => {
    const options = await fixture();
    await plantOwnerlessClaim(options, LONG_AGO);
    const next = await acquireWorktreePathReservation({...options, acquireTimeoutMs: 1_000, pollMs: 1});
    expect(next.state).toBe("held");
    await next.release();
    // Recovery also survives restart: a fresh acquirer after release sees a free path.
    const again = await acquireWorktreePathReservation({...options, acquireTimeoutMs: 200, pollMs: 1});
    expect(again.previousState).toBe("free");
    await again.release();
  });

  it("waits on a freshly created ownerless claim instead of stealing it", async () => {
    const options = await fixture();
    await plantOwnerlessClaim(options, new Date());
    await expect(acquireWorktreePathReservation({...options, acquireTimeoutMs: 50, pollMs: 5})).rejects.toThrow("Timed out acquiring worktree reservation");
  });

  it("protects an ownerless claim whose legacy held record names a live local process", async () => {
    const options = await fixture();
    const directory = await plantOwnerlessClaim(options, LONG_AGO);
    await writeFile(join(directory, "state.json"), JSON.stringify({pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString(), canonicalPath: options.canonicalPath, state: "held", token: "legacy-live"}));
    await expect(acquireWorktreePathReservation({...options, acquireTimeoutMs: 50, pollMs: 5})).rejects.toThrow("Timed out acquiring worktree reservation");
  });

  it("reclaims an ownerless claim whose legacy held record names a dead local process", async () => {
    const options = await fixture();
    const directory = await plantOwnerlessClaim(options, new Date());
    await writeFile(join(directory, "state.json"), JSON.stringify({pid: DEAD_PID, hostname: hostname(), startedAt: new Date().toISOString(), canonicalPath: options.canonicalPath, state: "held", token: "legacy-dead"}));
    const next = await acquireWorktreePathReservation({...options, acquireTimeoutMs: 1_000, pollMs: 1});
    expect(next.previousState).toBe("quarantined");
    await next.release();
  });

  it("reclaims a malformed owner record only past the TTL and with the worktree proven not live", async () => {
    const options = await fixture();
    const directory = await resolveWorktreePathReservationDirectory(options);
    await mkdir(join(directory, "claim"), {recursive: true});
    await writeFile(join(directory, "claim", `${randomUUID()}.json`), "{not json");
    await utimes(join(directory, "claim"), LONG_AGO, LONG_AGO);

    await expect(acquireWorktreePathReservation({...options, ttlMs: 1_000, isLiveWorktree: async () => true, acquireTimeoutMs: 50, pollMs: 5})).rejects.toThrow("Timed out");
    await expect(acquireWorktreePathReservation({...options, ttlMs: 1_000, acquireTimeoutMs: 50, pollMs: 5})).rejects.toThrow("Timed out");
    const next = await acquireWorktreePathReservation({...options, ttlMs: 1_000, isLiveWorktree: async () => false, acquireTimeoutMs: 1_000, pollMs: 1});
    expect(next.state).toBe("held");
    await next.release();
  });
});

describe("worktree path reservation: competing reclaimers", () => {
  it("a reclaimer that observed a dead owner never removes the successor's claim", async () => {
    const options = await fixture();
    await plantDeadOwnerClaim(options);
    let observedStale!: () => void;
    const observed = new Promise<void>((resolve) => { observedStale = resolve; });
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    let staleAcquired = false;

    const stale = acquireWorktreePathReservation({
      ...options,
      pollMs: 1,
      acquireTimeoutMs: 5_000,
      __beforeReclaimForTest: async () => { observedStale(); await gate; },
    }).then((handle) => { staleAcquired = true; return handle; });
    await observed;

    const successor = await acquireWorktreePathReservation({...options, acquireTimeoutMs: 1_000, pollMs: 1});
    openGate();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(staleAcquired).toBe(false);
    expect(successor.state).toBe("held");
    expect(await readWorktreePathReservation(options)).toMatchObject({state: "held", token: successor.token});
    await successor.release();
    const late = await stale;
    expect(late.state).toBe("held");
    await late.release();
  });

  it("admits at most one owner when several acquirers race a dead owner's claim", async () => {
    const options = await fixture();
    await plantDeadOwnerClaim(options);
    let inside = 0;
    let maxInside = 0;
    await Promise.all(Array.from({length: 6}, async () => {
      const handle = await acquireWorktreePathReservation({...options, pollMs: 1, acquireTimeoutMs: 10_000});
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inside -= 1;
      await handle.release();
    }));
    expect(maxInside).toBe(1);
  });

  /*
  FNXC:WorkflowLifecycle 2026-10-08-04:11:
  Windows reports a claim directory that a competing reclaimer is deleting (delete-pending) or that antivirus holds open as EPERM/EACCES/EBUSY on lstat, readdir and stat.
  That denial is neither proof of absence nor proof of a live owner, so the acquirer must re-poll within its timeout instead of crashing or stealing.
  */
  const CLAIM_PROBES = ["lstat", "readdir", "stat"] as const;
  const transient = (code: string) => Object.assign(new Error(`injected ${code}`), {code});

  it("keeps polling instead of failing when a contended claim is transiently unreadable", async () => {
    for (const probe of CLAIM_PROBES) {
      for (const code of ["EPERM", "EACCES", "EBUSY"]) {
        const options = await fixture();
        await plantDeadOwnerClaim(options);
        claimFaults[probe] = transient(code);
        const next = await acquireWorktreePathReservation({...options, acquireTimeoutMs: 1_000, pollMs: 1});
        expect(claimFaults[probe], `${probe} ${code} fault was not exercised`).toBeUndefined();
        expect(next.state).toBe("held");
        await next.release();
      }
    }
  });

  it("never takes a live owner's claim because a probe of it was transiently denied", async () => {
    for (const probe of CLAIM_PROBES) {
      const options = await fixture();
      const holder = await acquireWorktreePathReservation(options);
      claimFaults[probe] = transient("EPERM");
      await expect(acquireWorktreePathReservation({...options, acquireTimeoutMs: 50, pollMs: 1})).rejects.toThrow("Timed out acquiring worktree reservation");
      expect(claimFaults[probe], `${probe} fault was not exercised`).toBeUndefined();
      expect(await readWorktreePathReservation(options)).toMatchObject({state: "held", token: holder.token});
      await holder.release();
    }
  });

  it("a released owner whose claim was reclaimed does not disturb the successor", async () => {
    const options = await fixture();
    const first = await acquireWorktreePathReservation(options);
    const directory = await resolveWorktreePathReservationDirectory(options);
    // Simulate a takeover of the first owner's generation, then a successor acquiring.
    await rm(join(directory, "claim"), {recursive: true, force: true});
    const successor = await acquireWorktreePathReservation({...options, acquireTimeoutMs: 200, pollMs: 1});
    await first.release();
    await first.quarantine("late");
    expect(first.state).toBe("released");
    expect(await readWorktreePathReservation(options)).toMatchObject({state: "held", token: successor.token});
    await successor.release();
  });
});

describe("worktree path reservation: path identity", () => {
  async function expectContended(options: Awaited<ReturnType<typeof fixture>>, aliases: string[]) {
    const directory = await resolveWorktreePathReservationDirectory(options);
    const holder = await acquireWorktreePathReservation(options);
    try {
      for (const alias of aliases) {
        expect(await resolveWorktreePathReservationDirectory({...options, canonicalPath: alias})).toBe(directory);
        await expect(acquireWorktreePathReservation({...options, canonicalPath: alias, acquireTimeoutMs: 30, pollMs: 5})).rejects.toThrow("Timed out acquiring worktree reservation");
      }
    } finally {
      await holder.release();
    }
  }

  it("makes separator and symlink-ancestor spellings of one checkout contend for one claim", async () => {
    const options = await fixture();
    await mkdir(options.canonicalPath, {recursive: true});
    const alias = join(options.rootDir, "alias-trees");
    await symlink(options.worktreesDir, alias, process.platform === "win32" ? "junction" : "dir");
    await expectContended(options, [
      `${options.canonicalPath}${sep}`,
      `${options.worktreesDir}${sep}${sep}pinned`,
      join(alias, "pinned"),
    ]);
  });

  it("makes absent-checkout spellings through a symlinked ancestor contend before the checkout exists", async () => {
    const options = await fixture();
    await mkdir(options.worktreesDir, {recursive: true});
    const alias = join(options.rootDir, "alias-trees");
    await symlink(options.worktreesDir, alias, process.platform === "win32" ? "junction" : "dir");
    await expectContended(options, [join(alias, "pinned")]);
  });

  it.skipIf(process.platform !== "win32")("makes drive-letter, component-case and extended-length spellings contend on Windows", async () => {
    const options = await fixture();
    await mkdir(options.worktreesDir, {recursive: true});
    const drive = options.canonicalPath.slice(0, 1);
    const flipped = (drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase()) + options.canonicalPath.slice(1);
    await expectContended(options, [
      flipped,
      options.canonicalPath.toUpperCase(),
      options.canonicalPath.toLowerCase(),
      `\\\\?\\${options.canonicalPath}`,
      options.canonicalPath.replace(/\\/g, "/"),
    ]);
    expect((await readdir(join(options.worktreesDir, ".fusion-worktree-locks"))).length).toBe(1);
  });
});
