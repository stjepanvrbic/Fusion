/*
FNXC:PgTestHarnessResetSpeed 2026-10-11-10:38:
The shared PostgreSQL harness must fail the test that leaks a write, by name, instead of letting the leak surface as a duplicate primary key in the next test.
These cases drive real leaks against a real server: a transaction held open on the store pool, a single statement blocked on a lock, and idle connections that must not count.

FNXC:PgTestHarnessResetSpeed 2026-10-11-11:02:
Both checks wait for open work inside a settle window before they fail. The first suite uses a short window so work that outlasts it is reported quickly; the second keeps the default window and proves work that finishes inside it is waited out.
*/

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, onTestFailed } from "vitest";
import postgres, { type Sql } from "postgres";
import { sql } from "drizzle-orm";
import * as schema from "../../postgres/schema/index.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  PG_HARNESS_ADMIN_APPLICATION_NAME,
  PG_HARNESS_OPEN_BACKENDS_SQL,
  PG_HARNESS_SETUP_OWNER,
  PgHarnessLeakedWriteError,
  type PgHarnessOpenBackend,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const PROJECT_ID = "durable-project";
const EVENT_TS = "2026-08-09T12:00:00.000Z";
const SERVER_STATE_WAIT_MS = 2_000;
const SHORT_SETTLE_WAIT_MS = 100;

function usageEvent(kind: string) {
  return { projectId: PROJECT_ID, ts: EVENT_TS, kind, agentId: "durable-1", category: "agent-session" };
}

/**
 * Opens a transaction on the store pool, runs `work` in it and keeps it open until `settle()`.
 * `entered` resolves once the server has executed `work`, so the transaction is open server-side.
 */
function holdStoreTransaction(
  harness: SharedPgTaskStoreHarness,
  work: (tx: Parameters<Parameters<ReturnType<SharedPgTaskStoreHarness["layer"]>["db"]["transaction"]>[0]>[0]) => Promise<unknown>,
): { readonly entered: Promise<void>; readonly settle: () => Promise<void> } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const committed = harness.layer().db.transaction(async (tx) => {
    await work(tx);
    markEntered();
    await gate;
  });
  return {
    entered,
    settle: async () => {
      release();
      await committed;
    },
  };
}

type HeldTransaction = ReturnType<typeof holdStoreTransaction>;

function holdUsageEventInsert(harness: SharedPgTaskStoreHarness): HeldTransaction {
  return holdStoreTransaction(harness, (tx) => tx.insert(schema.project.usageEvents).values(usageEvent("tool_call")));
}

/** Polls a server-state predicate on `client` until it holds; a state sync, bounded at two seconds. */
async function waitForServerState(client: Sql, predicateSql: string): Promise<void> {
  const deadline = Date.now() + SERVER_STATE_WAIT_MS;
  for (;;) {
    const [row] = await client.unsafe<Array<{ ok: boolean }>>(`SELECT (${predicateSql}) AS ok`);
    if (row?.ok) return;
    if (Date.now() > deadline) throw new Error(`server state not reached within ${SERVER_STATE_WAIT_MS} ms: ${predicateSql}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A client on the maintenance database: its polling is never an open statement on the test database. */
function maintenanceClient(harness: SharedPgTaskStoreHarness): Sql {
  const url = new URL(harness.testUrl());
  url.pathname = "/postgres";
  return postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
}

/** True while the harness admin backend sleeps inside the named harness statement, waiting for open work to finish. */
function harnessIsWaitingIn(harness: SharedPgTaskStoreHarness, statementTag: "fusion_reset" | "fusion_settle"): string {
  const databaseName = new URL(harness.testUrl()).pathname.slice(1);
  return `EXISTS (SELECT 1 FROM pg_stat_activity
    WHERE datname = '${databaseName}' AND application_name = '${PG_HARNESS_ADMIN_APPLICATION_NAME}'
      AND wait_event = 'PgSleep' AND query LIKE '%$${statementTag}$%')`;
}

async function usageEventIds(harness: SharedPgTaskStoreHarness): Promise<number[]> {
  const rows = await harness.adminSql()<Array<{ id: number }>>`SELECT id FROM project.usage_events ORDER BY id`;
  return rows.map((row) => row.id);
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => { throw new Error("expected the reset to be refused"); },
    (error: unknown) => error,
  );
}

function currentTest(): { name: string; file: string } {
  const state = expect.getState();
  return { name: state.currentTestName ?? "", file: state.testPath ?? "" };
}

/** The fields of a harness leak error that survive Vitest's error serialization on `task.result.errors`. */
interface RecordedLeakError {
  readonly name?: string;
  readonly message?: string;
  readonly phase?: string;
  readonly testName?: string;
  readonly testFile?: string;
}

/** Records every statement the harness sends on its admin client until `restore()`. */
function recordAdminStatements(harness: SharedPgTaskStoreHarness): { readonly statements: string[]; readonly restore: () => void } {
  const adminSql = harness.adminSql();
  const unsafe = adminSql.unsafe;
  const statements: string[] = [];
  adminSql.unsafe = ((query: string, ...rest: unknown[]) => {
    statements.push(query);
    return (unsafe as (...args: unknown[]) => unknown).call(adminSql, query, ...rest);
  }) as typeof unsafe;
  return { statements, restore: () => { adminSql.unsafe = unsafe; } };
}

/*
The leaking cases are declared with it.fails: the harness end-of-test check is what fails them, and the case after each one asserts what that failure said.
*/
pgDescribe("shared PostgreSQL harness names the test whose open work outlasts the settle window", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_shared_harness_leak",
    projectId: PROJECT_ID,
    settleWaitMs: SHORT_SETTLE_WAIT_MS,
  });
  let leaker = { name: "", file: "" };
  let leakerErrors: RecordedLeakError[] = [];
  let settleStatements = 0;
  let unsettledLeak: HeldTransaction | undefined;
  let expiredWait: unknown;
  let nextRefusal: unknown;
  let resetWaitBudgets: number[] = [];

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    if (!unsettledLeak) {
      await h.beforeEach();
      return;
    }
    const leak = unsettledLeak;
    unsettledLeak = undefined;
    const recorded = recordAdminStatements(h);
    try {
      expiredWait = await rejectionOf(h.beforeEach());
      nextRefusal = await rejectionOf(h.beforeEach());
    } finally {
      recorded.restore();
      await leak.settle();
    }
    resetWaitBudgets = recorded.statements
      .filter((statement) => statement.includes("$fusion_reset$"))
      .map((statement) => Number(/interval '([\d.]+) milliseconds'/.exec(statement)?.[1]));
    await h.beforeEach();
  });
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("refuses the reset, names the test that ran since the last reset, and leaves no stale identity behind", async () => {
    const { db } = h.layer();
    await db.insert(schema.project.usageEvents).values(usageEvent("session_start"));
    const held = holdUsageEventInsert(h);
    let refusal: unknown;
    try {
      await held.entered;
      refusal = await rejectionOf(h.beforeEach());
      // A refused reset changes nothing: the committed row is still there.
      expect(await usageEventIds(h)).toEqual([1]);
    } finally {
      await held.settle();
    }

    expect(refusal).toBeInstanceOf(PgHarnessLeakedWriteError);
    const leak = refusal as PgHarnessLeakedWriteError;
    const test = currentTest();
    expect(leak.phase).toBe("start of reset");
    expect(leak.testName).toBe(test.name);
    expect(leak.testFile).toBe(test.file);
    expect(leak.waitedMs).toBe(SHORT_SETTLE_WAIT_MS);
    expect(leak.backends).toHaveLength(1);
    expect(leak.backends[0].state).toBe("idle in transaction");
    expect(leak.backends[0].application_name).not.toBe(PG_HARNESS_ADMIN_APPLICATION_NAME);
    expect(leak.backends[0].query).toContain("usage_events");
    expect(leak.message).toContain(test.name);
    expect(leak.message).toContain(`pid ${leak.backends[0].pid}`);

    // The leaked row committed with identity 2. Once it has settled the reset succeeds and identities restart.
    expect(await usageEventIds(h)).toEqual([1, 2]);
    await h.beforeEach();
    expect(await usageEventIds(h)).toEqual([]);
    await db.insert(schema.project.usageEvents).values([
      usageEvent("session_start"),
      { ...usageEvent("session_start"), ts: "2026-08-10T12:00:00.000Z", agentId: "outside" },
      { ...usageEvent("session_start"), projectId: "other-project", agentId: "other" },
    ]);
    expect(await usageEventIds(h)).toEqual([1, 2, 3]);
  });

  it("treats a single running statement like an open transaction", async () => {
    const lockKey = 116_001;
    const holder = await h.adminSql().reserve();
    let blocked: Promise<unknown> | undefined;
    let refusal: unknown;
    try {
      // A session-level lock leaves the holder idle outside any transaction, so only the blocked statement is open.
      await holder`SELECT pg_advisory_lock(${lockKey})`;
      // Drizzle queries start only when awaited; Promise.resolve subscribes at once so the statement reaches the server.
      blocked = Promise.resolve(h.layer().db.execute(sql`SELECT pg_advisory_xact_lock(${lockKey})`));
      await waitForServerState(h.adminSql(), "EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted)");
      refusal = await rejectionOf(h.beforeEach());
    } finally {
      await holder`SELECT pg_advisory_unlock(${lockKey})`;
      holder.release();
      await blocked;
    }

    expect(refusal).toBeInstanceOf(PgHarnessLeakedWriteError);
    const leak = refusal as PgHarnessLeakedWriteError;
    expect(leak.backends).toHaveLength(1);
    expect(leak.backends[0].state).toBe("active");
    expect(leak.backends[0].query).toContain("pg_advisory_xact_lock");
    await h.beforeEach();
  });

  it("names harness setup when work is open before any test has run", async () => {
    const fresh = createSharedPgTaskStoreTestHarness({
      prefix: "fusion_shared_harness_leak_setup",
      projectId: PROJECT_ID,
      settleWaitMs: SHORT_SETTLE_WAIT_MS,
    });
    await fresh.beforeAll();
    try {
      const held = holdUsageEventInsert(fresh);
      let refusal: unknown;
      try {
        await held.entered;
        refusal = await rejectionOf(fresh.beforeEach());
      } finally {
        await held.settle();
      }
      expect(refusal).toBeInstanceOf(PgHarnessLeakedWriteError);
      const leak = refusal as PgHarnessLeakedWriteError;
      expect(leak.phase).toBe("start of reset");
      expect(leak.testName).toBe(PG_HARNESS_SETUP_OWNER);
      expect(leak.backends).toHaveLength(1);
    } finally {
      await fresh.afterAll();
    }
  });

  it.fails("leaker: returns while a store transaction it opened is still open", async () => {
    leaker = currentTest();
    leakerErrors = [];
    const held = holdUsageEventInsert(h);
    onTestFailed(async ({ task }) => {
      leakerErrors = (task.result?.errors ?? []) as RecordedLeakError[];
      await held.settle();
    });
    await held.entered;
  });

  it("failed the leaking test itself, naming it and its open transaction", () => {
    expect(leakerErrors).toHaveLength(1);
    const [error] = leakerErrors;
    expect(error.name).toBe("PgHarnessLeakedWriteError");
    expect(error.phase).toBe("end of test");
    expect(error.testName).toBe(leaker.name);
    expect(error.testFile).toBe(leaker.file);
    expect(error.message).toContain(leaker.name);
    expect(error.message).toContain("idle in transaction");
    expect(error.message).toContain("usage_events");
  });

  it.fails("leaker: resets manually mid-test and then leaks one transaction", async () => {
    leakerErrors = [];
    await h.beforeEach();
    const recorded = recordAdminStatements(h);
    const held = holdUsageEventInsert(h);
    onTestFailed(async ({ task }) => {
      leakerErrors = (task.result?.errors ?? []) as RecordedLeakError[];
      recorded.restore();
      settleStatements = recorded.statements.filter((statement) => statement.includes("$fusion_settle$")).length;
      await held.settle();
    });
    await held.entered;
  });

  it("ran one end-of-test check for a test that reset manually mid-test", () => {
    expect(settleStatements).toBe(1);
    expect(leakerErrors).toHaveLength(1);
    expect(leakerErrors[0].phase).toBe("end of test");
  });

  it.fails("leaker: holds a store transaction past the next reset", async () => {
    leaker = currentTest();
    unsettledLeak = holdUsageEventInsert(h);
    await unsettledLeak.entered;
  });

  it("failed the next reset with the leaker's name after one settle window, then stopped waiting", () => {
    for (const refusal of [expiredWait, nextRefusal]) {
      expect(refusal).toBeInstanceOf(PgHarnessLeakedWriteError);
      const leak = refusal as PgHarnessLeakedWriteError;
      expect(leak.phase).toBe("start of reset");
      expect(leak.testName).toBe(leaker.name);
      expect(leak.testFile).toBe(leaker.file);
      expect(leak.backends).toHaveLength(1);
    }
    // The first reset waited the full window; the reset after it met the same transaction and did not wait again.
    expect(resetWaitBudgets[0]).toBe(SHORT_SETTLE_WAIT_MS);
    expect(resetWaitBudgets.at(-1)).toBe(0);
  });
});

pgDescribe("shared PostgreSQL harness waits for work that finishes inside the settle window", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_shared_harness_settle",
    projectId: PROJECT_ID,
  });
  let maintenance: Sql;
  let lateWrite: Promise<void> | undefined;
  let sawEndOfTestWait = false;

  beforeAll(async () => {
    await h.beforeAll();
    maintenance = maintenanceClient(h);
  });
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(async () => {
    await maintenance.end({ timeout: 5 });
    await h.afterAll();
  });

  it("does not treat idle connections as leaks", async () => {
    await h.store().createTask({ description: "settled write" });
    const reserved = await h.adminSql().reserve();
    const direct = postgres(h.testUrl(), { max: 1, prepare: false, onnotice: () => {} });
    try {
      await reserved`SELECT 1`;
      await direct`SELECT 1`;
      await h.beforeEach();
      expect(await h.store().listTasks()).toHaveLength(0);
    } finally {
      reserved.release();
      await direct.end({ timeout: 5 });
    }
  });

  it("reads fresh backend state after clearing the statistics snapshot inside one transaction", async () => {
    let held: HeldTransaction | undefined;
    try {
      const seen = await h.adminSql().begin(async (tx) => {
        const before = await tx.unsafe<PgHarnessOpenBackend[]>(PG_HARNESS_OPEN_BACKENDS_SQL);
        held = holdUsageEventInsert(h);
        await held.entered;
        const stale = await tx.unsafe<PgHarnessOpenBackend[]>(PG_HARNESS_OPEN_BACKENDS_SQL);
        await tx.unsafe("SELECT pg_stat_clear_snapshot()");
        const fresh = await tx.unsafe<PgHarnessOpenBackend[]>(PG_HARNESS_OPEN_BACKENDS_SQL);
        return { before: before.length, stale: stale.length, fresh: fresh.length };
      });
      // The second read reuses the transaction's first snapshot; only the read after the clear sees the new transaction.
      expect(seen).toEqual({ before: 0, stale: 0, fresh: 1 });
    } finally {
      await held?.settle();
    }
  });

  it("waits at the reset for an open write to commit, then wipes it and restarts identities", async () => {
    const { db } = h.layer();
    await db.insert(schema.project.usageEvents).values(usageEvent("session_start"));
    const held = holdUsageEventInsert(h);
    await held.entered;
    const reset = h.beforeEach();
    reset.catch(() => {});
    try {
      await waitForServerState(maintenance, harnessIsWaitingIn(h, "fusion_reset"));
    } finally {
      await held.settle();
    }
    await reset;

    expect(await usageEventIds(h)).toEqual([]);
    await db.insert(schema.project.usageEvents).values(usageEvent("session_start"));
    expect(await usageEventIds(h)).toEqual([1]);
  });

  it("returns while a write is still in flight that commits once the end-of-test check is waiting", async () => {
    const held = holdUsageEventInsert(h);
    await held.entered;
    // Deliberately not awaited: the write outlives the test body and finishes inside the settle window.
    lateWrite = (async () => {
      try {
        await waitForServerState(maintenance, harnessIsWaitingIn(h, "fusion_settle"));
        sawEndOfTestWait = true;
      } finally {
        await held.settle();
      }
    })();
    lateWrite.catch(() => {});
  });

  it("passed the previous test and started on a clean database after its late write", async () => {
    await lateWrite;
    expect(sawEndOfTestWait).toBe(true);
    expect(await usageEventIds(h)).toEqual([]);
    await h.layer().db.insert(schema.project.usageEvents).values(usageEvent("session_start"));
    expect(await usageEventIds(h)).toEqual([1]);
  });
});
