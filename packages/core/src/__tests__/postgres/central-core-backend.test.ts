/**
 * PostgreSQL backend-mode CentralCore integration test
 * (migrate-central-core-to-postgres).
 *
 * FNXC:CentralCore 2026-06-26-14:00:
 * Integration tests proving CentralCore operates correctly in backend mode
 * (asyncLayer injected) against real PostgreSQL. Verifies the dual-path
 * delegation: when an AsyncDataLayer is provided, CentralCore does NOT
 * construct a SQLite CentralDatabase, and all methods (project registry, node
 * registry, project health, activity feed, global concurrency, mesh snapshots,
 * project/node path mappings) round-trip through the shared connection pool.
 *
 * This covers the load-bearing expected behaviors:
 *   - "CentralCore does not construct CentralDatabase when asyncLayer is provided"
 *   - "All CentralCore methods work in backend mode via PostgreSQL"
 *   - "Project registry, node registry, activity feed work against PG"
 *
 * Skipped when PostgreSQL is unreachable (FUSION_PG_TEST_SKIP=1) so the merge
 * gate stays green without a running server.
 */

import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { CentralCore } from "../../central/central-core.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import * as asyncCentralCore from "../../async-stores/async-central-core.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

/*
FNXC:PgTestHarnessAdoption 2026-08-16-03:45:
Migrated off the hand-rolled per-test CREATE DATABASE + applySchemaBaseline scaffolding
(~3-4s of DDL per test) onto the shared PG harness: one template-cloned database per file
with TRUNCATE-based reset per test. The database setup here was scaffolding, not the
subject under test (CentralCore's backend-mode delegation is). Each test still constructs
and inits its own CentralCore against the harness layer AFTER the per-test truncate, so
init-time bootstrap (default local node) is observed per test exactly as before.
CentralCore.close() never closes an injected layer, so the shared pool survives across
tests. Every assertion is unchanged.
*/
interface TestCtx {
  layer: AsyncDataLayer;
  central: CentralCore;
  globalDir: string;
  projectDirs: string[];
}

/*
FNXC:TestInfraWindows 2026-10-08-08:20:
CentralCore stores the canonical project path, and a Windows runner temp dir can be an 8.3 short spelling (`RUNNER~1`).
Return the native realpath so exact path assertions compare canonical to canonical on every host; on Linux the path is unchanged.
*/
function makeProjectDir(ctx: TestCtx, name: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), `kb-cc-pg-${name}-`)));
  ctx.projectDirs.push(dir);
  return dir;
}

pgDescribe("CentralCore backend mode (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_cc_test",
  });
  let ctx: TestCtx;

  async function setupCtx(): Promise<TestCtx> {
    const layer = h.layer();
    // Pass an explicit temp global dir so resolveGlobalDir() does not throw under VITEST.
    const globalDir = mkdtempSync(join(tmpdir(), "kb-cc-pg-global-"));
    const central = new CentralCore(globalDir, { asyncLayer: layer });
    await central.init();
    return { layer, central, globalDir, projectDirs: [] };
  }

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    ctx = await setupCtx();
  });
  afterEach(async () => {
    try {
      await ctx.central.close();
    } catch {
      /* best-effort */
    }
    for (const dir of [...ctx.projectDirs, ctx.globalDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    await h.afterEach();
  });
  afterAll(h.afterAll);

  it("reports backendMode=true and does not construct SQLite CentralDatabase", async () => {
    expect(ctx.central.backendMode).toBe(true);
    // getDatabasePath returns the logical global dir in backend mode (no SQLite file).
    expect(ctx.central.getDatabasePath()).not.toMatch(/fusion-central\.db$/);
  });

  it("bootstraps a default local node on init", async () => {
    const nodes = await ctx.central.listNodes();
    const localNodes = nodes.filter((n) => n.type === "local");
    expect(localNodes.length).toBe(1);
    expect(localNodes[0].name).toBe("local");
  });

  it("registers, reads, and lists a project through PostgreSQL", async () => {
    const projectPath = makeProjectDir(ctx, "alpha");
    const created = await ctx.central.registerProject({
      name: "Alpha",
      path: projectPath,
      isolationMode: "in-process",
    });
    expect(created.id).toMatch(/^proj_[a-f0-9]{16}$/);

    const byId = await ctx.central.getProject(created.id);
    expect(byId?.name).toBe("Alpha");
    expect(byId?.path).toBe(projectPath);

    const byPath = await ctx.central.getProjectByPath(projectPath);
    expect(byPath?.id).toBe(created.id);

    const listed = await ctx.central.listProjects();
    expect(listed.some((p) => p.id === created.id)).toBe(true);

    // Project health row is created alongside.
    const health = await ctx.central.getProjectHealth(created.id);
    expect(health?.projectId).toBe(created.id);
    expect(health?.status).toBe("initializing");
  });

  /*
  FNXC:PathIdentity 2026-10-07-18:30:
  One directory is one project whatever spelling registers or looks it up: drive and component case, separators, extended-length prefixes and junction/symlink aliases.
  */
  function aliasesOf(ctx: TestCtx, dir: string): string[] {
    const alias = join(mkdtempSync(join(tmpdir(), "kb-cc-pg-alias-")), "link");
    ctx.projectDirs.push(join(alias, ".."));
    symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
    const spellings = [alias, `${dir}${sep}`];
    if (process.platform === "win32") spellings.push(dir.toUpperCase(), dir.toLowerCase(), `\\\\?\\${dir}`);
    return spellings;
  }

  it("registers a project under its canonical path and resolves every spelling of it", async () => {
    const dir = realpathSync.native(makeProjectDir(ctx, "identity"));
    const [first, ...rest] = aliasesOf(ctx, dir);
    const created = await ctx.central.registerProject({ name: "Identity", path: first!, isolationMode: "in-process" });
    expect(created.path).toBe(dir);
    for (const spelling of [dir, first!, ...rest]) {
      expect((await ctx.central.getProjectByPath(spelling))?.id).toBe(created.id);
      expect(await ctx.central.isProjectRegistered(spelling)).toBe(true);
      await expect(ctx.central.registerProject({ name: "Dup", path: spelling })).rejects.toThrow("already registered");
    }
    expect(await ctx.central.autoRegisterProject(rest[0]!)).toMatchObject({ id: created.id });
    mkdirSync(join(dir, "child"));
    await expect(ctx.central.autoRegisterProject(join(first!, "child"))).rejects.toThrow("overlaps an existing registered project");
  });

  it("finds a legacy row stored under a non-canonical spelling and keeps its identity on reattach", async () => {
    const dir = realpathSync.native(makeProjectDir(ctx, "legacy"));
    const [stored] = aliasesOf(ctx, dir);
    const now = new Date().toISOString();
    const id = "proj_0123456789abcdef";
    await asyncCentralCore.insertProjectRow(ctx.layer, {
      id, name: "Legacy", path: stored!, status: "active", isolationMode: "in-process",
      createdAt: now, updatedAt: now, lastActivityAt: now,
    }, now);
    expect((await ctx.central.getProjectByPath(dir))?.id).toBe(id);
    expect((await ctx.central.reattachProject({ id, name: "Legacy", path: dir })).id).toBe(id);

    const readiness = async () => ({ outcome: "existing" as const, integrationBranches: [] });
    const central = new CentralCore(ctx.globalDir, { asyncLayer: ctx.layer, ensureProjectGitReadiness: readiness as never });
    await central.init();
    try {
      const ensured = await central.ensureProjectForPath({ path: `${dir}${sep}`, identity: { id, createdAt: now } as never });
      expect(ensured).toMatchObject({ outcome: "existing", project: { id } });
    } finally {
      await central.close();
    }
  });

  it("updates a project and reconciles stale statuses", async () => {
    const projectPath = makeProjectDir(ctx, "beta");
    const created = await ctx.central.registerProject({
      name: "Beta",
      path: projectPath,
    });
    const updated = await ctx.central.updateProject(created.id, {
      status: "active",
    });
    expect(updated.status).toBe("active");

    // Force a stale row, then reconcile.
    await ctx.central.updateProject(created.id, { status: "initializing" });
    const reconciled = await ctx.central.reconcileProjectStatuses();
    expect(reconciled.some((r) => r.projectId === created.id)).toBe(true);
    const after = await ctx.central.getProject(created.id);
    expect(after?.status).toBe("active");
  });

  it("registers and updates a node through PostgreSQL", async () => {
    const node = await ctx.central.registerNode({
      name: "remote-1",
      type: "remote",
      url: "http://remote-host:4040",
      apiKey: "secret",
      maxConcurrent: 3,
    });
    expect(node.type).toBe("remote");
    expect(node.maxConcurrent).toBe(3);

    const fetched = await ctx.central.getNode(node.id);
    expect(fetched?.name).toBe("remote-1");

    const byName = await ctx.central.getNodeByName("remote-1");
    expect(byName?.id).toBe(node.id);

    const updated = await ctx.central.updateNode(node.id, { status: "online" });
    expect(updated.status).toBe("online");
  });

  it("logs and reads activity through PostgreSQL", async () => {
    const projectPath = makeProjectDir(ctx, "gamma");
    const project = await ctx.central.registerProject({
      name: "Gamma",
      path: projectPath,
    });
    const entry = await ctx.central.logActivity({
      type: "task:created",
      timestamp: new Date().toISOString(),
      projectId: project.id,
      projectName: project.name,
      details: "Task KB-001 created",
      metadata: { kind: "creation" },
    });
    expect(entry.id).toBeTruthy();

    const recent = await ctx.central.getRecentActivity({ limit: 10 });
    expect(recent.some((e) => e.id === entry.id)).toBe(true);

    const count = await ctx.central.getActivityCount(project.id);
    expect(count).toBeGreaterThanOrEqual(1);
  });



  it("composes central task-ID search with project and type filters", async () => {
    const project = await ctx.central.registerProject({ name: "Activity search", path: makeProjectDir(ctx, "activity-search") });
    const other = await ctx.central.registerProject({ name: "Other activity", path: makeProjectDir(ctx, "other-activity") });
    await ctx.central.logActivity({ type: "task:created", timestamp: "2026-08-20T04:15:00.000Z", projectId: project.id, projectName: project.name, taskId: "FN-066", details: "first match" });
    await ctx.central.logActivity({ type: "task:moved", timestamp: "2026-08-20T04:16:00.000Z", projectId: project.id, projectName: project.name, taskId: "FN-066", details: "newest match" });
    await ctx.central.logActivity({ type: "task:moved", timestamp: "2026-08-20T04:17:00.000Z", projectId: other.id, projectName: other.name, taskId: "FN-066", details: "other project" });
    await ctx.central.logActivity({ type: "task:moved", timestamp: "2026-08-20T04:18:00.000Z", projectId: project.id, projectName: project.name, taskId: "FN-999", details: "other task" });

    expect((await ctx.central.getRecentActivity({ taskId: "FN-066", projectId: project.id })).map((entry) => entry.details))
      .toEqual(["newest match", "first match"]);
    expect((await ctx.central.getRecentActivity({ taskId: "FN-066", projectId: project.id, types: ["task:moved"] })).map((entry) => entry.details))
      .toEqual(["newest match"]);
    expect((await ctx.central.getRecentActivity({ taskId: "FN-066", projectId: project.id, since: "2026-08-20T04:16:00.000Z" })).map((entry) => entry.details))
      .toEqual(["first match"]);
  });

  it("records project-node path mappings through PostgreSQL", async () => {
    const projectPath = makeProjectDir(ctx, "epsilon");
    const project = await ctx.central.registerProject({
      name: "Epsilon",
      path: projectPath,
    });
    const nodes = await ctx.central.listNodes();
    const localNode = nodes.find((n) => n.type === "local")!;

    // registerProject already creates the local-node mapping (insertProjectRow
    // transaction), so fetch it and verify it round-tripped through PostgreSQL.
    const fetched = await ctx.central.getProjectNodePathMapping(project.id, localNode.id);
    expect(fetched?.path).toBe(projectPath);

    const listed = await ctx.central.listProjectNodePathMappings({ projectId: project.id });
    expect(listed.some((m) => m.nodeId === localNode.id)).toBe(true);
  });

  it("records and reads a mesh snapshot through PostgreSQL", async () => {
    const nodes = await ctx.central.listNodes();
    const localNode = nodes.find((n) => n.type === "local")!;
    // project_id is part of the composite PRIMARY KEY and therefore NOT NULL
    // under PostgreSQL (unlike SQLite's lax NULL-in-PK). Use a sentinel value
    // for the global scope, matching the production mesh contract.
    const record = await ctx.central.recordMeshSnapshot({
      nodeId: localNode.id,
      projectId: "__global__",
      scope: "test-scope",
      payload: { hello: "world" },
      snapshotVersion: "v1",
      capturedAt: new Date().toISOString(),
    });
    expect(record.scope).toBe("test-scope");

    const fetched = await ctx.central.getLatestMeshSnapshot({
      nodeId: localNode.id,
      projectId: "__global__",
      scope: "test-scope",
    });
    expect(fetched?.payload).toMatchObject({ hello: "world" });
  });

  it("attachBackendLayer transitions a legacy CentralCore into backend mode", async () => {
    // Create a fresh legacy CentralCore (no asyncLayer) then attach the layer.
    const legacy = new CentralCore(ctx.globalDir);
    expect(legacy.backendMode).toBe(false);
    await legacy.attachBackendLayer(ctx.layer);
    expect(legacy.backendMode).toBe(true);
    // It should now read the same bootstrapped local node.
    const nodes = await legacy.listNodes();
    expect(nodes.some((n) => n.type === "local")).toBe(true);
    await legacy.close();
  });
});
