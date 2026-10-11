#!/usr/bin/env node

import { createRequire } from "node:module";
import { join } from "node:path";
import { URL } from "node:url";
import { isEntryPoint } from "./lib/is-entry-point.mjs";

/*
FNXC:TestInfraWindows 2026-10-11-07:02:
The Windows Full Suite lane runs its PostgreSQL tests against the runner's preinstalled cluster, which is discarded with the job, so crash safety is pure cost there.
On native Windows PostgreSQL the harness's DROP DATABASE calls are flush-bound: three concurrent teardown drops took 9.7-10.4 s with default durability and 2.1-2.6 s non-durable, and a reclamation sweep plus golden rebuild took 20.3 s against 6.4 s.
PostgreSQL documents fsync, synchronous_commit and full_page_writes off as the configuration for data that need not survive an operating-system crash: https://www.postgresql.org/docs/15/non-durability.html
These settings remove crash safety for the whole cluster, so the command refuses to run without an explicit --throwaway declaration, and nothing else (no harness, Vitest setup or test) may issue them.
ALTER SYSTEM may not run inside a transaction block (https://www.postgresql.org/docs/17/sql-altersystem.html), so each setting is its own statement; pg_reload_conf() is asynchronous, so the effective values are polled until they read off.
*/

/** Settings that make a cluster non-durable, each set to `off`. */
export const NON_DURABLE_SETTINGS = Object.freeze(["fsync", "synchronous_commit", "full_page_writes"]);

const USAGE = "usage: node scripts/pg-test-cluster-non-durable.mjs --throwaway\n"
  + "Makes the PostgreSQL cluster at FUSION_PG_TEST_URL_BASE non-durable (fsync, synchronous_commit, full_page_writes off).\n"
  + "--throwaway is required: the settings remove crash safety for the whole cluster, so use it only on a cluster that is discarded after the run.";

/**
 * Applies the non-durable settings and waits until the server reports them in effect.
 *
 * @param {{ query: (statement: string) => Promise<Array<Record<string, unknown>>>, sleep?: (ms: number) => Promise<void>, maxPolls?: number, pollIntervalMs?: number }} options
 *   `query` runs one statement and resolves with its rows.
 * @returns {Promise<{ version: string, settings: Record<string, string> }>}
 */
export async function makeClusterNonDurable({ query, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxPolls = 20, pollIntervalMs = 250 }) {
  for (const name of NON_DURABLE_SETTINGS) {
    await query(`ALTER SYSTEM SET ${name} = off`);
  }
  await query("SELECT pg_reload_conf()");

  let settings = {};
  for (let poll = 1; poll <= maxPolls; poll += 1) {
    settings = {};
    for (const name of NON_DURABLE_SETTINGS) {
      const rows = await query(`SHOW ${name}`);
      settings[name] = String(rows[0]?.[name]);
    }
    if (NON_DURABLE_SETTINGS.every((name) => settings[name] === "off")) {
      const versionRows = await query("SELECT version()");
      return { version: String(versionRows[0]?.version), settings };
    }
    if (poll < maxPolls) await sleep(pollIntervalMs);
  }
  const pending = NON_DURABLE_SETTINGS.filter((name) => settings[name] !== "off");
  throw new Error(`setting(s) not in effect after ${maxPolls} polls: ${pending.map((name) => `${name}=${settings[name]}`).join(", ")}`);
}

function postgresClient() {
  const loaded = createRequire(join(process.cwd(), "packages/core/package.json"))("postgres");
  return loaded.default ?? loaded;
}

/**
 * Command-line entry. Exit codes: 0 applied, 1 failed, 2 refused (usage).
 *
 * @param {string[]} argv arguments after the script path.
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2), env = process.env) {
  if (!argv.includes("--throwaway")) {
    console.error(`refused: --throwaway is required.\n${USAGE}`);
    return 2;
  }
  const urlBase = env.FUSION_PG_TEST_URL_BASE?.trim();
  if (!urlBase) {
    console.error(`refused: FUSION_PG_TEST_URL_BASE is not set.\n${USAGE}`);
    return 2;
  }

  let client;
  try {
    const maintenance = new URL(urlBase);
    maintenance.pathname = "/postgres";
    client = postgresClient()(maintenance.toString(), { max: 1, prepare: false, onnotice: () => {} });
    const { version, settings } = await makeClusterNonDurable({ query: (statement) => client.unsafe(statement) });
    console.log(version);
    for (const name of NON_DURABLE_SETTINGS) console.log(`${name} = ${settings[name]}`);
    return 0;
  } catch (error) {
    console.error(`failed to make the cluster non-durable: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await client?.end({ timeout: 5 }).catch(() => {});
  }
}

if (isEntryPoint(import.meta.url)) process.exitCode = await main();
