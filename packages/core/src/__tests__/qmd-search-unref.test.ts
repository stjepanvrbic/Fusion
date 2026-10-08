/**
 * FNXC:ProjectMemory 2026-07-08-00:00:
 * Regression coverage for FN-7707: the AWAITED `searchWithQmd` search child spawned
 * by memory-backend.ts must route through the FN-7706-hardened, unref'd default
 * executor (getDefaultExecFileAsync) instead of carrying its own inline
 * `promisify(execFile)` copy, so a short-lived caller invoking a project-memory
 * search never gets held open by the qmd child's stdio pipes beyond its own actual
 * work. Two layers:
 *  1. A unit test asserting `searchWithQmd` routes both the collection-add and the
 *     search call through the default executor (no private promisify(execFile)).
 *  2. An end-to-end symptom test: a fixture Node process awaits a search against a
 *     slow, SIGTERM-ignoring fake `qmd` stub on PATH and must still exit well
 *     before the stub's own runtime completes.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { expectStubInvoked, fixtureEnv, writeQmdStub } from "./_qmd-stub.js";

const tsxPackageJsonPath = createRequire(import.meta.url).resolve("tsx/package.json");
const tsxCliPath = join(tsxPackageJsonPath, "..", "dist", "cli.mjs");

describe("searchWithQmd routes through the hardened default executor (unit)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("calls the default (spawn-based) executor for both collection-add and search, never a private promisify(execFile)", async () => {
    vi.stubEnv("FUSION_ENABLE_QMD_REFRESH_IN_TESTS", "1");
    vi.resetModules();

    const spawnCalls: Array<{ file: string; args: string[] }> = [];
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return {
        ...actual,
        spawn: (file: string, args: string[], options: unknown) => {
          spawnCalls.push({ file, args });
          // Fake a fast-closing child for both "collection"/"add" and "search".
          // KB-072: match the qmd subcommand anywhere in args, since a host's real qmd.cmd resolves to node with the script path first.
          const isSearch = Array.isArray(args) && args.includes("search");
          const fakeChild = actual.spawn(
            process.execPath,
            ["-e", isSearch ? "process.stdout.write('[]')" : ""],
            options as Record<string, unknown>,
          );
          return fakeChild;
        },
      };
    });

    const rootDir = mkdtempSync(join(tmpdir(), "fn-7707-unit-root-"));
    tempDirs.push(rootDir);
    mkdirSync(join(rootDir, ".fusion", "memory"), { recursive: true });

    const { QmdMemoryBackend, refreshQmdProjectMemoryIndex } = await import("../memory/memory-backend.js");
    const backend = new QmdMemoryBackend();
    const results = await backend.search(rootDir, { query: "unit-test-query", limit: 5 });
    /*
    FNXC:ProjectMemory 2026-10-08-01:30:
    search() also schedules the fire-and-forget background refresh, whose children run with cwd rootDir.
    Windows refuses to delete a directory that is a live process's cwd, so afterEach failed with EPERM on the Windows CI lane whenever a slow runner left a refresh child alive (KB-008).
    Join the in-flight refresh (a non-forced call returns it) so every child this test caused has exited before cleanup.
    */
    await refreshQmdProjectMemoryIndex(rootDir).catch(() => {});

    expect(Array.isArray(results)).toBe(true);
    // Both the collection-add and the qmd search calls must go through the mocked
    // `spawn` (the default executor's underlying primitive) — proving searchWithQmd
    // no longer constructs its own private `promisify(execFile)` copy, which would
    // bypass this mock entirely and use the real un-unref'd execFile path instead.
    const collectionAddCalls = spawnCalls.filter((call) => {
      const at = call.args.indexOf("collection");
      return at >= 0 && call.args[at + 1] === "add";
    });
    const searchCalls = spawnCalls.filter((call) => call.args.includes("search"));
    expect(collectionAddCalls.length).toBeGreaterThanOrEqual(1);
    expect(searchCalls.length).toBeGreaterThanOrEqual(1);

    vi.doUnmock("node:child_process");
  });
});

/**
 * FNXC:ProjectMemory 2026-10-08-12:42:
 * KB-072: these symptom suites now run on win32 too, via an npm-style `qmd.cmd` shim that the default executor launches shell-free through `resolveShellFreeLaunch`.
 * On win32 the stub's SIGTERM-ignore model is moot because kill is TerminateProcess, but the invariant (the short-lived caller exits before the child) is the same.
 * The stub logs every invocation, and each test waits for its first call (`collection add`) to prove the stub was the qmd that ran.
 */
describe("qmd search does not keep a short-lived caller alive (symptom)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function runFixture(rootDir: string, stubDir: string) {
    const fixturePath = join(import.meta.dirname, "fixtures", "qmd-search-fixture.mjs");
    const startedAt = Date.now();
    return new Promise<{ code: number | null; elapsedMs: number; stdout: string }>((resolvePromise, reject) => {
      let stdout = "";
      const child = spawn(process.execPath, [tsxCliPath, fixturePath, rootDir], {
        env: fixtureEnv(stubDir),
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        resolvePromise({ code, elapsedMs: Date.now() - startedAt, stdout });
      });
    });
  }

  it("search: fixture process exits promptly even though the search's qmd child ignores the internal timeout kill and keeps sleeping", async () => {
    const stubDir = mkdtempSync(join(tmpdir(), "fn-7707-qmd-stub-"));
    tempDirs.push(stubDir);
    const rootDir = mkdtempSync(join(tmpdir(), "fn-7707-qmd-root-"));
    tempDirs.push(rootDir);
    writeQmdStub(stubDir, "search");

    const exitInfo = await runFixture(rootDir, stubDir);
    await expectStubInvoked(stubDir);

    expect(exitInfo.stdout).toContain("qmd-search-fixture:started");
    // Once the search's child + stdio are properly unref'd, nothing else keeps the
    // fixture's event loop alive, so Node exits promptly with the still-pending
    // top-level `await backend.search(...)` abandoned — Node reports this as exit
    // code 13 ("unsettled top-level await"), which is expected/desired here: it is
    // direct proof the process did NOT wait for the SIGTERM-ignoring qmd child.
    // What matters is that the process exits at all (is not null/hung) and does so
    // well before the stub's 8s sleep completes.
    expect(exitInfo.code).not.toBeNull();
    // The stub ignores SIGTERM and only responds to "search" after an 8s sleep; the
    // fixture process must exit well before that, proving the search's child +
    // stdio were unref'd rather than holding the fixture's event loop open for the
    // child's full runtime after its own work (spawning + collection-add) is done.
    expect(exitInfo.elapsedMs).toBeLessThan(5_000);
  }, 15_000);
});
