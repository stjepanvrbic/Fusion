/**
 * FNXC:ProjectMemory 2026-07-08-00:00:
 * Regression coverage for FN-7706: the background qmd child spawned by the default
 * (real) exec path in memory-backend.ts must be unref'd (child + stdio) so a
 * short-lived caller can exit promptly, while a long-lived caller that stays alive
 * anyway still sees the refresh complete. Two layers:
 *  1. A fast unit test on the extracted `unrefQmdChildProcess` helper (no real spawn).
 *  2. An end-to-end symptom test: a fixture Node process fires a background refresh
 *     against a slow fake `qmd` stub on PATH and must exit well before the stub does.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { expectStubInvoked, fixtureEnv, writeQmdStub } from "./_qmd-stub.js";
import { unrefQmdChildProcess } from "../memory/memory-backend.js";

const tsxPackageJsonPath = createRequire(import.meta.url).resolve("tsx/package.json");
const tsxCliPath = join(tsxPackageJsonPath, "..", "dist", "cli.mjs");

describe("unrefQmdChildProcess (unit)", () => {
  it("unrefs the child process and its stdout/stderr/stdin pipes", () => {
    const calls: string[] = [];
    const fakeChild = {
      unref: () => calls.push("child"),
      stdout: { unref: () => calls.push("stdout") },
      stderr: { unref: () => calls.push("stderr") },
      stdin: { unref: () => calls.push("stdin") },
    };

    unrefQmdChildProcess(fakeChild);

    expect(calls.sort()).toEqual(["child", "stderr", "stdin", "stdout"]);
  });

  it("tolerates a missing child or missing stdio streams without throwing", () => {
    expect(() => unrefQmdChildProcess(undefined)).not.toThrow();
    expect(() => unrefQmdChildProcess(null)).not.toThrow();
    expect(() => unrefQmdChildProcess({})).not.toThrow();
    expect(() =>
      unrefQmdChildProcess({ unref: () => {}, stdout: null, stderr: null, stdin: null }),
    ).not.toThrow();
  });
});

/**
 * FNXC:ProjectMemory 2026-10-08-12:42:
 * KB-072: these symptom suites now run on win32 too, via an npm-style `qmd.cmd` shim that the default executor launches shell-free through `resolveShellFreeLaunch`.
 * On win32 the stub's SIGTERM-ignore model is moot because kill is TerminateProcess, but the invariant (the short-lived caller exits before the child) is the same.
 * The stub logs every invocation, and each test waits for its first call (`collection add`) to prove the stub was the qmd that ran.
 */
describe("qmd background refresh does not keep a short-lived caller alive (symptom)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function runFixture(mode: "project" | "agent", rootDir: string, stubDir: string) {
    const fixturePath = join(import.meta.dirname, "fixtures", "qmd-refresh-fixture.mjs");
    const startedAt = Date.now();
    return new Promise<{ code: number | null; elapsedMs: number; stdout: string }>((resolvePromise, reject) => {
      let stdout = "";
      const child = spawn(process.execPath, [tsxCliPath, fixturePath, rootDir, mode], {
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

  it("project refresh: fixture process exits promptly even though the background qmd stub is still sleeping", async () => {
    const stubDir = mkdtempSync(join(tmpdir(), "fn-7706-qmd-stub-"));
    tempDirs.push(stubDir);
    const rootDir = mkdtempSync(join(tmpdir(), "fn-7706-qmd-root-"));
    tempDirs.push(rootDir);
    writeQmdStub(stubDir, "refresh");

    const exitInfo = await runFixture("project", rootDir, stubDir);
    await expectStubInvoked(stubDir);

    expect(exitInfo.stdout).toContain("qmd-refresh-fixture:scheduled");
    expect(exitInfo.code).toBe(0);
    // The fake qmd sleeps 8s on "update"/"embed"; the fixture process must exit
    // well before that, proving the background child + stdio were unref'd rather
    // than holding the fixture's event loop open for the qmd child's full runtime.
    expect(exitInfo.elapsedMs).toBeLessThan(5_000);
  }, 15_000);

  it("agent refresh: fixture process exits promptly even though the background qmd stub is still sleeping", async () => {
    const stubDir = mkdtempSync(join(tmpdir(), "fn-7706-qmd-agent-stub-"));
    tempDirs.push(stubDir);
    const rootDir = mkdtempSync(join(tmpdir(), "fn-7706-qmd-agent-root-"));
    tempDirs.push(rootDir);
    writeQmdStub(stubDir, "refresh");

    const exitInfo = await runFixture("agent", rootDir, stubDir);
    await expectStubInvoked(stubDir);

    expect(exitInfo.stdout).toContain("qmd-refresh-fixture:scheduled");
    expect(exitInfo.code).toBe(0);
    // refreshQmdAgentMemoryIndex routes through the same default executor as the
    // project path; this proves the agent surface inherits the unref fix too.
    expect(exitInfo.elapsedMs).toBeLessThan(5_000);
  }, 15_000);
});
