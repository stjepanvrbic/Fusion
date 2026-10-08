import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CentralCore, readProjectIdentity } from "@fusion/core";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  pgDescribe,
  createTaskStoreForTest,
  type PgTestHarness,
} from "../../../../core/src/__test-utils__/pg-test-harness.js";
import { ensureCwdProjectRegistered } from "../ensure-project-registered.js";

/*
FNXC:CliTests 2026-10-08-15:15:
KB-061: each test used to boot a real embedded PostgreSQL through `new CentralCore(globalDir)`, and that per-test startup exceeds the 5 s budget on Windows.
Following the FN-8077 precedent (project-context.test.ts), CentralCore runs on the shared external PG harness (`asyncLayer: h.layer`).
Embedded-PostgreSQL lifecycle behavior is covered by core tests (KB-052); this file covers registration behavior only.
Projects registered by a test are unregistered before the CentralCore closes, so tests sharing the harness database never see each other's rows.
*/

const tempPaths: string[] = [];

function makeTempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempPaths.push(path);
  return path;
}

pgDescribe("ensureCwdProjectRegistered", () => {
  let h: PgTestHarness;
  let previousDatabaseUrl: string | undefined;
  const centrals: CentralCore[] = [];

  /** CentralCore bound to the external harness; closed (after project cleanup) in afterEach. */
  function makeCentral(globalDir: string): CentralCore {
    const central = new CentralCore(globalDir, { asyncLayer: h.layer });
    centrals.push(central);
    return central;
  }

  beforeAll(async () => {
    h = await createTaskStoreForTest({ prefix: "fusion_cli_ensure_registered" });
  });

  afterAll(async () => {
    await h.teardown();
  });

  beforeEach(() => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = h.testUrl;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      for (const central of centrals.splice(0)) {
        try {
          for (const project of await central.listProjects()) {
            await central.unregisterProject(project.id);
          }
        } finally {
          await central.close();
        }
      }
    } finally {
      if (previousDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
      for (const path of tempPaths.splice(0)) {
        rmSync(path, { recursive: true, force: true });
      }
    }
  });

  it("returns existing registered project without writing files", async () => {
    const globalDir = makeTempDir("fn-4266-global-");
    const cwd = makeTempDir("fn-4266-project-");

    const central = makeCentral(globalDir);
    await central.init();
    const existing = await central.registerProject({
      name: "existing-project",
      path: cwd,
      isolationMode: "in-process",
    });

    const registerSpy = vi.spyOn(central, "registerProject");
    const updateSpy = vi.spyOn(central, "updateProject");

    const result = await ensureCwdProjectRegistered({
      cwd,
      central,
      logPrefix: "serve",
      autoRegister: true,
    });

    expect(result?.id).toBe(existing.id);
    expect(existsSync(join(cwd, ".fusion"))).toBe(true);
    expect(readProjectIdentity(cwd)?.id).toBe(existing.id);
    expect(registerSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("auto-registers unregistered project when enabled and persists identity", async () => {
    const globalDir = makeTempDir("fn-4266-global-");
    const cwd = makeTempDir("fn-4266-project-");

    const central = makeCentral(globalDir);
    await central.init();

    const ensureSpy = vi.spyOn(central, "ensureProjectForPath");
    const updateSpy = vi.spyOn(central, "updateProject");

    const result = await ensureCwdProjectRegistered({
      cwd,
      central,
      logPrefix: "serve",
      autoRegister: true,
    });

    expect(result).not.toBeNull();
    expect(existsSync(join(cwd, ".git"))).toBe(true);
    expect(existsSync(join(cwd, ".fusion"))).toBe(true);
    expect(existsSync(join(cwd, ".fusion", "project.json"))).toBe(true);
    expect(existsSync(join(cwd, ".fusion", "fusion.db"))).toBe(false);
    expect(ensureSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        path: cwd,
      }),
    );
    expect(updateSpy).toHaveBeenCalledWith(expect.any(String), { status: "active" });
    expect(readProjectIdentity(cwd)?.id).toBe(result?.id);
  });

  it("reattaches using stored identity when central row was wiped", async () => {
    const globalDir = makeTempDir("fn-4266-global-");
    const cwd = makeTempDir("fn-4266-project-");

    const central = makeCentral(globalDir);
    await central.init();

    const first = await ensureCwdProjectRegistered({
      cwd,
      central,
      logPrefix: "serve",
      autoRegister: true,
    });
    expect(first).not.toBeNull();

    await central.unregisterProject(first!.id);

    const second = await ensureCwdProjectRegistered({
      cwd,
      central,
      logPrefix: "serve",
      autoRegister: true,
    });

    expect(second?.id).toBe(first?.id);
  });

  it("returns null and does not write when autoRegister is false", async () => {
    const globalDir = makeTempDir("fn-4266-global-");
    const cwd = makeTempDir("fn-4266-project-");

    const central = makeCentral(globalDir);
    await central.init();

    const ensureSpy = vi.spyOn(central, "ensureProjectForPath");

    const result = await ensureCwdProjectRegistered({
      cwd,
      central,
      logPrefix: "daemon",
      autoRegister: false,
    });

    expect(result).toBeNull();
    expect(existsSync(join(cwd, ".fusion"))).toBe(false);
    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it("returns null and logs error when registration throws", async () => {
    const globalDir = makeTempDir("fn-4266-global-");
    const cwd = makeTempDir("fn-4266-project-");

    const central = makeCentral(globalDir);
    await central.init();

    vi.spyOn(central, "ensureProjectForPath").mockRejectedValueOnce(new Error("boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await ensureCwdProjectRegistered({
      cwd,
      central,
      logPrefix: "serve",
      autoRegister: true,
    });

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[serve] Failed to auto-register current project: boom"),
    );
    expect(readProjectIdentity(cwd)).toBeNull();
  });
});
