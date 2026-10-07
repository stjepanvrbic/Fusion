import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { __fusionWorkerRootCleanupTestHooks } from "../__test-utils__/vitest-setup";
import setup, {
  __setWorkerRootRmSyncForTests,
  __setWorkerRootSleepMsSyncForTests,
  removeLegacyTopLevelHomeRoots,
} from "../__test-utils__/vitest-teardown";

const createdPaths: string[] = [];
const originalWorkerRoot = process.env.FUSION_TEST_WORKER_ROOT;
const originalRunToken = process.env.FUSION_TEST_RUN_TOKEN;

function remember(path: string): string {
  createdPaths.push(path);
  return path;
}

function makeWorkerChild(root: string, label: string): void {
  const workerDir = join(root, `w-${process.pid}-${label}`);
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, "file.txt"), "worker temp payload");
}

function restoreWorkerRootEnv(): void {
  if (originalWorkerRoot === undefined) {
    delete process.env.FUSION_TEST_WORKER_ROOT;
  } else {
    process.env.FUSION_TEST_WORKER_ROOT = originalWorkerRoot;
  }
  if (originalRunToken === undefined) {
    delete process.env.FUSION_TEST_RUN_TOKEN;
  } else {
    process.env.FUSION_TEST_RUN_TOKEN = originalRunToken;
  }
}

afterEach(() => {
  __setWorkerRootRmSyncForTests(rmSync);
  __setWorkerRootSleepMsSyncForTests(() => {});
  restoreWorkerRootEnv();
  for (const path of createdPaths.splice(0).reverse()) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("vitest global teardown worker-root cleanup", () => {
  it("removes the per-invocation worker root on the clean path", async () => {
    process.env.FUSION_TEST_RUN_TOKEN = "clean-run-token";
    const teardown = setup();
    const workerRoot = remember(process.env.FUSION_TEST_WORKER_ROOT!);
    makeWorkerChild(workerRoot, "clean");

    /*
    FNXC:TestTeardownOwnership 2026-09-21-10:48:
    FN-9349 requires this regression to execute globalSetup's marker protocol,
    including its run token, rather than only invoking a cleanup helper.
    */
    expect(readFileSync(join(workerRoot, ".fusion-test-worker-root-owner"), "utf8")).toBe(
      `${process.pid}\nrunToken=clean-run-token\n`,
    );
    await teardown();

    expect(existsSync(workerRoot)).toBe(false);
  });

  it("removes its root after worker forks rewrite the marker with their own pids", async () => {
    /*
    FNXC:TestTeardownOwnership 2026-09-23-01:55:
    Real forked-worker runs leaked one fusion-test-workers-* root per vitest invocation because
    each worker fork rewrites the owner marker with its OWN pid (via vitest-setup's
    ensureWorkerRoot), so the main-process teardown's exact `${pid}\nrunToken=...` match never held
    and removal was skipped (106 stale roots accumulated, tripping check-test-isolation). Ownership
    is proven by the shared run token, not the pid: a marker carrying a different pid but the same
    run token is still this invocation's root and must be removed.
    */
    process.env.FUSION_TEST_RUN_TOKEN = "forked-worker-token";
    const teardown = setup();
    const workerRoot = remember(process.env.FUSION_TEST_WORKER_ROOT!);
    makeWorkerChild(workerRoot, "forked");

    const foreignWorkerPid = process.pid + 7;
    writeFileSync(
      join(workerRoot, ".fusion-test-worker-root-owner"),
      `${foreignWorkerPid}\nrunToken=forked-worker-token\n`,
    );
    await teardown();

    expect(existsSync(workerRoot)).toBe(false);
  });

  /*
  FNXC:TestTeardownOwnership 2026-10-07-18:04:
  A direct `vitest run` has no root-runner FUSION_TEST_RUN_TOKEN. Global setup must mint and publish one before
  workers spawn, so every worker inherits the same token and teardown can prove ownership.
  Global setup runs in the Vitest main process, where vitest-setup's fs patches are absent; in this worker those
  patches mint a token during setup's mkdtemp and would hide the defect. So the real setup runs in an unpatched
  child, and each simulated worker starts from the env a fork inherits at spawn, never from a sibling's mutation.
  */
  async function startUnpatchedGlobalSetup(): Promise<{
    workerRoot: string;
    publishedRunToken: string | undefined;
    teardown(): Promise<void>;
  }> {
    const teardownUrl = pathToFileURL(fileURLToPath(new URL("../__test-utils__/vitest-teardown.ts", import.meta.url))).href;
    const script = [
      `import setup from ${JSON.stringify(teardownUrl)};`,
      `import { once } from "node:events";`,
      `const teardown = setup();`,
      `process.stdout.write(JSON.stringify({ workerRoot: process.env.FUSION_TEST_WORKER_ROOT, runToken: process.env.FUSION_TEST_RUN_TOKEN ?? null }) + "\\n");`,
      `await once(process.stdin, "data");`,
      `await teardown();`,
    ].join("\n");
    const env = { ...process.env };
    delete env.FUSION_TEST_RUN_TOKEN;
    delete env.FUSION_TEST_WORKER_ROOT;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env, stdio: ["pipe", "pipe", "inherit"] });
    const exited = once(child, "exit");
    let stdout = "";
    child.stdout.setEncoding("utf8");
    while (!stdout.includes("\n")) {
      const [chunk] = (await Promise.race([once(child.stdout, "data"), exited.then(() => [""])])) as [string];
      if (chunk === "") throw new Error(`global setup child exited before publishing its worker root: ${stdout}`);
      stdout += chunk;
    }
    const published = JSON.parse(stdout.slice(0, stdout.indexOf("\n"))) as { workerRoot: string; runToken: string | null };
    remember(published.workerRoot);
    return {
      workerRoot: published.workerRoot,
      publishedRunToken: published.runToken ?? undefined,
      async teardown() {
        child.stdin.end("go\n");
        const [code] = await exited;
        expect(code).toBe(0);
      },
    };
  }

  function rewriteMarkerAsForkedWorker(inheritedRunToken: string | undefined, workerRoot: string): void {
    if (inheritedRunToken === undefined) delete process.env.FUSION_TEST_RUN_TOKEN;
    else process.env.FUSION_TEST_RUN_TOKEN = inheritedRunToken;
    __fusionWorkerRootCleanupTestHooks.writeWorkerRootOwnerMarker(workerRoot);
  }

  it("removes its root on a direct invocation where no caller supplied a run token", async () => {
    const run = await startUnpatchedGlobalSetup();
    for (const label of ["a", "b", "c"]) {
      rewriteMarkerAsForkedWorker(run.publishedRunToken, run.workerRoot);
      makeWorkerChild(run.workerRoot, `direct-${label}`);
    }
    await run.teardown();

    expect(run.publishedRunToken).toEqual(expect.any(String));
    expect(existsSync(run.workerRoot)).toBe(false);
  });

  it("preserves a successor root when global setup minted the run token itself", async () => {
    const run = await startUnpatchedGlobalSetup();
    makeWorkerChild(run.workerRoot, "minted-successor");

    rewriteMarkerAsForkedWorker("genuine-successor-token", run.workerRoot);
    await run.teardown();

    expect(existsSync(join(run.workerRoot, "w-" + process.pid + "-minted-successor", "file.txt"))).toBe(true);
    expect(readFileSync(join(run.workerRoot, ".fusion-test-worker-root-owner"), "utf8")).toContain("genuine-successor-token");
  });

  it("does not let a stale teardown remove a successor-owned worker root", async () => {
    process.env.FUSION_TEST_RUN_TOKEN = "stale-run-token";
    const staleTeardown = setup();
    const workerRoot = remember(process.env.FUSION_TEST_WORKER_ROOT!);
    makeWorkerChild(workerRoot, "successor");

    /*
    FNXC:TestTeardownOwnership 2026-09-21-10:48:
    FN-9349 requires a stale teardown to reject a successor's distinct run-token
    marker, preserving the live successor root instead of deleting it by path.
    */
    writeFileSync(
      join(workerRoot, ".fusion-test-worker-root-owner"),
      `${process.pid}\nrunToken=successor-run-token\n`,
    );
    await staleTeardown();

    expect(existsSync(workerRoot)).toBe(true);
    expect(readFileSync(join(workerRoot, ".fusion-test-worker-root-owner"), "utf8")).toContain("successor-run-token");
    expect(existsSync(join(workerRoot, "w-" + process.pid + "-successor", "file.txt"))).toBe(true);
  });

  it("preserves an unproven partial-startup root while cleaning a live sibling", async () => {
    process.env.FUSION_TEST_RUN_TOKEN = "partial-startup-token";
    const partialTeardown = setup();
    const partialRoot = remember(process.env.FUSION_TEST_WORKER_ROOT!);
    makeWorkerChild(partialRoot, "partial");

    /*
    FNXC:TestTeardownOwnership 2026-09-21-10:48:
    FN-9349 requires partial startup to fail closed: absent marker provenance
    cannot authorize deleting a root while an independent sibling remains live.
    */
    unlinkSync(join(partialRoot, ".fusion-test-worker-root-owner"));

    process.env.FUSION_TEST_RUN_TOKEN = "live-sibling-token";
    const siblingTeardown = setup();
    const siblingRoot = remember(process.env.FUSION_TEST_WORKER_ROOT!);
    makeWorkerChild(siblingRoot, "live-sibling");

    await partialTeardown();

    expect(existsSync(partialRoot)).toBe(true);
    expect(existsSync(join(partialRoot, "w-" + process.pid + "-partial", "file.txt"))).toBe(true);
    expect(existsSync(siblingRoot)).toBe(true);
    expect(existsSync(join(siblingRoot, "w-" + process.pid + "-live-sibling", "file.txt"))).toBe(true);

    await siblingTeardown();
    expect(existsSync(siblingRoot)).toBe(false);
  });

  it("removes only its own root while a live sibling teardown remains active", async () => {
    const firstTeardown = setup();
    const firstRoot = remember(process.env.FUSION_TEST_WORKER_ROOT!);
    makeWorkerChild(firstRoot, "first");

    const secondTeardown = setup();
    const secondRoot = remember(process.env.FUSION_TEST_WORKER_ROOT!);
    makeWorkerChild(secondRoot, "second");

    await firstTeardown();

    expect(existsSync(firstRoot)).toBe(false);
    expect(existsSync(secondRoot)).toBe(true);
    expect(existsSync(join(secondRoot, "w-" + process.pid + "-second", "file.txt"))).toBe(true);

    await secondTeardown();
    expect(existsSync(secondRoot)).toBe(false);
  });

  it("retries an EBUSY worker-root removal and removes the root", async () => {
    const teardown = setup();
    const workerRoot = remember(process.env.FUSION_TEST_WORKER_ROOT!);
    makeWorkerChild(workerRoot, "busy");
    let attempts = 0;
    const sleeps: number[] = [];

    __setWorkerRootRmSyncForTests((path, options) => {
      attempts++;
      if (attempts === 1) {
        const error = new Error("resource busy") as NodeJS.ErrnoException;
        error.code = "EBUSY";
        throw error;
      }
      rmSync(path, options);
    });
    __setWorkerRootSleepMsSyncForTests((ms) => {
      sleeps.push(ms);
    });

    await teardown();

    expect(attempts).toBe(2);
    expect(sleeps).toEqual([75]);
    expect(existsSync(workerRoot)).toBe(false);
  });

  it("retries transient ENOTEMPTY worker-root cleanup until the root can be removed", async () => {
    const teardown = setup();
    const workerRoot = remember(process.env.FUSION_TEST_WORKER_ROOT!);
    makeWorkerChild(workerRoot, "not-empty");
    let attempts = 0;
    const sleeps: number[] = [];

    __setWorkerRootRmSyncForTests((path, options) => {
      attempts++;
      if (attempts <= 3) {
        const error = new Error("directory not empty") as NodeJS.ErrnoException;
        error.code = "ENOTEMPTY";
        throw error;
      }
      rmSync(path, options);
    });
    __setWorkerRootSleepMsSyncForTests((ms) => {
      sleeps.push(ms);
    });

    await teardown();

    expect(attempts).toBe(4);
    expect(sleeps).toEqual([75, 75, 75]);
    expect(existsSync(workerRoot)).toBe(false);
  });

  it("tolerates ENOENT when the worker root is already gone", async () => {
    const teardown = setup();
    const workerRoot = remember(process.env.FUSION_TEST_WORKER_ROOT!);
    makeWorkerChild(workerRoot, "enoent");
    rmSync(workerRoot, { recursive: true, force: true });

    await teardown();

    expect(existsSync(workerRoot)).toBe(false);
  });

  it("sweeps legacy top-level temp HOME roots without walking unrelated temp entries", () => {
    const tempRoot = remember(mkdtempSync(join(tmpdir(), "fusion-test-home-sweep-root-")));
    const legacyHome = join(tempRoot, "fn-test-home-stale");
    const unrelated = join(tempRoot, "fusion-test-workers-current");
    mkdirSync(legacyHome, { recursive: true });
    mkdirSync(unrelated, { recursive: true });
    writeFileSync(join(legacyHome, "payload.txt"), "legacy home state");

    removeLegacyTopLevelHomeRoots(tempRoot);

    expect(existsSync(legacyHome)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
  });

  it("removes a self-minted fallback worker root during exit cleanup", () => {
    const workerRoot = remember(mkdtempSync(join(tmpdir(), "fusion-test-workers-self-minted-")));
    const workerDir = join(workerRoot, `w-${process.pid}-fallback`);
    const redirDir = join(workerRoot, `redir-${process.pid}`);
    mkdirSync(workerDir, { recursive: true });
    mkdirSync(redirDir, { recursive: true });
    writeFileSync(join(workerDir, "payload.txt"), "worker temp payload");
    writeFileSync(join(redirDir, "payload.txt"), "redirect temp payload");
    __fusionWorkerRootCleanupTestHooks.writeWorkerRootOwnerMarker(workerRoot);

    __fusionWorkerRootCleanupTestHooks.removeSelfMintedWorkerRootWithRetry(workerRoot, true, 0);

    expect(existsSync(workerRoot)).toBe(false);
  });
});
