/**
 * FNXC:PgTestTemplateDb 2026-07-17-12:00:
 * Vitest thread isolation gives each test file a private harness module registry
 * while retaining one process pid. These tests load fresh module instances with
 * resetModules so the PG template lifecycle is exercised exactly as dashboard
 * API worker threads exercise it, including missing, reused, half-built, and
 * concurrently-created template states.
 *
 * FNXC:PgTestTemplateDb 2026-10-11-06:37:
 * The concurrent case timed out at 15 s on the Windows Full Suite lane. Reproduced on native Windows PostgreSQL: the first harness use of a fresh
 * module ran dead-owner reclamation (serial, flush-bound DROP DATABASE of every template a finished process left) inside the case body, and this
 * file itself left six per-module templates behind for the next run to reclaim. Reclamation and golden readiness now run in `beforeAll`, which
 * seeds one dead-owner template so the warm-up stays proven, and the file drops every template it creates.
 * Drops are spread across hooks because a serialized drop costs about 2.5-3.2 s on a default-durability Windows cluster: single-module cases
 * drop their template in `afterEach`, the concurrent case's three templates are dropped in `afterAll`, and no hook carries all six.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __pgTestTemplateTestHooks,
  execPgAdminStatement,
  PG_AVAILABLE,
  type PgTestHarness,
} from "../../__test-utils__/pg-test-harness.js";

type HarnessModule = typeof import("../../__test-utils__/pg-test-harness.js");

const testDescribe = PG_AVAILABLE ? describe : describe.skip;

/** Every module instance loaded by this file, so `afterAll` can prove none of their templates remain. */
const loadedModules: HarnessModule[] = [];
/** Module instances loaded by the running case; reset in `beforeEach`. */
let caseModules: HarnessModule[] = [];
/** Templates of multi-module cases, dropped serially in `afterAll` to keep each hook within its budget. */
const deferredTemplateModules: HarnessModule[] = [];

async function loadFreshHarnessModule(): Promise<HarnessModule> {
  vi.resetModules();
  const harnessModule = await import("../../__test-utils__/pg-test-harness.js");
  loadedModules.push(harnessModule);
  caseModules.push(harnessModule);
  return harnessModule;
}

/** Pid of a child process that has already exited, so a template named after it is reclaimable. */
function exitedProcessPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  if (typeof child.pid !== "number" || child.pid <= 0) {
    throw new Error("could not obtain the pid of an exited child process");
  }
  return child.pid;
}

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function assertTaskRoundTrip(harness: PgTestHarness, description: string): Promise<void> {
  const task = await harness.store.createTask({ description });
  await expect(harness.store.getTask(task.id)).resolves.toMatchObject({
    id: task.id,
    description,
  });
}

async function teardownAll(harnesses: readonly PgTestHarness[]): Promise<void> {
  await Promise.all(harnesses.map((harness) => harness.teardown()));
}

testDescribe("PG template database lifecycle across isolated harness modules", () => {
  const harnesses: PgTestHarness[] = [];
  let deadOwnerTemplateName = "";

  beforeAll(async () => {
    const deadPid = exitedProcessPid();
    expect(processIsGone(deadPid)).toBe(true);
    deadOwnerTemplateName = `fusion_schema_template_${deadPid}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await execPgAdminStatement(`CREATE DATABASE "${deadOwnerTemplateName}" TEMPLATE template0`);
    await __pgTestTemplateTestHooks.ensureGoldenTemplate();
  });

  beforeEach(() => {
    caseModules = [];
  });

  afterEach(async () => {
    await teardownAll(harnesses.splice(0));
    const modules = caseModules;
    caseModules = [];
    if (modules.length === 1) {
      await modules[0].__pgTestTemplateTestHooks.dropTemplate();
    } else {
      deferredTemplateModules.push(...modules);
    }
  });

  afterAll(async () => {
    for (const harnessModule of deferredTemplateModules.splice(0)) {
      await harnessModule.__pgTestTemplateTestHooks.dropTemplate();
    }
    for (const harnessModule of loadedModules) {
      expect(await harnessModule.__pgTestTemplateTestHooks.templateExists()).toBe(false);
    }
  });

  it("reclaims dead-owner template databases during suite warm-up", async () => {
    expect(await __pgTestTemplateTestHooks.databaseExists(deadOwnerTemplateName)).toBe(false);
  });

  it("creates usable isolated stores concurrently from fresh same-pid module instances", async () => {
    const modules: HarnessModule[] = [];
    for (let index = 0; index < 3; index += 1) {
      modules.push(await loadFreshHarnessModule());
    }

    const created = await Promise.all(
      modules.map((harnessModule, moduleIndex) =>
        harnessModule.createTaskStoreForTest({ prefix: `template_concurrent_${moduleIndex}` }),
      ),
    );
    harnesses.push(...created);

    await Promise.all(
      created.map((harness, index) =>
        assertTaskRoundTrip(harness, `concurrent module store ${index}`),
      ),
    );
  });

  it("builds a missing template before copying its first store", async () => {
    const harnessModule = await loadFreshHarnessModule();
    await harnessModule.__pgTestTemplateTestHooks.dropTemplate();
    expect(await harnessModule.__pgTestTemplateTestHooks.templateExists()).toBe(false);

    const harness = await harnessModule.createTaskStoreForTest({ prefix: "template_missing" });
    harnesses.push(harness);

    expect(await harnessModule.__pgTestTemplateTestHooks.templateExists()).toBe(true);
    await assertTaskRoundTrip(harness, "missing template recovery");
  });

  it("reuses the valid template memo within one module instance", async () => {
    const harnessModule = await loadFreshHarnessModule();
    const templateName = harnessModule.__pgTestTemplateTestHooks.templateName();
    const first = await harnessModule.createTaskStoreForTest({ prefix: "template_reuse_first" });
    const second = await harnessModule.createTaskStoreForTest({ prefix: "template_reuse_second" });
    harnesses.push(first, second);

    expect(harnessModule.__pgTestTemplateTestHooks.templateName()).toBe(templateName);
    expect(await harnessModule.__pgTestTemplateTestHooks.templateExists()).toBe(true);
    await Promise.all([
      assertTaskRoundTrip(first, "first valid template copy"),
      assertTaskRoundTrip(second, "second valid template copy"),
    ]);
  });

  it("rebuilds a half-built template into a usable schema copy", async () => {
    const harnessModule = await loadFreshHarnessModule();
    await harnessModule.__pgTestTemplateTestHooks.createHalfBuiltTemplate();

    const harness = await harnessModule.createTaskStoreForTest({ prefix: "template_half_built" });
    harnesses.push(harness);

    expect(await harnessModule.__pgTestTemplateTestHooks.templateExists()).toBe(true);
    await assertTaskRoundTrip(harness, "half-built template recovery");
  });
});
