---
category: test-failures
module: testing
date: 2026-08-01
problem_type: suite_only_flake
component: PostgreSQL test infrastructure
severity: medium
applies_when:
  - "A test fails under full-suite parallelism but passes when run alone"
  - "A first flake sighting is in a file whose remaining coverage is substantial"
  - "Capturing evidence before a file-level quarantine decision"
  - "A merge-gate canary is evicted from the blocking gate after a flake sighting"
tags:
  - flake
  - postgres
  - full-suite
  - quarantine
---

# Observed suite-only flakes register

This register has **9 active observation records** (entries 2, 13, 20, 21, 25, 32, 33, 35, and 37): eight **active first sightings** and one **reproduced escalation awaiting an owner decision** (entry 13). Entries 1, 15, 18, 27, 36, and 38 closed after structural fixes with recorded verification, and stay in place below for campaign and first-sighting evidence. Entries 7 and 14 below are closed and retained for cross-reference only. It also has **1 merge-gate eviction record** (entry 6) and **22 archived closed records**. Only the active section drives quarantine and escalation decisions; the other sections preserve historical evidence.

<!--
FNXC:TestFlakeRegister 2026-08-19-11:14:
The flat register mixed closed narratives with open records, making it unusable as a quarantine-on-sight decision aid. Sections make the active decision surface explicit while entry numbers and heading text remain frozen for inbound anchors and cross-reference stability. Active status lines must distinguish first sightings from reproduced escalations and name the evidence owners retained by each record.
-->

<!--
FNXC:TestFlakeRegister 2026-09-03-22:23:
FN-9146 (the named evidence owner of active records 1 and 2 and the retained-evidence owner for
entries 1, 2, and 13) was archived on 2026-09-03 without a named successor. A register that names
an archived owner as live lies about ownership — the exact failure FN-9146 was created to fix — so
the status lines and the common-shape summary now record the archived-owner fact and the unowned
pending-next-sighting state. The pinned validator assertions in
scripts/__tests__/observed-flake-register.test.mjs were updated in the same change.
-->

<!--
FNXC:TestFlakeRegister 2026-09-12-04:32:
Entry 1's reproduced 15s project-identity timeout was structurally fixed by FN-9131 (queueing
admission in the shared PostgreSQL harness connection budget, wait hoisted off the test budget,
loaded 27-worker re-measurement green; merged 2026-08-16 as ae507afc37). No sighting in the
~4 weeks since. Closing the record — leaving it active would name an archived owner and deny
the landed fix, the same lie-about-ownership failure FN-9146's note fixed for FN-9146. The
record stays physically in the active section because the pinned campaign-evidence test reads
its per-run table in place, mirroring the entry 7 precedent.
-->

<!--
FNXC:TestFlakeRegister 2026-10-08-07:19:
KB-043 recorded the operator-reported pair of transient sqlite-migrator `unable to open database file` failures as entry 33, a single first-sighting record whose next sighting is an immediate file-level quarantine.
The operator's second listed flake, the register-signal-routes teardown timeout, was already entry 25, so no duplicate line was added.

FNXC:TestFlakeRegister 2026-10-08-13:53:
The KB-043 record lands as entry 37 because main had already assigned entries 33 through 36 when it merged.
-->

## Active observation records

### 1. Project identity returns no stored identity

- **Status:** Closed 2026-09-12 — structurally resolved by FN-9131 (queueing admission in the shared PostgreSQL harness connection budget; merged 2026-08-16 as `ae507afc37`; loaded 27-worker re-measurement green). No sighting since the fix landed; a new sighting re-opens normal escalation.

- **File:** `packages/core/src/__tests__/postgres/project-identity.test.ts`
- **Exact test:** `project-identity async (PostgreSQL integration) > returns null when no identity is stored`
- **Observed tree/SHA:** `origin/main` at `7927c7b58a`
- **Observed frequency:** 1-in-3 full-core-suite runs.

| run | result |
|---|---|
| full core suite (1st) | **1 failed** / 4824 passed |
| full core suite (2nd) | 4825 passed |
| full core suite (3rd) | 4825 passed |
| file alone ×2 | 6 passed, 6 passed |

**Evidence gathering pending 2026-08-16 (FN-9125):** Current-sha diagnosis did not reproduce this historical first sighting: three six-worker full-core lanes and a twelve-worker PostgreSQL-directory run retained full output without this subject failing. The harness uses a shared golden template plus per-module copies, but no direct evidence tied this identity's null read to shared state. This is not superseded or resolved: the required complete loaded failure capture is absent. Core PostgreSQL quarantine is policy-forbidden, so FN-9126 owns CI/host-specific activity instrumentation, full failure capture, and the escalation decision.

| verification | result |
|---|---|
| full core ×3, 6 workers | subject passed; unrelated settings-revision-attribution failure |
| PostgreSQL directory, 12 workers | subject passed; unrelated satellite-store ordering failure |

**Closed 2026-09-12 (FN-9131):** The reproduced subject is no longer active. FN-9131 diagnosed the mechanism behind the A02–A04 captures — the shared harness sized connections from constants and never asked the cluster how many backends exist or how many participants compete for them, so at 27 forks demand more than doubled `max_connections` and the first test in a file (`project-identity.test.ts:41:3`) consumed its whole 15s budget waiting — and shipped the structural fix in `packages/core/src/__test-utils__/pg-connection-budget.ts`: over-subscription became queueing (a participant that cannot be admitted waits holding zero backends, and admission exhaustion never throws into a test or hook), the first admission window moved to the shared per-worker setup module off the test budget, and the per-participant footprint shrank until the measured wait fit the R9 bound. The loaded acceptance — the exact 27-worker reproduction completing with the subject passing and no wall-time regression against the 177–203s pre-fix band, peak backends below `max_connections`, and the concurrent `pnpm test:gate` shape holding the same bound — is recorded done in FN-9131's step 6. The fix has been on main since 2026-08-16 with no further sighting of this identity in the register's own later updates (2026-09-03, 2026-09-10) or any task. Core PostgreSQL quarantine was never needed. A new sighting of this identity re-opens normal escalation from an unowned state.

**Second sighting — reproduced 2026-08-16 (FN-9126):** A credential-free, sterile-environment PostgreSQL-directory pass at 27 workers reproduced the registered assertion as a timeout at `packages/core/src/__tests__/postgres/project-identity.test.ts:41:3` on `3c235ce275b626a73da4fe508ac76fd6f5fbd686`. The typed, executor-authored per-run evidence is durable in task FN-9126, document key `evidence`; it records the 100-connection server ceiling and all run counters without retaining runner output. This is an escalation, not a resolution: core-config quarantine remains policy-forbidden by the gate-policy assertion, so FN-9131 owns root-cause diagnosis and a structural fix.

| run | result |
|---|---|
| PostgreSQL directory, 27 workers (run 1) | subject passed; 173 files; 1335 passed / 31 failed / 4 skipped |
| PostgreSQL directory, 27 workers (run 2) | **subject timeout reproduced**; 173 files; 942 passed / 46 failed / 382 skipped |

<!--
FNXC:PostgresFlakeDiagnosis 2026-08-19-12:25:
FN-9146 requires every active core PostgreSQL record to retain its own complete campaign verdict. Each per-run row carries the lane shape, selected subject result, wall-clock, whole-lane outcome, and measured cluster capacity so later sightings cannot collapse evidence from a different identity or mistake an unsampled run for pressure evidence.
-->

**Campaign outcome 2026-08-19 (FN-9146):** The pre-registered A×4/B×3/C×3/D×2 campaign completed at `ed2cbd08a13f02f1fa5e19d5072c471bb972a315` on PostgreSQL 15.15. The exact null-read identity timed out at its inherited 15s budget in A02–A04. Snapshots peaked at 73, 62, and 71 backends, below the 97 ordinary slots, and showed concurrent DDL/checkpoint/object-lock/WAL waits. Those records do not name a causal lifecycle seam: connection exhaustion, template ownership, drop contention, and the deliberately-unwired budget primitive remain unproven. Entry 1 stays active and reproduced-but-unattributed under FN-9146; no structural change, timeout/retry, or core-PG quarantine was made. Complete combined output and teardown JSONL for A01–D02 are durable FN-9146 task attachments, with parsed checkpoints in its task documents.

**Capacity-evidence remediation 2026-08-19 (FN-9146):** C01–C03's original green default-core logs had no activity snapshot, so they cannot substantiate a peak. One sampled replacement per affected shape (C01R–C03R) completed green with an external 250ms `pg_stat_activity` count sampler: 28/31/30 observed backends across 583/491/508 samples. The table labels retain the pre-registered C identities and disclose their sampled replacements; these are new measurements, not retroactive values for the original C logs. Each replacement retained full runner output, teardown JSONL, and sampler output in FN-9146's durable evidence checkpoint; after C03R, the dead-owner golden template was dropped and the leftover count returned to zero.

| run | shape / workers | wall | subject result | whole-lane result | cluster capacity (`max`/ordinary; peak) |
|---|---|---:|---|---|---|
| A01 | directory / 27 | 235.8s | pass | 25 files / 45 tests red | 100/97; 73 |
| A02 | directory / 27 | 220.2s | **captured: 15s timeout** | 60 files / 42 tests red | 100/97; 73 |
| A03 | directory / 27 | 205.5s | **captured: 15s timeout** | 35 files / 31 tests red | 100/97; 62 |
| A04 | directory / 27 | 224.2s | **captured: 15s timeout** | 36 files / 39 tests red | 100/97; 71 |
| B01 | directory / 12 | 110.8s | pass | green, 176 files / 1385 pass / 1 skip | 100/97; 26 |
| B02 | directory / 12 | 119.2s | pass | green, 176 files / 1385 pass / 1 skip | 100/97; 36 |
| B03 | directory / 12 | 121.1s | pass | green, 176 files / 1385 pass / 1 skip | 100/97; 28 |
| C01 / C01R | core default | 163.5s | pass | green, 580 files / 5686 pass / 3 skip | 100/97; 28 (583 samples) |
| C02 / C02R | core default | 136.6s | pass | green, 580 files / 5686 pass / 3 skip | 100/97; 31 (491 samples) |
| C03 / C03R | core default | 141.1s | pass | green, 580 files / 5686 pass / 3 skip | 100/97; 30 (508 samples) |
| D01 | configured pg gate / 4 forks | 3.6s | not selected | green, 2 files / 10 pass | 100/97; not sampled |
| D02 | configured pg gate / 4 forks | 3.7s | not selected | green, 2 files / 10 pass | 100/97; not sampled |

### 2. Schema applier retains registered dependents

- **Status:** Active first sighting — evidence owner FN-9146 (archived 2026-09-03; record unowned pending next sighting).

The FN-9128 harness-isolation fix does not close this record because no reproduced failure explained the original assertion mechanism.

- **Owner:** FN-9128 (archived); FN-9146 (archived 2026-09-03) retains the campaign evidence; record unowned pending next sighting.
- **File:** `packages/core/src/__tests__/postgres/schema-applier.test.ts`
- **Exact test:** `schema-applier: VAL-SCHEMA-001 final-schema parity (table counts) > retains unreplaced registered dependents for every delete action`
- **Original observed tree:** PR [#2828](https://github.com/Runfusion/Fusion/pull/2828) merged-with-main.
- **Investigation tree/SHA:** `7380be699cfeb37f4fe706455cb07ef274d6cf31`.

The original failure block was not retained, so its mode cannot be reconstructed. FN-9128 ran the requested full-output campaign and **did not reproduce the registered test**: isolated control passed (45.6s); loaded core at default 6 workers (134.2s), 4 workers (159.0s), 8 workers (128.8s), and 12 workers (146.3s), plus a sampled 12-worker run (155.0s), all passed the schema-applier file and registered identity. The loaded runs retained unrelated settings-attribution failures at every fan-out; the 12-worker unsampled run also retained two unrelated command-center-activity failures. Those failures are not attributed to this entry.

DDL microbenchmarks of the pre-fix pristine shape measured `CREATE DATABASE` 44.5–106.9ms, pool connect 7.7–13.9ms, `applySchemaBaseline` 372.4–388.2ms, and forced drop 42.8–310.1ms. The registered four-action loop consequently pays about 1.5s of baseline DDL before its body. A 500ms all-database `pg_stat_activity` sample during the 12-worker run observed database-wide `DataFileWrite`, checkpoint, WAL, catalog-object, and advisory-lock waits; it did not establish a registered-test causal failure.

**Resolved 2026-08-16 (FN-9128):** The absence of a reproduced failure is recorded honestly, but measured repeated DDL and the bypassed shared lifecycle justified a structural isolation fix. The subject now uses `pg-test-harness`: first-apply and upgrade contracts use `createEmptyPgTestDatabase`, while schema-present parity and FN-8419 rekey contracts (including the registered four-action loop) use serialized `createBaselinedPgTestDatabase` clones, making their later apply a marker check instead of repeated DDL. Regression coverage proves both fixture states and that the registered path selects the baselined helper. No timeout, retry, assertion/title, skip, or quarantine change was made.

| run | result |
|---|---|
| full core suite on #2828 merged-with-main | **failed** (failure block unavailable) |
| file alone ×2 on the same tree | 75 passed, 75 passed |
| file alone on `origin/main` | passed |
| FN-9128 isolated + loaded campaign | registered test passed in every listed shape |

**Evidence gathering pending 2026-08-16 (FN-9125):** Current-sha loaded reproduction did not fail this assertion. This file still owns an inline unique `CREATE DATABASE` plus full baseline path rather than the shared template harness, but that is a distinct cost profile, not evidence that it caused the historical dependent-registration failure. This is not superseded or resolved: the required complete loaded failure capture is absent. FN-9128 exclusively owns entry 2's CI allocation/profile investigation and full failure capture; core PostgreSQL quarantine is policy-forbidden.

| verification | result |
|---|---|
| full core ×3, 6 workers | subject passed; unrelated settings-revision-attribution failure |
| PostgreSQL directory, 12 workers | subject passed; unrelated satellite-store ordering failure |

**Campaign outcome 2026-08-19 (FN-9146):** The exact registered dependents identity passed every subject-containing lane (A×4/B×3/C×3); D01–D02 do not select this file. The historical mode remains unattributed. Entry 2 stays active under FN-9146; the next sighting follows normal escalation and core PostgreSQL quarantine remains policy-forbidden. Complete combined output and teardown JSONL for A01–D02 are durable FN-9146 task attachments, with parsed checkpoints in its task documents.

**Capacity-evidence remediation 2026-08-19 (FN-9146):** C01–C03's original green default-core logs had no activity snapshot, so they cannot substantiate a peak. One sampled replacement per affected shape (C01R–C03R) completed green with an external 250ms `pg_stat_activity` count sampler: 28/31/30 observed backends across 583/491/508 samples. The table labels retain the pre-registered C identities and disclose their sampled replacements; these are new measurements, not retroactive values for the original C logs. Each replacement retained full runner output, teardown JSONL, and sampler output in FN-9146's durable evidence checkpoint; after C03R, the dead-owner golden template was dropped and the leftover count returned to zero.

| run | shape / workers | wall | subject result | whole-lane result | cluster capacity (`max`/ordinary; peak) |
|---|---|---:|---|---|---|
| A01 | directory / 27 | 235.8s | pass | 25 files / 45 tests red | 100/97; 73 |
| A02 | directory / 27 | 220.2s | pass | 60 files / 42 tests red | 100/97; 73 |
| A03 | directory / 27 | 205.5s | pass | 35 files / 31 tests red | 100/97; 62 |
| A04 | directory / 27 | 224.2s | pass | 36 files / 39 tests red | 100/97; 71 |
| B01 | directory / 12 | 110.8s | pass | green, 176 files / 1385 pass / 1 skip | 100/97; 26 |
| B02 | directory / 12 | 119.2s | pass | green, 176 files / 1385 pass / 1 skip | 100/97; 36 |
| B03 | directory / 12 | 121.1s | pass | green, 176 files / 1385 pass / 1 skip | 100/97; 28 |
| C01 / C01R | core default | 163.5s | pass | green, 580 files / 5686 pass / 3 skip | 100/97; 28 (583 samples) |
| C02 / C02R | core default | 136.6s | pass | green, 580 files / 5686 pass / 3 skip | 100/97; 31 (491 samples) |
| C03 / C03R | core default | 141.1s | pass | green, 580 files / 5686 pass / 3 skip | 100/97; 30 (508 samples) |
| D01 | configured pg gate / 4 forks | 3.6s | not selected | green, 2 files / 10 pass | 100/97; not sampled |
| D02 | configured pg gate / 4 forks | 3.7s | not selected | green, 2 files / 10 pass | 100/97; not sampled |

### 7. Mission store PostgreSQL teardown hook

- **Status:** Closed 2026-08-23 — file-level quarantine (second sighting of a different test in the same file); quarantine RESCUED and lifted 2026-09-02 by `9b29c6beab` (PR #3549).

- **File:** `packages/core/src/__tests__/postgres/mission-store.pg.test.ts`
- **Exact test:** `MissionStore (PostgreSQL backend mode)` suite `afterAll` hook (`h.afterAll`).
- **Observed tree/SHA:** `32f677bbc207e421fd260ae2ba22fcefeeef4d86` (FN-8979 worktree).
- **Observed frequency:** first observation in a direct targeted rerun; 61 tests in the file passed.

| run | result |
|---|---|
| targeted file with `--silent=passed-only` | passed (exit 0) |
| targeted file with dot reporter | **afterAll hook timed out** at 15s; 61 tests passed |

The timeout occurred after all test assertions and is unrelated to FN-8979's canonical mission-blocker contract. This file retains substantial coverage, so this first observation is recorded rather than quarantined. A second sighting requires the normal file-level quarantine decision.

**Evidence gathering pending 2026-08-17 (FN-9136):** The shared-harness teardown is serial (store, layer, admin client, `DROP DATABASE WITH (FORCE)`, temporary directory), so a loaded close/drop block remains a plausible historical mechanism. FN-9136's seven-pair per-fork `TRUNCATE` reuse campaign was rejected because its experimental fork cleanup leaked dead-owner databases; that rejection preserves isolation but does not resolve this original loaded timing symptom. FN-9127 retains CI/host-specific phase instrumentation and full failure capture ownership; core PostgreSQL quarantine is policy-forbidden.

| verification | result |
|---|---|
| targeted dot reporter ×3 | 61 tests passed; afterAll passed |
| full core ×3, 6 workers | subject passed; unrelated settings-revision-attribution failure |

**Instrumented outcome 2026-08-16 (FN-9127): entry 7 remains unreproduced and is now self-diagnosing.** The default-off teardown recorder was measured on `beb8ae67dba1ed122cab94a4641e875ccebd21f1` against PostgreSQL 15.15 (`max_connections=100`, 97 ordinary slots). It writes synchronous JSONL records and its in-flight phase/teardown watchdogs fire before the inherited 15s hook is aborted, so a phase that never settles still leaves timing plus `pg_stat_activity` evidence. The durable campaign tables and full snapshot rows are retained in task document `FN-9127/evidence`; `/tmp/fn-9127-*.log` and `/tmp/fn-9127-diag-*.jsonl` are scratch copies only.

| instrumented shape | result | measured worst phase | watchdog / snapshot |
|---|---|---:|---|
| subject dot ×3 | all passed | `dropDatabase` 154ms | no / none |
| full core, 4 workers | unrelated settings attribution failure | 1,439ms globally | no / none |
| full core, 6 workers | unrelated settings attribution failure | 1,576ms globally | no / none |
| full core, 8 workers | unrelated settings attribution failure | 1,905ms globally | no / none |
| full core, 12 workers | unrelated settings attribution + schema-applier timeout | `dropDatabase` 3,582ms globally | 30 / 30 |

The 12-worker snapshots show 21 backends and concurrent template `CREATE DATABASE`/`DROP DATABASE WITH (FORCE)` work, including `IPC/CheckpointDone` and `IPC/ProcSignalBarrier`; they do not implicate this mission-store suite. FN-9130 measured advisory admission as a non-remedy: uniform pooling regressed to 49 watchdogs / 5,068ms and drop-only wiring to 27 / 3,361ms against the 4–5 / 3,284ms baseline. A bounded deferred-drop reaper also failed the end-to-end criterion: watchdogs became zero by construction, but two green runs took 117.2s and 122.4s versus the 108.1s baseline maximum, and a later run timed out in unrelated loaded setup. The reaper was reverted. FN-9136 then rejected candidate C after its golden-template gate passed: the required seven-pair 12-worker campaign left pooled `fusion_pool_*` databases owned by dead fork PIDs because the experiment lacked an awaited fork-exit flush and direct imports degraded to the shared `local` identity. The isolation failure required removing all harness wiring regardless of wall time. FN-9134 supplied a pre-registered report-only lane metric and completed its required seven-pair alternating control/candidate campaign at 12 workers. The control/candidate medians were 137.81s/146.91s, candidate pairs 02–06 were red, and every sample observed 32 or 33 surviving `fusion_test_%` databases (pair 04 increased 32 to 33). The tool's `no-improvement` verdict and the automatic non-zero-leak rejection removed the prototype and all of its wiring/tests together. The full per-run JSONL/log evidence is retained in task document `FN-9134/evidence`; this remains unresolved rather than becoming a quarantine or timeout change. No teardown behavior was changed: there is no evidence-backed cause for this entry's historical 15s afterAll abort. This first-sighting record remains retained; a second sighting follows the normal escalation. Core PostgreSQL files cannot be quarantined inline because the gate-policy assertion requires `quarantinedCoreTests` to remain empty; that is an owner-escalated decision.

**Campaign outcome 2026-08-19 (FN-9146):** The registered `afterAll(h.afterAll)` hook did not fail in every lane that selected this file. A02 instead timed out in `beforeAll(h.beforeAll)`, so its registered `afterAll` did not run and is recorded as not reached rather than passed; it is explicitly not entry-7 evidence. D01–D02 do not select the file. The historical afterAll mode remains unattributed. Entry 7 was subsequently closed on 2026-08-23 when the entire file was quarantined on a second sighting of a different test; see the note at the end of this entry. Complete combined output and teardown JSONL for A01–D02 are durable FN-9146 task attachments, with parsed checkpoints in its task documents.

**Capacity-evidence remediation 2026-08-19 (FN-9146):** C01–C03's original green default-core logs had no activity snapshot, so they cannot substantiate a peak. One sampled replacement per affected shape (C01R–C03R) completed green with an external 250ms `pg_stat_activity` count sampler: 28/31/30 observed backends across 583/491/508 samples. The table labels retain the pre-registered C identities and disclose their sampled replacements; these are new measurements, not retroactive values for the original C logs. Each replacement retained full runner output, teardown JSONL, and sampler output in FN-9146's durable evidence checkpoint; after C03R, the dead-owner golden template was dropped and the leftover count returned to zero.

| run | shape / workers | wall | subject result | whole-lane result | cluster capacity (`max`/ordinary; peak) |
|---|---|---:|---|---|---|
| A01 | directory / 27 | 235.8s | pass | 25 files / 45 tests red | 100/97; 73 |
| A02 | directory / 27 | 220.2s | not reached: `beforeAll` timeout (not registered `afterAll`) | 60 files / 42 tests red | 100/97; 73 |
| A03 | directory / 27 | 205.5s | pass | 35 files / 31 tests red | 100/97; 62 |
| A04 | directory / 27 | 224.2s | pass | 36 files / 39 tests red | 100/97; 71 |
| B01 | directory / 12 | 110.8s | pass | green, 176 files / 1385 pass / 1 skip | 100/97; 26 |
| B02 | directory / 12 | 119.2s | pass | green, 176 files / 1385 pass / 1 skip | 100/97; 36 |
| B03 | directory / 12 | 121.1s | pass | green, 176 files / 1385 pass / 1 skip | 100/97; 28 |
| C01 / C01R | core default | 163.5s | pass | green, 580 files / 5686 pass / 3 skip | 100/97; 28 (583 samples) |
| C02 / C02R | core default | 136.6s | pass | green, 580 files / 5686 pass / 3 skip | 100/97; 31 (491 samples) |
| C03 / C03R | core default | 141.1s | pass | green, 580 files / 5686 pass / 3 skip | 100/97; 30 (508 samples) |
| D01 | configured pg gate / 4 forks | 3.6s | not selected | green, 2 files / 10 pass | 100/97; not sampled |
| D02 | configured pg gate / 4 forks | 3.7s | not selected | green, 2 files / 10 pass | 100/97; not sampled |

**Closed 2026-08-23.** This observation is no longer active: the entire file was quarantined on 2026-08-23 because a different test in it (`serializes concurrent claims on the same task (Greptile P1 race)`) received a second loaded-lane sighting. See `scripts/lib/test-quarantine.json` for the ledger reason.

**Rescued 2026-09-02 (`9b29c6beab`, PR #3549).** The quarantine was lifted before the 2026-09-06 deletion deadline as a genuine rescue, not appeasement: the race test's 250ms wall-clock sleep was replaced with a deterministic `pg_blocking_pids()` blocking-graph probe over `pg_stat_activity` (the lock-wait rescue path the ledger reason named), and the file's ledger entry plus the `packages/core/vitest.config.ts` exclude were removed in the same commit. The file is live in the suite again; the deletion deadline above is moot. Note the commit message does not mention the rescue — the evidence is in the test-file diff.


### 13. Handoff-to-review atomicity PostgreSQL setup hook

- **Status:** Active escalation — reproduced 2026-10-07 in four Windows CI merge-gate runs; gate-eviction owner decision pending.

- **File:** `packages/core/src/__tests__/postgres/handoff-to-review-atomicity.pg.test.ts`
- **Exact test:** `handoff-to-review transactional invariant (PostgreSQL)` suite `beforeAll(h.beforeAll)` setup hook (line 35).
- **Observed tree/SHA:** `39812f4898` (observed locally as `82c37ee3fd`, the same tree before an upstream rewrite) with uncommitted `packages/engine/src/executor/{execute-core,execute-workflow-graph}.ts` changes plus one new engine test. Those changes are engine-only; the subject is a core PostgreSQL file and imports nothing from them.
- **Observed frequency:** 1 sighting, on the FIRST `pnpm test:gate` invocation of the session; not reproduced in 8 subsequent runs across three shapes.

| run | shape | result |
|---|---|---|
| gate (1st of session) | `pnpm test:gate` | **`beforeAll` hook timed out** at the inherited 15s budget; 6 passed / 4 skipped in the lane |
| gate ×2 | `pnpm test:gate` | green, 715 tests each (4 lanes: 200 / 433 / 10 / 72) |
| pg-gate ×3 | `pnpm --filter @fusion/core run test:pg-gate` | 2 files / 10 tests passed each run |
| isolated ×3 | target file alone, `vitest.pg.config.ts` | 1 file / 4 tests passed each run |

**Evidence gap disclosed:** the original failing run's output was piped through `tail`, so only the summary and the `FAIL` identity lines survive; the full runner output was not retained. The identity is unambiguous (file, suite, `beforeAll` hook, 15s budget, `:35:3`), but this record cannot supply a full log for the failing run. The eight verification runs above were captured in full.

This is the same mode already characterized by entry 6 and by entry 7's A02 lane: a 15s `beforeAll` abort on the DDL-heavy per-file schema-template setup that the one shared Postgres serializes. Two properties make this sighting narrower than the shapes those entries measured. It occurred under the CAPPED gate lane — `PG_MAX_WORKERS = 4` and only two selected files — which `FNXC:PgTestWorkerCap 2026-07-18-18:00` established as the DB-safe ceiling (measured: 6 forks all time out, 4 forks pass in ~42s). And it occurred on the first gate invocation after the cluster had been idle, with every later run in the same shell green, which points at cold-cluster startup cost landing inside the first file's setup budget rather than at fork oversubscription. That correlation is a HYPOTHESIS, not a measurement: reproducing it means stopping the embedded cluster, which was not done because this host also runs a live Fusion instance.

Quarantine was not available as an alternative. Core PostgreSQL files cannot be quarantined inline — the gate-policy assertion requires `quarantinedCoreTests` to remain empty — and a merge-gate eviction of a transactional-invariant file is the owner-escalated decision described in the policy section below. The file carries only 4 tests, which is thin against the usual first-sighting coverage argument, but they are the atomicity invariant for handoff-to-review and one of just two files in the blocking PG lane; recording preserves that rather than trading it away over a single unreproduced cold-start abort. A **second sighting** follows normal escalation.

<!--
FNXC:TestFlakeRegister 2026-10-08-01:13:
KB-008 classified the Windows "Merge gate suite" failure of Full Suite run 37693147198. It is this record's mode, reproduced, not a regression from #26 (9d216bec), because the same abort predates that commit. Eviction of a transactional-invariant canary is owner-escalated by the policy below, and evicting both canaries would delete the blocking PostgreSQL lane, so the record escalates instead of being edited inline.
-->

**Reproduced 2026-10-07 on Windows CI (KB-008):** the Windows job of the non-blocking Full Suite runs `pnpm test:gate` against a PostgreSQL service started a few minutes earlier in the same job. In that job the `pg-gate` lane aborted both of its canaries at the inherited 15s `beforeAll` budget (this file at `:35:3`, and `task-lifecycle-e2e.pg.test.ts > VAL-CROSS-001: End-to-end task lifecycle (PostgreSQL)` at `:25:3`) in 4 of 20 consecutive completed runs. The other two gate lanes passed in every listed run.

| run | SHA | Windows merge gate |
|---|---|---|
| [37681502535](https://github.com/stjepanvrbic/Fusion/actions/runs/37681502535) | `c1b4d5c3` | **both canaries: `beforeAll` 15s timeout** |
| [37688377857](https://github.com/stjepanvrbic/Fusion/actions/runs/37688377857) | `9776eca9` | **both canaries: `beforeAll` 15s timeout** |
| [37693147198](https://github.com/stjepanvrbic/Fusion/actions/runs/37693147198) | `9d216bec` | **both canaries: `beforeAll` 15s timeout** |
| [37702452940](https://github.com/stjepanvrbic/Fusion/actions/runs/37702452940) | `41950446` | **both canaries: `beforeAll` 15s timeout** |
| 16 other completed runs, `e66474d9`..`ab571780` | — | green |
| local Windows host, `test:pg-gate` alone | `c53017ac` | 2 files / 10 tests passed (19.3s) |
| local Windows host, all three gate lanes concurrently, process affinity pinned to 4 CPUs, `VITEST_MAX_WORKERS=2` | `c53017ac` | all lanes green; `pg-gate` finished in 22s |

The failures predate the #26 harness rework (`9d216bec`), which rules it out as the cause. The two canaries always failed together, which fits the shared run-wide golden-template build both files wait on, rather than either file's own body. Every sighting was on a freshly started CI cluster, but so were the green runs, so the cold-cluster hypothesis above is still unmeasured. The local reproductions used a long-lived, warm cluster and did not fail. The Linux blocking gate shows no matching sighting.

The disposition is an owner decision, so it is not made inline here. Both canaries in the blocking PostgreSQL lane fail together. Evicting them under the AGENTS.md gate rule would therefore delete the `pg-gate` lane and its pinned gate composition, not trim it. The policy section below also escalates a merge-gate eviction of a transactional-invariant file to its owner. Raising `hookTimeout` stays forbidden.


### 15. Workflow-results preserved-column selector mock ordering

- **Status:** Closed 2026-09-20 — FN-9336 structurally resolved the request-ordering mock drift. A new sighting re-opens normal escalation.
- **File:** `packages/dashboard/app/components/__tests__/WorkflowResultsTab.test.tsx`
- **Exact test:** `WorkflowResultsTab > calls onWorkflowReconciled for preserved-column workflow switches`
- **Owner:** FN-9336 — retained rather than quarantined because the file retains 126 passing tests and file-level quarantine would discard substantial coverage.
- **Observed tree/SHA:** `5977d630dbca4981342d6c5fb6dffbc5642b9f45`.
- **Observed frequency:** once, suite-only. Passed in isolation before the fix.

| run | result |
|---|---|
| target file at first sighting | **failed**: expected `selectTaskWorkflow("FN-001", "WF-002", undefined)` but received a null workflow selection |
| exact test in isolation at first sighting | **passed** |
| `pnpm --filter @fusion/dashboard exec vitest run app/components/__tests__/WorkflowResultsTab.test.tsx --silent=passed-only --reporter=dot` | **passed** after FN-9336 |
| `pnpm --filter @fusion/dashboard exec vitest run app/components/__tests__/WorkflowResultsTab.test.tsx -t "calls onWorkflowReconciled for preserved-column workflow switches" --silent=passed-only --reporter=dot` | **passed** after FN-9336 |

<!--
FNXC:WorkflowResultsTabMocks 2026-09-20-09:58:
FN-9336 closes this record with request-aware selector fixtures. The parent tab and nested selector
both fetch workflow definitions during mount, so fixtures now key task selection, definitions, graph
reads, and selection writes by their task, workflow, and project request instead of consuming a queue.
-->

**Closed 2026-09-20 (FN-9336):** `WorkflowResultsTab` and its nested `WorkflowSelector` independently fetch workflow definitions during mount, so shared `mockResolvedValueOnce` queues could give the preserved-column selection test a null/default response intended for another request. FN-9336 replaced selector API queues with request-aware task, workflow, and project fixtures for null/default inheritance, explicit custom selection, task-change failure, clear selection, stale and empty graphs, no usable board id, and the `WF-002` preserved-column response. Both the complete file and the exact registered test passed with its original request, enabled-step, and reconciliation assertions unchanged; no quarantine, retry, timeout, skip, or product-source change was made.

The failure occurred while validating FN-9334's unrelated resume-eligibility cases. The test's per-case resolved mock was consumed out of order only in the file run, while the isolated test passed; no timeout, retry, assertion, or product behavior was changed. A second sighting requires normal quarantine escalation.

### 18. Triage rate-limit retry log warning timer ordering

- **Status:** Closed 2026-10-05 — structurally resolved by FN-9498; no quarantine.
- **File:** `packages/engine/src/__tests__/triage.test.ts`
- **Exact tests:** `specifyTask — status restore failure diagnostics > logs warning when logEntry fails during rate-limit retry`; `specifyTask — status restore failure diagnostics > logs warning when transient-error retry status update fails`
- **Original observed tree/SHA:** `d486a4c275` (FN-9389 register-only commit).
- **Second observed tree/SHA:** `9f06d4fe16404f72c5d25ad97ebcfa93d4843b8c`.
- **Observed frequency:** The original rate-limit identity had two shard-2 sightings; the transient-status identity was a new single sighting in the second run.

Push Full Suite run [36053028228](https://github.com/Runfusion/Fusion/actions/runs/36053028228), shard 2 artifact `test-timings-shard-2` (`packages/engine/.timings/timings-shard2-1.json`), reported `STACK_TRACE_ERROR` at `triage.test.ts:6701` after 30032 ms. The shard completed 254 sibling tests; the three real-timer diagnostics in this describe passed.

Push Full Suite run [37260134709](https://github.com/Runfusion/Fusion/actions/runs/37260134709), job `111605429056`, ran `vitest run --silent=passed-only --reporter=dot --project=engine-default --project=engine-reliability --shard=2/2`. At `2026-10-05T03:58:14Z`, the rate-limit test had made zero retry-log calls and the following transient-status test timed out at 30000 ms. Its stderr shows the abandoned FN-207 work later consuming FN-208's mock queues, proving test cleanup contamination rather than a product retry defect.

FN-9498 removed the arbitrary fake-clock polling. The rate-limit test waits for its own production retry-log callback, then verifies one registered retry backoff, successful `specifyTask` settlement, and the best-effort warning after a rejected `logEntry`. The transient-status test independently verifies the attempted first bounded recovery write (`recoveryRetryCount: 1` and `nextRecoveryAt`), no terminal state, its warning, and spy cleanup. `withRateLimitRetry` and production triage policy were unchanged: the callback remains before backoff and the rejected persistence remains non-blocking.

| control | result |
|---|---|
| push run 36034454035 (`c76cb158`) | passed in 26.2 ms |
| push run 35991562171 (`618204ad`) | passed in 39.8 ms |
| FN-9498 diagnostics describe | passed; both failure injections completed through real `specifyTask` behavior |
| FN-9498 complete triage file | passed 255 tests in 6.9 s with the rate-limit and transient-status diagnostics retained |

The rate-limit identity was a repeated test-only failure, but a demonstrated structural test repair resolves it; quarantine would discard valuable coverage after the cause has been fixed. A future sighting is a new observation and follows the normal deletion-ratchet policy.

### 20. ProjectEngine research recall composition ordering

- **Status:** Active first sighting — recorded 2026-10-04, unattributed.
- **File:** `packages/engine/src/__tests__/project-engine.test.ts`
- **Exact test:** `ProjectEngine research recall composition > persists finalized research through ProjectEngine's live recall composition`
- **Observed tree/SHA:** `56a86a3437` during FN-9471 focused three-file engine verification.
- **Observed frequency:** 1 sighting in the combined three-file command; exact test passed alone.

The combined ProjectEngine/workspace-merger verification observed an empty recall list after the real detached writer was flushed. The exact test passed immediately in a file-scoped rerun, retaining its production `ProjectEngine` composition, real PostgreSQL layer, writer drain, and persisted-recall assertion. No timeout, retry, quarantine, or assertion weakening was applied. A second sighting requires same-change file-level quarantine under the repository deletion-ratchet policy.

### 21. Agent Detail legacy skill discovery ordering

- **Status:** Active first sighting — recorded 2026-10-05 by FN-9506; deterministic test repair landed, with a second sighting requiring file-level quarantine.
- **File:** `packages/dashboard/app/components/__tests__/AgentDetailView.core.test.tsx`
- **Exact test:** `AgentDetailView — core > loads compatible legacy skill details through the resolved canonical ID`
- **Observed tree/SHA:** Full Suite run [37279527225](https://github.com/Runfusion/Fusion/actions/runs/37279527225), `52e790446dbcfff118e4c6150056cec3d090da0c`.
- **Observed frequency:** One complete shard-3 reporter sighting; the exact focused test passed in isolation.

The verified `test-timings-shard-3` artifact (`11332755977`, SHA-256 `85a8465f96e26a8ec9f0d80ff9f051f6a9e66673a0042fdd18c2d434a7577ec4`) reported the badge as `pending` rather than `auto-available` at `AgentDetailView.core.test.tsx:507` after 58.443616 ms. The shard command was `pnpm test:ci:shard --shard 3 --total 4`; its dashboard reporter was otherwise complete (176 suites, 6,008 passing tests, one failure).

FN-9506 reproduced the pending-to-resolved transition with a deferred discovery response. It preserves the stored legacy reference in the tooltip, proves a pending click makes no content request, waits for `data-skill-state="auto-available"`, and then proves one `fetchSkillContent(canonicalId, projectId)` request. Production code was unchanged: `AgentDetailView` deliberately mounts skill discovery only after the agent has loaded, so agent-before-discovery is the reachable lifecycle. No retry, timeout, skip, or weakened assertion was introduced. The file has 55 focused cases and is outside the thin merge gate, so this high-value first sighting remains recorded rather than quarantined. A second sighting of this file requires a same-change file-level quarantine in `scripts/lib/test-quarantine.json` and `quarantinedDashboardTests`.

### 25. Signal-ingest incident capture PostgreSQL teardown hook

- **Status:** Active first sighting — recorded 2026-10-07, unattributed.
- **File:** `packages/dashboard/src/__tests__/register-signal-routes.test.ts`
- **Exact test:** `ingestSignal — incident capture > marks resolution events as resolved for every provider`
- **Observed tree/SHA:** branch `audit/dashboard-mailbox-and-ingress` (PR #24, head `cc88ef119e` when recorded; the observer did not pin the exact commit), on Windows with the machine under load.
- **Observed frequency:** 1 failure, then 4 passing reruns, including one on `origin/main`.

The failure was `Hook timed out in 15000ms` in the file's top-level `afterEach`, which tears down every PostgreSQL harness the case opened (`harnesses.pop()?.teardown()`). This is the same 15 s PostgreSQL hook mode recorded for entries 2 and 13, here on teardown rather than setup. The case's assertions passed on every rerun. No timeout, retry, or assertion changed. A second sighting requires a same-change file-level quarantine in `scripts/lib/test-quarantine.json` and `quarantinedDashboardTests`.

### 27. ensureCwdProjectRegistered embedded PostgreSQL startup cascade

- **Status:** Closed 2026-10-08 — structurally resolved on first sighting by KB-052 (product fix); no quarantine.
- **File:** `packages/cli/src/commands/__tests__/ensure-project-registered.test.ts`
- **Exact tests:** all five cases in `ensureCwdProjectRegistered`: `returns existing registered project without writing files`, `auto-registers unregistered project when enabled and persists identity`, `reattaches using stored identity when central row was wiped`, `returns null and does not write when autoRegister is false`, and `returns null and logs error when registration throws`.
- **Observed tree/SHA:** fork Full Suite run [37710916510](https://github.com/stjepanvrbic/Fusion/actions/runs/37710916510) at `c024d8213` (Linux, `ubuntu-latest`), job `Test shard 3/4` (`113096379129`). That commit changed only a register entry and its validator test, so the failure is load- or environment-shaped.
- **Observed frequency:** 1 run, 10 failure entries across the 5 cases. The same file reported no failure in the Full Suite test shards for the neighbouring commits `c53017ac7` (run 37710548191) and `677ca1403` (run 37710543465).

The first case failed with `Error: Test timed out in 5000ms` and, in the same case, `Error: Test subprocess guard detected unsafe child-process usage`. The guard reported the embedded PostgreSQL `postgres` process for port 46431 as left running at the end of that case. The other four cases each failed twice with `Error: connect ECONNREFUSED ::1:46431` and `Error: connect ECONNREFUSED 127.0.0.1:46431`.

The log shows one embedded PostgreSQL data directory, under the worker's test home, used by all five cases. The first case ran `initdb` and started the server, which logged ready on port 46431. About five seconds later the server logged `terminating connection due to unexpected postmaster exit`, matching the first case's 5 s timeout and teardown. Each later case then logged `could not verify database "fusion" on joined instance at port 46431` and was refused on that port. The later failures are a cascade from the first case, not five independent failures. This reads the log; no reproduction was attempted.

No timeout, retry, or assertion changed, and the file is not quarantined because this is a first sighting. A second sighting requires a same-change file-level quarantine in `scripts/lib/test-quarantine.json` and the CLI vitest config.

The subprocess-guard line deserves a product look. It means a real PostgreSQL child reached a CLI unit test that does not obviously need one, and a startup that outlives its test left a stale port recorded as a joined instance for later cases. Start with how the embedded PostgreSQL startup records and joins an existing instance for a shared data directory, and whether `CentralCore` initialization in this file should use an in-memory or harness-provided store.

**Closed 2026-10-08 (KB-052) — product diagnosis.** The shared data directory is by design: each Vitest worker has one stable test home, and `CentralCore` uses the default embedded data directory under it, so every case in the worker reuses one cluster instead of running `initdb` per case. The defect was in `packages/core/src/postgres/embedded-lifecycle.ts`. The first case's owned start published its port in the in-process `runningInstances` cache, the subprocess guard SIGKILLed the postmaster after the 5 s timeout, and nothing removed the cache entry. Every later lifecycle in the process returned that entry without a liveness check, joined the dead port, and the `startup-factory` joined-instance retries rebuilt lifecycles that hit the same stale entry. The existing stale-`postmaster.pid` recovery never ran because the cache was consulted first. A second latent wedge: on Linux and macOS, stopping an owned postmaster that had already exited called the library `stop()`, which waits forever for an `exit` event that already fired, leaving its runtime-registry generation `stopping`.

KB-052 makes each cache entry owner-scoped and liveness-checked, so a dead entry is discarded and the stale-pid path starts a new owned postmaster. An exit listener on the owned postmaster clears the entry and reports an unexpected exit, the dead-child stop guard is cross-platform, and a join whose database check is refused re-checks liveness and restarts once when the postmaster is proven dead. Mocked regression suites in `packages/core/src/__tests__/postgres/embedded-lifecycle.test.ts` fail when the cache liveness check is reverted. The CLI test file is unchanged; no timeout, retry, or assertion changed. A new sighting re-opens normal escalation.

**Cross-reference (KB-081):** archived entry 39 (`extension.test.ts`, run 37758138036) had the same timeout-then-left-running-postmaster shape, but it was a fresh embedded boot by an orphaned continuation of a timed-out test, not a join of a dead postmaster; it is not a sighting of this record.

### 32. System controls rebuild output stream subscription

- **Status:** Active first sighting — recorded 2026-10-08, unattributed.
- **File:** `packages/dashboard/app/components/command-center/__tests__/SystemControlsArea.test.tsx`
- **Exact test:** `SystemControlsArea layout integration > keeps manually scrolled rebuild output in place while SSE lines grow`.
- **Observed tree/SHA:** fork Full Suite (non-blocking) run [37730530935](https://github.com/stjepanvrbic/Fusion/actions/runs/37730530935/job/113158385793) at `7bab9bce9` (Linux, `ubuntu-latest`), job `Test shard 1/4` (`113158385793`), command `@fusion/dashboard run test:quality:app:backfill-1`, project `dashboard-app-quality-backfill`. The preceding Full Suite run 37730005153 at `a3d4e3d65` passed this shard. The only commit between them, `7bab9bce9` (#46), changed ledger data under `scripts/lib` and `packages/engine/vitest.config.ts`, nothing under `packages/dashboard`.
- **Observed frequency:** 1 run, 1 failure entry. The other 16 cases in the file passed, and the dashboard command reported 2291 tests with this one failure.

The job's live log is truncated before the dashboard command, so the failure is read from the verified `test-timings-shard-1` artifact (`packages/dashboard/.timings/timings-shard1-2.json`). The case failed after 183 ms with `AssertionError: expected undefined to be defined`, raised by `expect(call).toBeDefined()` in the file's `getStreamEvents` helper (line 383) and called from line 394. The helper searches `subscribeSseMock.mock.calls` for `/api/system/jobs/job-1/stream` and found no call, so the component had not subscribed to the job stream when the test read the mock. The run was not reproduced.

The commit that made the capability probe retry (`c8dfb4717`) is not the cause. The job stream subscription is not gated on the probe. It is made by the effect at `SystemControlsArea.tsx:397-432`, which depends only on `job?.id` and `job?.status` and returns early unless the job is `running`. The failure is also after the test's `findByTestId` for the rebuild card (line 390), and that card stays hidden until the probe lands (`showRebuildControls`, line 742). A slow probe would have failed at line 390, not at line 394. The 183 ms duration agrees: no Testing Library wait ran to its timeout.

Hypothesis, not measured: the `job` state is set by `adoptJob` after `startSystemRebuild` resolves (line 550), and the output section renders in the same commit (line 1092). The subscription is made in a passive effect, which React can flush a scheduler turn after that commit. `findByTestId("cc-system-rebuild-output")` resolves as soon as the DOM node exists, and the test reads the mock immediately, so a starved shard could observe the DOM before the effect has run. The other case in this file that reads `getStreamEvents`, `keeps manually scrolled live server logs in place while SSE lines grow`, has the same shape and passed in the run (176 ms).

| run | result |
|---|---|
| Full Suite 37730005153 (`a3d4e3d65`), shard 1/4 | passed |
| Full Suite 37730530935 (`7bab9bce9`), shard 1/4 | **failed** (this case) |
| `pnpm --filter @fusion/dashboard exec vitest run app/components/command-center/__tests__/SystemControlsArea.test.tsx --project dashboard-app-quality-backfill`, local Windows, `0c50dbd0f` | passed, 17 tests, 24.7 s wall (tests 11.4 s) |

No timeout, retry, or assertion changed, and the file is not quarantined because this is a first sighting. A second sighting requires a same-change file-level quarantine in `scripts/lib/test-quarantine.json` and the dashboard vitest config. Before quarantining, a fix should wait on the subscription itself, for example by asserting on `subscribeSseMock` inside `waitFor`, rather than on the rendered output.

### 33. AutomationStore due-run claim minute-boundary clock race

- **Status:** Active first sighting — recorded 2026-10-08, unattributed.
- **File:** `packages/core/src/__tests__/postgres/satellite-stores.pg.test.ts`
- **Exact test:** `PostgreSQL satellite stores (U6 consolidated, shared harness) > PostgreSQL satellite fusion-dir stores (VAL-DATA-015, VAL-DATA-016) > AutomationStore: isolates duplicate IDs and due-run claims across two bound projects`.
- **Observed tree/SHA:** fork Full Suite (non-blocking) run [37735335086](https://github.com/stjepanvrbic/Fusion/actions/runs/37735335086/job/113173460315) at `90619eba9412969f8bb76deff34424d6aa544227`, job `Windows tests` (`113173460315`), `@fusion/core`. The Windows lane flagged the file as outside its known-failing list. The same file is not excluded on Linux, so the mechanism is not specific to Windows.
- **Observed frequency:** 1 failure, in 1 test of the 38 in the file. The failure is an assertion, not a timeout.

The failing line is `expect(await storeA.getDueSchedules("project")).toEqual([])` (test line 711), made right after `expect(await storeA.claimDueSchedule(duplicateId, past)).toBe(true)`. It received one schedule, `shared-automation-id` named `project-a-updated`, with the cron `* * * * *`, `createdAt` 2026-10-08T06:12:59.735Z, `nextRunAt` 2026-10-08T06:13:00.000Z, and `updatedAt` 2026-10-08T06:13:00.068Z. The claim had succeeded, so `nextRunAt` was already advanced, yet the schedule was due again when `getDueSchedules` ran.

Hypothesis, not measured: `claimDueSchedule` in `automation-store.ts` computes the next run with `computeNextRun` and stamps `updatedAt` with a separate `new Date()` in the same call. The record shows the next run at 06:13:00.000 and the stamp 68 ms after it, so the next run was derived from a clock read before the minute edge while the stamp and the following read came after it. With a `* * * * *` schedule the claimed occurrence is then already due. If so, the test is exposed whenever the claim crosses a minute edge on any platform, and a loaded runner widens that window.

| run | result |
|---|---|
| Full Suite 37735335086 (`90619eba9`), Windows `@fusion/core` | **failed** (this case) |
| `pnpm --filter @fusion/core exec vitest run src/__tests__/postgres/satellite-stores.pg.test.ts` with `FUSION_PG_TEST_URL_BASE=postgresql://postgres:postgres@localhost:55432`, local Windows, `628231a55` | passed, 38 tests, 9.2 s wall |
| the same command with `-t "isolates duplicate IDs and due-run claims"`, local Windows | passed, 1 test |

The local runs did not land on a minute edge, so they neither confirm nor refute the hypothesis. No timeout, retry, or assertion changed, and the file is not quarantined because this is a first sighting and the file carries 37 other cases. A second sighting requires a same-change file-level quarantine in `scripts/lib/test-quarantine.json` and the core vitest config. A fix should pin the clock with fake timers, or build the schedule so its next occurrence cannot be the boundary the claim computes.

### 35. Durable agent Activity analytics heartbeat session count and usage-event identity

- **Status:** Active first sighting — recorded 2026-10-08, unattributed.
- **File:** `packages/core/src/__tests__/postgres/command-center-activity-durable-agents.pg.test.ts`
- **Exact tests:** two cases in `durable agent Activity analytics`: `turns a production durable no-task heartbeat into Activity sessions and tool usage` and `sums CLI and agent sessions, honors the range, and isolates the bound project`.
- **Observed tree/SHA:** fork Full Suite (non-blocking) run [37742324890](https://github.com/stjepanvrbic/Fusion/actions/runs/37742324890) at `668244c5ed0e2b23eee7e0c9814d82a0f5e3587e`, job `Windows tests` (`113195659917`), `@fusion/core`. The Windows lane flagged the file as outside its known-failing list. The same file is not excluded on Linux, and no Linux shard of that run failed it. The file was never in the Windows ledger, and the KB-035 commit did not touch the core entries.
- **Observed frequency:** 2 failures in the 4 cases of the file, both assertion or query failures, not timeouts. The file did not appear among the unexpected failures of Windows runs 37720328009, 37720611351, 37735335086, or 37744337717 (`74d0bdf8a`), so it failed in 1 of 5 recent Windows runs.

The first case ran the production heartbeat to `completed` (the log shows one tool call), then failed `expect(activity.sessions).toBeGreaterThan(0)` with `expected 0 to be greater than 0` at test line 129. The second case failed at its first statement, the insert into `project.usage_events` at line 145, with `duplicate key value violates unique constraint "usage_events_pkey"` and `Key (project_id, id)=(durable-project, 2) already exists`. That column is `generatedAlwaysAsIdentity` and the insert supplies no id, so the identity counter had handed out an id that a row for the same project already held.

Hypothesis, not measured: both failures are one defect in the usage-event identity state of the shared database. A pre-existing row at id 2 for `durable-project` would explain the rejected insert, and a rejected or misattributed heartbeat write would explain zero sessions. The first case's log shows no insert error, so the link between the two is unproven. The `Windows tests` job connects to the runner's PostgreSQL service on port 5432, a path the Linux lanes do not use, so a runner-specific database state is also possible.

| run | result |
|---|---|
| Full Suite 37742324890 (`668244c5e`), Windows `@fusion/core` | **failed** (both cases) |
| Full Suite 37744337717 (`74d0bdf8a`), Windows `@fusion/core` | not among the unexpected failures |
| `pnpm --filter @fusion/core exec vitest run src/__tests__/postgres/command-center-activity-durable-agents.pg.test.ts --reporter=dot` with `FUSION_PG_TEST_URL_BASE=postgresql://postgres:postgres@localhost:55432`, local Windows, `c89b0ea0b` plus the quarantine commit | passed, 4 tests |

No timeout, retry, or assertion changed, and the file is not quarantined because this is a first sighting. A second sighting requires a same-change file-level quarantine in `scripts/lib/test-quarantine.json` and the core vitest config. Before quarantining, check whether the harness database for these cases can carry rows from an earlier case or a prior run, and whether the heartbeat's usage-event write can be rejected without failing the heartbeat.

### 36. WorkflowNodeEditor edge-targeted fragment pick splice

- **Status:** Closed 2026-10-08 — structurally resolved on first sighting by KB-084 (product fix); no quarantine.
- **Root cause and fix:** the toolbar Add-step captured the append edge when the dialog opened, so an open inside the hydration window captured a null edge. KB-084 resolves the edge from the live graph at pick time on the palette, fragment, and optional-group paths, with pre-hydration regressions for all three.
- **File:** `packages/dashboard/app/components/__tests__/WorkflowNodeEditor.test.tsx`
- **Exact test:** `WorkflowNodeEditor simplified view modes > splices an edge-targeted fragment pick into the targeted edge`.
- **Observed tree/SHA:** fork Full Suite (non-blocking) run [37744337717](https://github.com/stjepanvrbic/Fusion/actions/runs/37744337717/job/113202144603) at `74d0bdf8af314543008f0d169c28a6493d76203a` (Linux, `ubuntu-latest`), job `Test shard 4/4` (`113202144603`), command `@fusion/dashboard run test:quality:app:components-b`, project `dashboard-app-quality-components-b`. That commit (KB-036) changed no file named for `WorkflowNodeEditor`; its dashboard changes are `file-service.ts` and four tests under `packages/dashboard/src/__tests__/`. The same shard passed in the Full Suite runs for `70d326790` (37741630295), `0b74a0c2c` (37742189681), and `668244c5e` (37742324890).
- **Observed frequency:** 1 failure, in a command that reported 1790 tests (1 failed, 1789 passed).

The failure was `AssertionError: expected true to be false // Object.is equality` at `WorkflowNodeEditor.test.tsx:4590`, the assertion that no edge from `merge` to `end` remains after the pick. The line before it, `expect(insertedGate).toBeDefined()`, passed, so the fragment's gate was in the saved IR while the original `merge` to `end` edge had not been removed. `updateWorkflow` had been called exactly once, so the test saved a graph in which the fragment was added but not spliced into the targeted edge.

The first hypothesis recorded here (the pick adds the nodes and rewires the edge in separate state updates) is superseded: `handleInsertFragment` computes the insert and the splice together and sets nodes and edges once.

<!--
FNXC:TestFlakeRegister 2026-10-08-10:38:
KB-060 measured the mechanism behind entry 36 and repaired the test deterministically. The record stays an active first sighting because the same run is the only sighting; a second sighting still requires file-level quarantine.
-->

Measured by KB-060: the toolbar was clicked inside the editor's hydration window. The simplified canvas shell and its toolbar render as soon as the active workflow exists, but the graph's nodes and edges are filled later by the load effect. The toolbar's `openAddStep` captures `findAppendEdgeId(nodes, edges)` at click time, so a click before the load effect has run captures a null edge, and `handleInsertFragment` then lands the fragment free-floating instead of splicing it. A scratch probe (not committed) resolved a deferred `fetchWorkflows` and clicked the toolbar on the first DOM mutation that rendered it: no gate card existed yet, and the saved IR kept `merge` to `end` with both gates present, which is the CI failure exactly. No product file on this path changed between `eaadd153b` (FN-8764, 2026-08-07) and `74d0bdf8a`, so this is a test race, not a splice regression.

KB-060 made both edge-targeted splice tests (this fragment case and the `'as optional group'` sibling) await `wf-simple-node-gate` before clicking, which proves the hydrated graph is committed. Prior same-class history in this file: the optional-group sibling hit the identical symptom in run 30077108784 and got an `act` settle in `cdc5b7f90`, and FN-6726/FN-6744 rescued a components-b-only seam-conflict test with the product-side `canvasNodesMaterializedRef` fix. Three sightings in one subsystem make resolving the toolbar's append edge at pick time, not open time, the recommended product hardening.

| run | result |
|---|---|
| Full Suite 37741630295 (`70d326790`), shard 4/4 | passed |
| Full Suite 37742189681 (`0b74a0c2c`), shard 4/4 | passed |
| Full Suite 37742324890 (`668244c5e`), shard 4/4 | passed |
| Full Suite 37744337717 (`74d0bdf8a`), shard 4/4 | **failed** (this case) |
| `pnpm exec vitest run app/components/__tests__/WorkflowNodeEditor.test.tsx --project dashboard-app-quality-components-b --reporter=dot` in `packages/dashboard`, local Windows, `83829b7cf` | passed, 191 tests, 34 s wall |
| KB-060, same command with `-t "splices an edge-targeted"`, local Windows, `bfe6023d4`, 10 runs before the repair | 10/10 passed, 2 tests each |
| KB-060, `@fusion/dashboard run test:quality:app:components-b`, local Windows, `bfe6023d4` before the repair | passed, 50 files, 1790 tests |
| KB-060 scratch probe clicking the toolbar before any node card rendered, local Windows, `bfe6023d4` | reproduced: fragment inserted, `merge` to `end` kept |
| KB-060, targeted command, 5 runs, plus the whole file, after the repair | 5/5 passed; 191 passed |

No timeout, retry, or assertion changed, and the file is not quarantined because this is a first sighting and the file carries 190 other cases. A second sighting requires a same-change file-level quarantine in `scripts/lib/test-quarantine.json` and `quarantinedDashboardTests`. Before quarantining, check whether the failing click still precedes the `wf-simple-node-gate` wait, and whether the toolbar append edge is still captured at open time.

### 37. SQLite-to-PostgreSQL migrator transient SQLite open failure

- **Status:** Active first sighting — recorded 2026-10-08, unattributed.
- **File:** `packages/core/src/__tests__/postgres/sqlite-migrator.test.ts`
- **Exact test:** `SQLite-to-PostgreSQL migrator` (case and hook not pinned; the operator reported the error, not the failing case).
- **Observed tree/SHA:** not pinned. The operator reported the two sightings without a run, commit, or host. The failed-job logs of the 54 failed Full Suite runs on the fork from 37669894876 through 37735335086 contain no `unable to open database file` line. The Windows tests job in those logs prints only info lines from this file and no per-file failure text, so a Windows-lane sighting can be neither confirmed nor ruled out from them.
- **Observed frequency:** 2 transient failures reported by the operator. A rerun of the file alone on local Windows at `70d326790`, against a throwaway PostgreSQL 16 container, passed all 46 tests in 60.4 s.

The error was `unable to open database file`, raised by SQLite when it cannot open a database path. In this file every case opens SQLite in its `beforeEach` through `setupCtx()`, which creates a `fusion-migrate-` directory under the system temp directory and then opens `fusion.db` and `archive.db` there in `buildPopulatedSqliteProject` and `buildPopulatedSqliteArchive`. Several cases also open `new DatabaseSync(sqlitePath)` inline. The same error class was recorded by the FN-6610 engine isolation rescue in `docs/testing.md`, where a redirected temp or `.fusion` parent vanished under package load; that is a known mode, not a diagnosis of these sightings. The file is also listed under `@fusion/core` in `scripts/lib/windows-known-failing-tests.json`, from the ledger's first recording (run 37678193811); ledger membership is a separate mechanism from this register.

The operator designated the two transient observations as this file's single first-sighting record. No timeout, retry, or assertion changed, and the file is not quarantined. The next sighting is an immediate same-change file-level quarantine in `scripts/lib/test-quarantine.json` and the inline `exclude` array of `packages/core/vitest.config.ts`, not another register line. That sighting should pin the run, commit, host OS, and failing case or hook.

### 38. ModelOnboardingModal GitHub Copilot device-code panel clipboard auto-copy

- **Status:** Closed 2026-10-08 — structurally resolved on first sighting by KB-085 (test synchronization); no quarantine.
- **File:** `packages/dashboard/app/components/__tests__/ModelOnboardingModal.test.tsx`
- **Exact test:** `ModelOnboardingModal > AI Setup step > renders github copilot device-code panel in onboarding`.
- **Observed tree/SHA:** fork Full Suite (non-blocking) run [37777837004](https://github.com/stjepanvrbic/Fusion/actions/runs/37777837004/job/113313079385) at `a93f18c744be13653ec97e3f7e2e1fc5bcec7c10` (KB-037, Linux, `ubuntu-latest`), job `Test shard 3/4` (`113313079385`), command `@fusion/dashboard run test:quality:app:backfill-3`, project `dashboard-app-quality-backfill`. That commit changed docs, the root and dashboard `package.json` test-script wrappers (`test:app`, `test:api`, `test:deep`, `test:build`, none of which the backfill command uses), `scripts/run-with-env.mjs`, `scripts/test-with-lock.mjs`, and their script tests. It touched no onboarding or modal file and no file under `packages/dashboard/app`. The shard-3 job passed in the Full Suite runs for `5c3bbd44f` (37771841940), `5369d3747` (37775466262), `23049497f` (37778394023), `ce5dd1aac` (37778520119), and `072f02fa8` (37779214412).
- **Observed frequency:** 1 failure, in a command that reported 6036 tests across 176 files (1 failed, 6035 passed).

The failure was `AssertionError: expected "vi.fn()" to be called with arguments: [ 'ABCD-1234' ]` with `Number of calls: 0`, at `ModelOnboardingModal.test.tsx:1283`. The case awaits `findByText("ABCD-1234")` in the Copilot card, asserts the login-instructions block is absent and `window.open` was not called, and then reads the clipboard `writeText` mock once, synchronously. The panel had rendered, so `deviceCodes` state held the code, but the mock had no calls at that read.

Hypothesis, not measured: the component copies the code from a passive effect keyed on `deviceCodes` (`ModelOnboardingModal.tsx` near line 908), which calls `copyTextToClipboard`. The test's only wait is for the rendered text, so on a starved shard the assertion can run before that effect's clipboard call is observable. This shares a shape with entries 32 and 34, where a test read a mock before the effect that feeds it had flushed. The mechanism is unmeasured for all three and is cited here only as a common shape.

| run | result |
|---|---|
| Full Suite 37771841940 (`5c3bbd44f`), shard 3/4 | passed |
| Full Suite 37775466262 (`5369d3747`), shard 3/4 | passed |
| Full Suite 37777837004 (`a93f18c74`), shard 3/4 | **failed** (this case) |
| Full Suite 37778394023 (`23049497f`), shard 3/4 | passed |
| Full Suite 37778520119 (`ce5dd1aac`), shard 3/4 | passed |
| Full Suite 37779214412 (`072f02fa8`), shard 3/4 | passed |
| `pnpm exec vitest run app/components/__tests__/ModelOnboardingModal.test.tsx --project dashboard-app-quality-backfill --reporter=dot` in `packages/dashboard`, local Windows, `34a914125` | passed, 208 tests, 18.9 s wall (tests 12.1 s) |
| KB-085 census: `Test shard 3/4` job logs of 34 further Full Suite runs on main, 37756067075 (`b4ffbded6`) through 37802084164 (`1857850d5`, still running), read through the job-log API | no sighting of this case (one shard-3 failure, 37758138036 at `2f807ed88`, was a different test) |
| KB-085 file alone, local Windows, before the fix | passed |
| KB-085 forcing probe (uncommitted): a `MutationObserver` records `writeText` calls at the first DOM commit that shows the pill | **0 calls** with the pill in the DOM; an `act` flush from that point then gave exactly 1 call |
| KB-085 file alone ×3, local Windows, after the fix | passed each run |
| KB-085 `@fusion/dashboard run test:quality:app:backfill-3`, local Windows, after the fix | passed, 196.8 s wall |

KB-085 measured the window: when the commit that renders the pill lands, the auto-copy passive effect has not run yet and `writeText` has no calls. The case had passed only because RTL's post-`waitFor` drain usually flushed React's scheduled passive effect before the synchronous read. The failure itself was not reproduced locally, so the specific CI race that let the read run first under load remains unmeasured. KB-085 made the case flush effects with `await act(async () => { await Promise.resolve(); })` before the read, mirroring the sibling `SettingsModal.models-auth.test.tsx` case. The exact `toHaveBeenCalledWith("ABCD-1234")`, `toHaveBeenCalledTimes(1)`, and `(2)` assertions are unchanged, and no timeout, retry, or product code changed. The neighboring execCommand-fallback and error-toast cases already wait with `waitFor`. A new sighting re-opens normal escalation.

### Common shape and investigated result

FN-9125 established that former entry 3 was not PostgreSQL-suite-adjacent: `plugin-runner.test.ts` used an in-memory mocked TaskStore and had no PostgreSQL/harness import. FN-9135 did not identify a root cause, but FN-9141's completed shuffled worker-reuse campaign reproduced and structurally fixed the logger mock-history fixture defect; the suite and its renamed-complete-lane dispatch coverage remain active. Entries 2 and 13 remain active, unreproduced PostgreSQL observations; entry 7 was closed on 2026-08-23 when the whole file was quarantined on a second sighting of a different test; entry 14 was closed on 2026-09-09 after deterministic diagnosis showed its assertions encoded FN-217-removed lifecycle behavior (see the archived record below). FN-9146 completed the later A×4/B×3/C×3 campaign without the entry 2 or entry 13 exact identities failing. Entry 1 reproduced under FN-9126 and again under FN-9146's A02–A04 lanes, then FN-9131 attributed the mechanism (harness demand scales with fan-out against a fixed cluster supply; the first test in a file eats the 15s budget) and shipped the structural queueing-admission fix, closing the record on 2026-09-12. The golden-template/advisory-lock lifecycle and schema-applier's inline baseline path are concrete architecture facts, not a demonstrated cause of these assertions. Core policy forbids inline PG quarantine: FN-9146's retained evidence for entries 2 and 13 is durable, but FN-9146 was archived on 2026-09-03 without a named successor, so those records are presently unowned; the next sighting follows normal escalation from an unowned state. entry 7 was closed on 2026-08-23 (see above). No source or fan-out change is justified before a diagnostic names a causal lifecycle seam. Entry 13 is a further unreproduced instance of that same 15s setup-hook mode, narrowed to the capped four-fork gate lane on a cold cluster. Entry 6 instead records a merge-gate eviction after a loaded-lane setup-hook timeout; `FNXC:PgTestTemplateDb 2026-07-19-17:20` and `FNXC:PgTestWorkerCap 2026-07-18-18:00` are already-landed mitigations for that mode, not new diagnoses to re-open. The Planning Mode entries are separate frontend timing observations.



## Merge-gate eviction records

### 6. Sync workflow IR default canary setup hook

- **Status:** Merge-gate eviction 2026-08-16 by FN-8928.

- **File:** `packages/core/src/__tests__/postgres/sync-workflow-ir-is-always-default.pg.test.ts`
- **Exact test:** `resolveTaskWorkflowIrSync ignores a task's real workflow (PostgreSQL)` suite `beforeAll` setup hook.
- **Observed tree/SHA:** FN-8912 evidence; local confirmation tree `51437558ac352dad3481e0dbe9622fa51af4c599`.
- **Observed frequency:** 1 observed merge-gate sighting in FN-8912; not reproduced locally. This is an **evicted merge-gate canary**, not a first-sighting register exception.

| run | result |
|---|---|
| FN-8912 loaded `pnpm test:gate` | **setup hook timed out** at the inherited 15s budget; direct scoped rerun passed |
| shape A: capped `test:pg-gate` ×5 | 3 files / 13 tests passed each run |
| shape B: isolated target ×3 | 1 file / 3 tests passed each run |
| shape C: uncapped default-config PostgreSQL directory ×5 | 153 files / 1263 passed plus 1 skipped each run |

FN-8928 evicted the file from the blocking gate under the AGENTS.md gate rule; default-core discovery preserves its regression coverage. Shape C was clean, so no quarantine escalation was required. A later non-blocking-core failure is an ordinary on-sight quarantine decision. `FNXC:PgTestTemplateDb 2026-07-19-17:20` (run-shared golden template) and `FNXC:PgTestWorkerCap 2026-07-18-18:00` (four-fork PG-gate cap) are already-landed mitigations for this same 15s setup-hook timeout mode.

## Policy and escalation

Quarantine is file-level, while the first-sighting exception preserves coverage in files retaining 6 / 75 / 80 passing tests. Under that exception, recording preserves valuable coverage. A **second sighting** of a registered test is an on-sight quarantine: add it to `scripts/lib/test-quarantine.json` and the matching Vitest `exclude` in one lockstep commit; this register entry is then evidence for the ledger `reason`.

Merge-gate eviction records follow a separate branch: the gate can no longer be reddened by that file, while the non-blocking suite retains coverage. A further failure there is an ordinary on-sight quarantine. For PostgreSQL files, the gate-policy assertion forbidding a core-config quarantine exclude makes that an owner decision escalated as its own task rather than an inline edit.

Capture **full runner output** before recording or quarantining a failure—for example, tee it to a file. Never pipe a dot reporter through `tail`: the summary survives while the `FAIL` identity lines needed for a quarantine entry are exactly what gets truncated.

Source: [Runfusion/Fusion issue #2862](https://github.com/Runfusion/Fusion/issues/2862).



## Archive — closed records

Archived records are historical evidence only and never authorize a quarantine decision.

<!--
FNXC:TestFlakeRegister 2026-10-08-15:40:
KB-081 records a first sighting in the CLI extension suite that shared entry 27's timeout and left-running-postmaster shape but had a different cause. It closes on a structural test-harness fix, so no quarantine was needed. No timeout, retry, or assertion was widened.
-->
### 39. CLI extension github-tracking create timeout and orphaned embedded PostgreSQL boot

- **Status:** Closed 2026-10-08 — structurally resolved on first sighting by KB-081 (test and harness fix); no quarantine.
- **File:** `packages/cli/src/__tests__/extension.test.ts`
- **Exact tests:** `fn pi extension (runnable structured-output regression slice) > fn_task_create persists per-task github tracking overrides from github_tracking/github_repo` (`Test timed out in 5000ms`) and `fn pi extension (runnable structured-output regression slice) > fn_task_update rejects reviewer assignment for implementation tasks` (`Test subprocess guard detected unsafe child-process usage`: an embedded `postgres` on the worker test home's default embedded data directory, port 44409, left running).
- **Observed tree/SHA:** fork Full Suite run [37758138036](https://github.com/stjepanvrbic/Fusion/actions/runs/37758138036) at `2f807ed88` (push to main, Linux `ubuntu-latest`), job `Test shard 3/4` (`113247693003`), `@runfusion/fusion` slice.
- **Observed frequency:** 1 run, 2 failures.

The two failures are one chain with two links. It is not entry 27's dead-joiner bug: the postmaster logged a fresh start and ready on port 44409 while the second test was current.

1. **Slow link.** `fn_task_create` awaits the task-created hook, and the GitHub tracking hook resolves gh-cli auth through the `@fusion/core` barrel's `isGhAvailable`/`isGhAuthenticated`. The file only mocked the `@fusion/core/gh-cli` subpath, so a real synchronous `gh --version` and `gh auth status` ran. The CI log shows `auth unavailable (gh_not_authenticated)` although the subpath mock returned authenticated. On a loaded runner this pushed the case past 5 s.
2. **Cascade link.** After the timeout, `afterEach` emptied the extension store cache, but the timed-out test body kept running. Its next tool call found no cached store, cold-booted `createTaskStoreForBackend`, and with no `DATABASE_URL` started embedded PostgreSQL in the worker home. The subprocess guard attributes a child to the test that is current at spawn time, so it failed the next test.

**Structural fix (KB-081).** `extension.test.ts` now mocks the barrel gh predicates as installed-but-unauthenticated, and the github-tracking case asserts that the mock was called and that a `github-issue-skipped` activity with reason `gh_not_authenticated` was recorded. The shared `pg-extension-harness.ts` installs a fail-fast store boot factory in `beforeAll` and every `beforeEach`, so any cold-cache boot rejects immediately with `PG extension harness: cold-cache TaskStore boot is forbidden` instead of starting a postmaster. A regression case in the same slice empties the cache mid-test and asserts that fail-fast error. All harness consumers pass. No timeout, retry, or assertion was widened, and no product code changed. A new sighting re-opens normal escalation.

<!--
FNXC:DesktopTestQuarantine 2026-09-24-07:48:
FN-9383 received three artifact-backed second sightings for the updater setup pair. The complete
native suite must be quarantined through the dated ledger and literal Vitest exclusion in the same
commit, preserving its assertions for a root-cause rescue instead of adding tolerance or retries.
-->
<!--
FNXC:TestFlakeRegister 2026-09-29-07:58:
FN-9419 quarantines entry 17 after its second identical terminal graph-gate assertion failure.
The archived evidence must retain both runs and the unchanged strict assertion so rescue requires a root-cause fix rather than tolerance.

FNXC:SkillsGetFlakeRegister 2026-09-29-17:01:
FN-9425 closes entry 19 after a second independent timeout-shaped Full Suite sighting. Preserve both
runs and six passing siblings while the 14-day CLI quarantine excludes routine discovery but keeps
explicit-file diagnostics runnable; timeout, retry, and assertion appeasement remain prohibited.
-->
<!--
FNXC:TestFlakeRegister 2026-10-07-18:04:
Entries 22 and 23 record same-day second sightings on the fork's Full Suite. Both files are quarantined through the dated ledger and the literal dashboard exclude in one commit. Rescue requires a root-cause fix; a widened timeout, retry, or weakened assertion is not a rescue.
-->
<!--
FNXC:TestFlakeRegister 2026-10-08-12:03:
Entry 31 recorded a second Full Suite sighting on the fork: the same parameterized row failed at the same assertion on a later commit. Quarantine is file-level, so the whole file is excluded through the dated ledger and the literal dashboard exclude in one commit. Rescue requires a root-cause fix; a widened timeout, retry, or weakened assertion is not a rescue.
-->
### 31. Mailbox paging production surfaces 120-message inbox desktop paging

- **Status:** Closed — quarantined 2026-10-08 after a second Full Suite sighting; deletion deadline 2026-10-22.
- **File:** `packages/dashboard/app/components/__tests__/MailboxPaging.surfaces.test.tsx`
- **Exact test:** `mailbox paging production surfaces > pages a 120-message inbox in %s %s until the last message is reachable` (parameterized `it.each`; the failing row was `MailboxView desktop` both times, and the CI log prints it as `...inbox in MailboxView desktop until the last message is reachable`).
- **Observed trees/SHAs:** fork Full Suite runs [37725718700](https://github.com/stjepanvrbic/Fusion/actions/runs/37725718700) at `b2dfb6316` (job `113143293384`) and [37763234227](https://github.com/stjepanvrbic/Fusion/actions/runs/37763234227/job/113264519354) at `bfe6023d4` (Test shard 4/4, job `113264519354`), both Linux `ubuntu-latest`, command `@fusion/dashboard run test:quality:app:backfill-4`, project `dashboard-app-quality-backfill`. The file passed in the Full Suite runs 37718606719 (`0bcb53f96`) and 37720328009 (`9e948d488`).
- **Observed frequency:** 2 runs, 1 failure entry each, the same row and the same assertion. The sibling mobile and other host rows passed (second run: 1 failed of 2260 tests in the command, 175 of 176 files passed).

| run | result |
|---|---|
| 37725718700 | `TestingLibraryElementError: Unable to find an element by: [data-testid="mailbox-item-in-99"]` from the `findByTestId` at `MailboxPaging.surfaces.test.tsx:88` |
| 37763234227 | the same message from the same line |

The first page (`mailbox-item-in-49`) had already rendered in both runs, so the first load-more click did not produce the second page of 50 rows within the default Testing Library timeout. The logs do not show whether the click was dropped, the second `fetchInbox` resolved late, or the rendered list was slow to commit 100 rows. No reproduction was attempted.

No timeout, retry, or assertion changed. The whole file is excluded from the dashboard projects. It is not in the thin merge gate, so no gate eviction was needed. Before the deletion deadline, check whether `MailboxView` can ignore or drop a load-more click while the previous inbox request or a background refresh is in flight. No product code changed in this quarantine.

<!--
FNXC:TestFlakeRegister 2026-10-08-07:20:
Entry 26 recorded a second Full Suite sighting on the fork: the same parametrized test failed on its desktop row after failing on its mobile row. Quarantine is file-level, so the whole file is excluded through the dated ledger and the literal dashboard exclude in one commit. Rescue requires a root-cause fix; a widened timeout, retry, or weakened assertion is not a rescue.
-->
### 26. Planning Mode sequential layout Other-input and answer submission

- **Status:** Closed — quarantined 2026-10-08 after a second Full Suite sighting; deletion deadline 2026-10-22.
- **File:** `packages/dashboard/app/components/__tests__/PlanningModeModal.ui-interactions.test.tsx`
- **Exact test:** `PlanningModeModal sequential layout > keeps five substantive choices and one Other usable on %s`, an `it.each` over `desktop` and `mobile`; the failing row was `mobile` on the first sighting and `desktop` on the second.
- **Observed trees/SHAs:** fork Full Suite run [37702452940](https://github.com/stjepanvrbic/Fusion/actions/runs/37702452940) at `41950446a` (job `113067879798`) and run [37735335086](https://github.com/stjepanvrbic/Fusion/actions/runs/37735335086) at `90619eba9` (job `113173460540`), both Linux `ubuntu-latest`, job `Test shard 3/4`, project `dashboard-app-quality-backfill`.
- **Observed frequency:** 2 runs, 1 failing row each. No failure of this file appeared in the Full Suite test shards for the neighbouring commits `ab5717807` (run 37702158378) and `0480b153b` (run 37698750646).

| run | row | result |
|---|---|---|
| 37702452940 | `mobile` | `TestingLibraryElementError: Unable to find an element by: [data-testid="planning-other-input"]` at `PlanningModeModal.ui-interactions.test.tsx:199`, the `fireEvent.change` right after the synchronous click on the Other radio; a React `An update to QuestionForm inside a test was not wrapped in act(...)` warning preceded it |
| 37735335086 | `desktop` | `AssertionError: expected "vi.fn()" to be called with arguments: [ 'session-1', …(2) ]` with `Number of calls: 0` at `PlanningModeModal.ui-interactions.test.tsx:194`, the `waitFor` that follows clicking the fifth-direction radio and then Next |

Both failures sit in the step where a click on a radio or on Next must commit a selection before the next statement runs. The first reads the Other input too early; the second sees no `respondToPlanning` call after Next. The logs do not show whether the radio was selected, and no shard-shaped reproduction was attempted.

No timeout, retry, or assertion changed. The whole file is excluded from the dashboard projects. It is not in the thin merge gate, so no gate eviction was needed.

This is the third quarantine in the Planning Mode subsystem after entries 22 and 23, plus closed entries 4, 5, 8, and 10. The AGENTS.md repeated-quarantine rule treats that as a product-race smell. Before the deletion deadline, inspect how `QuestionForm` in `PlanningModeModal` commits the Other selection and the Next submission after a radio change, and whether that state is set asynchronously. No product code changed in this quarantine.

<!--
FNXC:TestFlakeRegister 2026-10-08-08:41:
Entry 29 recorded a second Full Suite sighting on the fork: the same two switch-window cases failed again on shard 3. Quarantine is file-level, so the whole file is excluded through the dated ledger and the literal dashboard exclude in one commit. Rescue requires a root-cause fix; a widened timeout, retry, or weakened assertion is not a rescue.

FNXC:TestFlakeRegister 2026-10-08-13:35:
KB-063 investigated the product code before the deletion deadline and found a deterministic test-readiness defect plus a mock-leak cascade, not a product race. The closing paragraph records the verdicts and the proposed test-only rescue so whoever reaches the deadline can rescue rather than delete.

FNXC:TestFlakeRegister 2026-10-08-17:49:
KB-086 rescued entry 29 with the test-only root-cause fix KB-063 proposed, plus a deterministic regression that fails with the old wait. The ledger row and dashboard exclude were removed in the same commit as the fix; MissionManager.tsx did not change.
-->
### 29. MissionManager reconcile control switch-window cases

- **Status:** Closed — quarantined 2026-10-08 after a second Full Suite sighting; deletion deadline 2026-10-22. **Rescued 2026-10-08 by KB-086** (resolution below); the ledger row and dashboard exclude were removed in lockstep with the fix, and the file runs in `dashboard-app-quality-backfill` again.
- **File:** `packages/dashboard/app/components/__tests__/MissionManager.reconcile.test.tsx`
- **Exact tests:** two cases in `MissionManager reconcile control`: `silently discards preview resolution and rejection in the pre-commit switch window` and `refuses a same-batch retained-panel apply click so no write reaches the abandoned mission`.
- **Observed trees/SHAs:** fork Full Suite runs [37720328009](https://github.com/stjepanvrbic/Fusion/actions/runs/37720328009) at `9e948d488` (job `113126258105`) and [37742324890](https://github.com/stjepanvrbic/Fusion/actions/runs/37742324890) at `668244c5e` (job `113195660160`), both Linux `ubuntu-latest`, job `Test shard 3/4`, project `dashboard-app-quality-backfill`.
- **Observed frequency:** 2 runs, the same 2 cases each time. The file passed, with every other file in the shard green, in the Full Suite runs for `0bcb53f96` and `c5c3ee4fc`.

| case | failure, identical in both runs |
|---|---|
| `silently discards preview resolution and rejection in the pre-commit switch window` | `AssertionError: expected "vi.fn()" to be called 2 times, but got 1 times` at `MissionManager.reconcile.test.tsx:179`, the `waitFor` on `reconcileMission` after the second reconcile click |
| `refuses a same-batch retained-panel apply click so no write reaches the abandoned mission` | `TestingLibraryElementError: Unable to find an element by: [data-testid="mission-reconcile-apply"]` at `MissionManager.reconcile.test.tsx:190`, the `findByTestId` after the first click on the reconcile control |

Both are default-timeout Testing Library waits that expired while the rendered `MissionManager` still showed the mission list. The two cases exercise the mission-switch window, where the reconcile panel is released synchronously on a row event. No reproduction was attempted, and the logs do not show whether the two failures share a cause or whether the component was slow to commit the click.

No timeout, retry, or assertion changed. The whole file is excluded from the dashboard projects. It is not in the thin merge gate, so no gate eviction was needed.

**Investigation (KB-063): test defect, no product race.** A later reproduction found a deterministic test defect and no product race:

- **Readiness signal (confirmed defect):** `findByText("Mission two")` cannot prove that M-2 committed.
  - Before the commit, only the list-row title matches, so the wait resolves on its first check while the reconcile button is still disabled.
  - After the commit, three elements match (list row, mobile header, detail heading), so the query can only ever succeed before the commit.
  - The case passes only when React commits inside Testing Library's post-wait drain. When the commit lands later under shard load, the next reconcile click hits the disabled button and `reconcileMission` stays at 1 call.
- **Second case (confirmed cascade):** the first case's unconsumed `mockReturnValueOnce(rejected.promise)` survives `vi.clearAllMocks()`. The next case's first reconcile click therefore receives a never-settling promise, and the apply control never renders. That is why the two cases always fail together.
- **Product race (not supported):** refusing a reconcile click while selection intent is ahead of the committed detail is the designed `MissionReconcileControl` behavior. Only selection boundaries invalidate a request.

A scratch copy that delayed only the first case's M-2 commit past the readiness wait reproduced both CI failures exactly. The unmodified copy passed.

The proposed rescue is test-only:

1. Wait on a commit-proving signal, such as the level-3 detail heading or the reconcile button becoming enabled.
2. Reset `reconcileMission` once-implementations between cases.
3. Remove the ledger row and the dashboard exclude in lockstep when the fix lands.

The executing session could not create tasks, so the rescue was raised as a KB-063 completion recommendation. No product code changed.

**Resolution (KB-086, 2026-10-08).** KB-086 landed the proposed test-only rescue:

- **Commit-proving wait:** every mission-switch readiness wait (the `openM2` helper, both deep-link waits, and the four switch-window cases) now uses a `findCommittedMission` helper that waits for the level-3 detail heading. That heading renders only from the committed `selectedMission`, so the wait cannot resolve on the list row.
- **Leak fix:** `beforeEach` calls `reconcileMission.mockReset()` after `vi.clearAllMocks()`, so a queued once-implementation cannot reach the next case. `vi.resetAllMocks()` was avoided because it would also reset the inline mocks in the `../../api` factory.
- **Regression:** a new case, `waits for the switched mission's detail to commit before treating it as ready`, holds M-2's `fetchMission` pending, yields real time, and asserts that the readiness wait has not settled and the reconcile control is still disabled. With the helper swapped back to `findByText(title)`, it failed deterministically at that pending-window assertion; with the heading wait it passes.
- **Leak proof:** a scratch unconsumed `mockReturnValueOnce(new Promise(() => {}))` at the end of the switch-window case reproduced the retained-panel failure (`Unable to find an element by: [data-testid="mission-reconcile-apply"]`) without the reset and passed with it.
- **Stability:** 18/18 cases passed in 10 sequential runs and 3 `--sequence.shuffle` runs of the file in `dashboard-app-quality-backfill` on Windows.

No product code, timeout, retry, or assertion changed; the scratch proofs were not committed.

<!--
FNXC:TestFlakeRegister 2026-10-08-11:22:
Entry 30 recorded a second Full Suite sighting on the fork: the same case failed at the same assertion on a later commit. Quarantine is file-level, so the whole file is excluded through the dated ledger and the literal engine-default exclude in one commit. Rescue requires a root-cause fix; a widened timeout, retry, or weakened assertion is not a rescue.
-->
### 30. Instance-scoped OAuth refresh hanging-request bound

- **Status:** Closed — quarantined 2026-10-08 after a second Full Suite sighting; deletion deadline 2026-10-22.
- **File:** `packages/engine/src/__tests__/auth-storage-durability.test.ts`
- **Exact test:** `instance-scoped OAuth refresh > bounds a hanging refresh request instead of waiting on it indefinitely`.
- **Observed trees/SHAs:** fork Full Suite runs [37725718700](https://github.com/stjepanvrbic/Fusion/actions/runs/37725718700/job/113143293387) at `b2dfb6316` (job `113143293387`) and [37756067075](https://github.com/stjepanvrbic/Fusion/actions/runs/37756067075/job/113240796645) at `b4ffbded6` (job `113240796645`), both Linux `ubuntu-latest`, job `Test shard 1/4`, project `engine-default`. The file passed in the Full Suite runs 37718606719 (`0bcb53f96`) and 37720328009 (`9e948d488`). A Windows lane single sighting of the same case at `9d216bec` (run 37693147198) is recorded in the KB-008 table below.
- **Observed frequency:** 2 Linux runs, 1 failure entry each, the same case and the same assertion.

| run | result |
|---|---|
| 37725718700 | `AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times` at `auth-storage-durability.test.ts:160` |
| 37756067075 | the same message at the same line; the shard also failed `workflow-planning-continuation-terminal-gap-live-e2e.pg.test.ts` (2 failed, 7526 passed, 13 skipped across 581 files) |

The case fakes only `setTimeout` and `clearTimeout`, starts `getApiKey` on an expiring OAuth instance, then advances fake time in 5 ms steps for at most 200 iterations while waiting for the mocked `fetch` to be invoked. The loop ended with no call both times, so the refresh path never reached `fetch` within those iterations. The loop is a bounded count of microtask-yielding advances rather than a wall-clock wait, so it can run out when the real work between the call and `fetch` (instance read, lock acquisition, file I/O) is starved of event-loop turns. This reads the logs; no shard-shaped reproduction was attempted.

No timeout, retry, or assertion changed. The whole file is excluded from the `engine-default` project. It is not in the engine-core merge-gate allow-list, so no gate eviction was needed. Before the deletion deadline, check whether the refresh path performs real file or lock I/O before calling `fetch`, which a fake-timer polling loop cannot wait out deterministically. No product code changed in this quarantine.

<!--
FNXC:TestFlakeRegister 2026-10-08-09:18:
Entry 34 recorded a second Full Suite sighting on the fork: the same case failed at the same assertion on a different shard. Quarantine is file-level, so the whole file is excluded through the dated ledger and the literal dashboard exclude in one commit. Rescue requires a root-cause fix; a widened timeout, retry, or weakened assertion is not a rescue.
-->
### 34. AgentDetailView log history SSE suspend and reopen subscription

- **Status:** Closed — quarantined 2026-10-08 after a second Full Suite sighting; deletion deadline 2026-10-22.
- **File:** `packages/dashboard/app/components/__tests__/agent-detail-log-history.test.tsx`
- **Exact test:** `AgentDetailView — agent log history is windowed, not discarded > converges after an SSE suspend/reopen cycle without losing lines`.
- **Observed trees/SHAs:** fork Full Suite runs [37739564135](https://github.com/stjepanvrbic/Fusion/actions/runs/37739564135/job/113186875691) at `7fcb6ea1c` (Test shard 3/4, job `113186875691`) and [37747085495](https://github.com/stjepanvrbic/Fusion/actions/runs/37747085495/job/113211010537) at `628231a55` (Test shard 4/4, job `113211010537`), both Linux `ubuntu-latest`, command `@fusion/dashboard run test:quality:app:backfill-4`, project `dashboard-app-quality-backfill`. The shard-3 jobs of the Full Suite runs for `0c50dbd0f` and `cd7130a99` passed.
- **Observed frequency:** 2 runs, the same case and the same assertion each time, in a command that reported 2274 tests with 1 failed.

| run | result |
|---|---|
| 37739564135 | `AssertionError: the latest-run log stream must be subscribed: expected undefined to be truthy` at `agent-detail-log-history.test.tsx:217` |
| 37747085495 | the same message at the same line |

The case reads `mockSubscribeSse.mock.calls.find(...)` for `/api/agents/agent-001/runs/<run>/logs/stream` right after `await waitFor(() => expect(renderedEntryTexts()).toHaveLength(WINDOW))` and found no call. The earlier case in the same file that needs this subscription wraps the same lookup in `waitFor`; this one does not. This shares a shape with entry 32, where the test read the SSE subscribe mock before the subscribing effect had flushed. The mechanism is unmeasured for both entries. A local Windows run passed (9 tests).

No timeout, retry, or assertion changed. The whole file is excluded from the dashboard projects. It is not in the thin merge gate, so no gate eviction was needed. Before the deletion deadline, inspect when `AgentDetailView` subscribes to the latest-run log stream relative to the rendering of the fetched entries, or make the case wait on the subscription as its neighbour does. No product code changed in this quarantine.

<!--
FNXC:TestFlakeRegister 2026-10-08-04:50:
Entry 28 recorded a second Full Suite sighting on the fork, so the file is quarantined through the dated ledger and the literal engine-default exclude in one commit. Rescue requires a root-cause fix; a widened timeout, retry, or weakened assertion is not a rescue.

FNXC:TestFlakeRegister 2026-10-08-09:04:
KB-056 rescued entry 28 with a deterministic reproduction and a harness root-cause fix (shared real worktree-reservation claim across test files). The ledger row and engine-default exclude were removed in lockstep; the file is not admitted to engine-core.
-->
### 28. TaskExecutor fn_task_done summary persistence implementation session never opened

- **Status:** Closed — quarantined 2026-10-08 after a second Full Suite sighting; deletion deadline 2026-10-22. **Rescued 2026-10-08 by KB-056** (root cause below); the ledger row and engine-default exclude were removed in lockstep, and the file runs in engine-default again (not admitted to engine-core).
- **File:** `packages/engine/src/__tests__/executor-task-done-summary.test.ts`
- **Exact tests:** five cases in `TaskExecutor fn_task_done summary persistence`: `replaces the summary on the first completion when no prior summary or workflow results exist`, `appends rerun summaries when a prior summary exists and workflow steps have already run`, `falls back to replace mode when a prior summary exists but no workflow steps have run yet`, `does not rewrite the summary when fn_task_done receives an empty or missing summary`, and `avoids duplicate appends when the rerun summary is already the existing suffix`.
- **Observed trees/SHAs:** fork Full Suite runs [37717586213](https://github.com/stjepanvrbic/Fusion/actions/runs/37717586213) at `08361ff9c` (job `113117541124`) and [37720611351](https://github.com/stjepanvrbic/Fusion/actions/runs/37720611351) at `a05be4484` (job `113127146317`), both Linux `ubuntu-latest`, job `Test shard 2/4`, project `engine-default`.
- **Observed frequency:** 2 runs, 5 failure entries each, one per case. The file passed in the Full Suite runs for `997ab2360` and `81da06824` around the first sighting.

| run | result |
|---|---|
| 37717586213 | first case `Error: Test timed out in 30000ms`; the other four `AssertionError: TaskExecutor should open an implementation session with fn_task_done: expected null not to be null` in `setupTaskDoneTool`; 1 other file failed in the shard (`merge-orphan-durable-write-inventory-drift.test.ts`) |
| 37720611351 | the same five failures with the same messages and lines; 575 of 577 engine-default files passed, and the other failure was `mcp-builtin-lane-coverage.test.ts` line-number drift after KB-010 |

In every failing case `executor.execute` returned without `createFnAgent` ever receiving a `fn_task_done` custom tool, so no implementation session was opened. The `08361ff9c` commit changed only a CLI test, so the first sighting is load- or environment-shaped. The `a05be4484` commit edited merge-path session disposal and did not touch the executor. The file run alone passed 5 of 5 on a local Windows checkout at `f0d352f45`; no shard-shaped reproduction was attempted. Neither log shows why `execute` returned early or whether the four later cases cascade from the first case's timeout.

No timeout, retry, or assertion changed. The whole file is excluded from the `engine-default` project, which also refuses an explicit-path run until the exclude is removed. It is not in the engine-core merge-gate allow-list, so no gate eviction was needed.

This is the second executor-subsystem quarantine after `executor-prompt.test.ts`, whose pause-resume case also observed zero `createFnAgent` calls only under shard load. The AGENTS.md repeated-quarantine rule treats that as a product-race smell. Before the deletion deadline, inspect the guarded in-place re-dispatch timer that audit PR #32 (`9cf9144d6`) introduced for executor retries, and whether `execute` can return or defer re-dispatch before the first implementation session is created. No product code changed in this quarantine.

**Resolution (KB-056, 2026-10-08).** The cause was in the test harness, not in production. About 80 engine files run `new TaskExecutor(store, "/tmp/test")` with task `FN-001`, and worktree acquisition writes a real claim under `<rootDir>/.fusion/worktrees/.fusion-worktree-locks/<sha256(fn-001)>`; the harness mocks `node:fs`, not `node:fs/promises`. Under `pool: "threads"` every worker shares one pid, and a same-host claim with a live pid is never stale. This file's sessions, like others, never call `fn_task_done` during `execute()`, so each executor entered the missing-`fn_task_done` in-place retry (PR #32's timer). Because the mock store never persists `taskDoneRetryCount`, that bounded production retry became an unbounded background loop that re-created the worktree, taking the reservation each time, and re-claimed the process-wide `FN-001` graph routing. When vitest tore down a worker mid-iteration, it abandoned a claim that stayed live for the whole process. Deterministic probe: hold a live same-pid claim on that directory, then `execute(FN-001)`. The run stayed pending past 5 s and failed at 30 046 ms with `Timed out acquiring worktree reservation ... after 30000ms`, which is the hosted first-case timeout. A concurrent `execute()` returned in 0 ms with no session, because the stalled run held the routing; that is the hosted `expected null not to be null`. CPU starvation alone never reproduced it. Fix: `executor-test-helpers.ts` gives each test file a private reservation domain (`worktree-reservation-isolation.ts`) while keeping real claim semantics inside the file. This file also drains its tracked executor work after each test and asserts that no `FN-001` routing owner leaked. Regression: `opens the implementation session while another test file holds the shared worktree reservation` times out at 30 s with the pre-fix harness and passes in about 90 ms after the fix. Mutation evidence: disabling the rerun-append branch, or forcing replace, fails one or two cases. Stability: 20/20 runs alone, and 5/5 shuffled runs alongside seven other `/tmp/test` executor files. No production code changed, and no timeout, retry, or assertion was relaxed.

### 24. test-changed prune cases scanning the shared temp dir

- **Status:** Closed 2026-10-07 — structurally resolved on first sighting; no quarantine.
- **File:** `scripts/__tests__/test-changed.test.mjs`
- **Exact test:** the `pruneFusionTestWorkers: ...` node:test cases (the observer did not record which case failed).
- **Observed tree/SHA:** a local Windows run by the test-gate-integrity session on 2026-10-07, while other sessions' Vitest worker roots were live; the observer did not capture the SHA.
- **Observed frequency:** failed once, then passed on 3 reruns.

The prune cases scanned the shared OS temp dir, so their result depended on whatever concurrent sessions had left there, and the pid-liveness stub made every other session's worker root look dead to the prune. `pruneFusionTestRoots` now takes a `tempRoot` option that defaults to the OS temp dir, and every prune case scans its own private root. All 125 cases in the file pass. No timeout, retry, or assertion changed.

### 22. Planning Mode duplicate-response reconciliation re-sighting

- **Status:** Closed — quarantined 2026-10-07 after a re-sighting of entry 8's exact case; deletion deadline 2026-10-21.
- **File:** `packages/dashboard/app/components/__tests__/PlanningModeModal.planning-flow.test.tsx`
- **Exact test:** `PlanningModeModal sequential flow > silently reconciles duplicate-response generation conflicts on $viewport with $label`
- **Observed tree/SHA:** fork Full Suite run [37648267708](https://github.com/stjepanvrbic/Fusion/actions/runs/37648267708) at `1359c449cd`, job `112884602084`, lane `dashboard-app-quality-backfill --shard=3/4`.
- **Observed frequency:** 1 failed / 6008 passed in that lane; the concrete row was `'desktop'` with `'a durable next question'`. The next fork Full Suite run, [37660774452](https://github.com/stjepanvrbic/Fusion/actions/runs/37660774452) at `2cd182201`, passed it.

The failure was `expect(element).toBeEnabled()` on the primary planning action (`.planning-actions-primary` stayed `disabled`) inside a `waitFor` at `PlanningModeModal.planning-flow.test.tsx:81`. Entry 8 closed this exact case on 2026-08-16 as a product race fixed by FN-9116, and the lane-sharding entry below recorded two more moving-case sightings in the same file at `c82e420ba0`. A re-sighting after a claimed structural fix is an ordinary on-sight quarantine.

This is the file's third register history after entries 4, 5 and 8, so the AGENTS.md repeated-quarantine rule treats it as a product-race smell. Before the deletion deadline, inspect `handleSubmitResponse`'s duplicate-response reconciliation in `PlanningModeModal`: the disabled primary action means a reconciliation or recovery write left the view in a busy state after the duplicate rejection. No product code changed in this quarantine.

### 23. Planning Mode browser E2E Chromium lifecycle

- **Status:** Closed — quarantined 2026-10-07 after two Full Suite sightings in one day; deletion deadline 2026-10-21.
- **File:** `packages/dashboard/src/__tests__/planning-browser-e2e.test.ts`
- **Exact test:** `Planning Mode browser E2E` suite `beforeAll` hook and every case that depends on its shared browser.
- **Observed trees/SHAs:** fork Full Suite runs [37648267708](https://github.com/stjepanvrbic/Fusion/actions/runs/37648267708) at `1359c449cd` (job `112884602255`) and [37652972793](https://github.com/stjepanvrbic/Fusion/actions/runs/37652972793) at `595b2f5fad` (job `112900802405`), lane `dashboard-api-quality-backfill --shard=1/2`.
- **Observed frequency:** 2 of the last 13 fork Full Suite runs; the following run, [37660774452](https://github.com/stjepanvrbic/Fusion/actions/runs/37660774452) at `2cd182201`, passed the file.

| run | result |
|---|---|
| 37648267708 | suite failed: `Hook timed out in 30000ms` at the `beforeAll` that starts Vite and launches Chromium; 1955 lane tests passed |
| 37652972793 | 5 of 5 cases failed: `page.goto: Target page, context or browser has been closed` on the first navigation; 1955 lane tests passed |

Classification: a load-sensitive Chromium lifecycle flake, not a product defect. Both shapes are the shared browser failing to start or dying before any Planning Mode assertion runs, while the lane reported `import` times above 300 s for 167 files. No run shows a Planning Mode assertion failing. The `@lydell/node-pty` lockfile integrity mismatch printed in the CLI shard of the same runs is environmental and unrelated; no lockfile changed.

Rescue lead: the fixture passes `server.port: 0`, but Vite treats `0` as unset and binds its default port 5173, walking upward on conflict, so the server never had an ephemeral port. That is a fixture defect worth fixing in any rescue, though neither sighting shows it caused the failure. The opt-in `dashboard-browser-touch` project does not run in CI, so moving the file there would only hide it.

### 19. Built skills-get global flag completion

- **Status:** Closed — quarantined 2026-09-29 by FN-9425 after the second sighting triggered the deletion ratchet; deletion deadline 2026-10-13.
- **File:** `packages/cli/src/commands/__tests__/skills-get.test.ts`
- **Exact test:** `fn skills get > preserves global flag precedence and validation for built guide requests`
- **First-sighting tree/SHA:** `7d5e1dccca` (FN-9421).
- **Observed frequency:** 2 timeout-shaped sightings, Full Suite push shard 3 only.

Push Full Suite run [36562243319](https://github.com/Runfusion/Fusion/actions/runs/36562243319), shard 3 timing artifact `test-timings-shard-3` (`packages/cli/.timings/timings-shard3-0.json`; artifact id `11031020537`), reported `STACK_TRACE_ERROR` at `skills-get.test.ts:91` after 5228.5 ms. The six sibling cases in the file passed, including the FN-9395-owned guide/version case. The immediately preceding push run [36541404695](https://github.com/Runfusion/Fusion/actions/runs/36541404695) at `3d051dbfab` passed this exact case in 4247 ms.

Push Full Suite run [36580840868](https://github.com/Runfusion/Fusion/actions/runs/36580840868) repeated the exact case after 5914.7 ms. Its failed-set delta against run 36562243319 was 0 newly failed / 0 fixed / 188 still failing, so recurrence across independent main pushes is flake evidence rather than a product regression tied to FN-9423's register-only diff.

FN-9423 rebuilt the CLI and ran the exact file through the built `bin.mjs` entry point successfully. It exercised the version, help, and duplicate-project built-child requests without changing the five-second test budget, adding retries, weakening assertions, or changing guide behavior. FN-9425 quarantined the whole file through the dated ledger and static CLI list; direct naming still runs the file for diagnosis. No engine-core merge-gate allow-list changed. Rescue before 2026-10-13 requires evidence that the test catches a real regression and a root-cause fix; it must not widen the timeout, add retries, force process termination, or weaken output or exit assertions.

### 17. Terminal graph-gate activity outbox contract

- **Status:** Closed — quarantined 2026-09-29 after the second sighting triggered the deletion ratchet; deletion deadline 2026-10-13.
- **File:** `packages/engine/src/__tests__/agent-activity-writers.test.ts`
- **Exact test:** `engine agent activity durable writer > persists a terminal graph gate through the production TaskStore outbox facade`
- **Observed tree/SHA:** `c76cb158f4` (FN-9388).
- **Observed frequency:** 2 sightings, Full Suite push shard 1 only.

Push Full Suite run [36034454035](https://github.com/Runfusion/Fusion/actions/runs/36034454035), shard 1 artifact `test-timings-shard-1` (`packages/engine/.timings/timings-shard1-1.json`), reported this exact test at line 381: `events[0]` was shown as `{ seq: '2', …(11) }` and did not match the unchanged `workflow:gate-passed` contract. The CI run's full runner output and timing JSON remain in that GitHub Actions run; the incident task document records the inspected command output and planner evidence.

No product race was established. The terminal writer appends exactly one event after the persisted terminal result; `appendAgentActivityEvent` serializes each project-wide counter allocation and stores the type in the same transaction; and `queryAgentActivityEvents` filters by project, task, and `type: "workflow:gate-passed"` before mapping its returned row. Sequence `2` is therefore valid evidence of an earlier event in the same project, not event identity and not a path by which a non-gate row can pass the type filter. The current shard planner still assigns `@fusion/engine --shard=1/2` to Full Suite shard 1, with the runner defaults resolving to 12 workers and concurrency 2.

| control | result |
|---|---|
| exact `c76cb158f4`, full file | passed, 11/11 in 10.9s |
| exact `c76cb158f4`, exact test | passed, 1 passed / 10 skipped |
| push run 35974858442, instance 3 | passed; exact full name absent from the shard failed set |
| push run 35991562171, instance 4 | passed |
| current targeted file | passed, 11/11 |

Push Full Suite run [36533908544](https://github.com/Runfusion/Fusion/actions/runs/36533908544), SHA `3471d08566` (FN-9406), repeated the exact terminal graph-gate assertion after 195 seconds while ten sibling cases passed. This was the same assertion as the first sighting, so FN-9419 quarantined the file through the dated ledger and direct `engine-default` exclusion.

The strict production TaskStore outbox path remains untouched: `events.length === 1` and the `toMatchObject({ type: "workflow:gate-passed", ... })` contract are unchanged. No timeout, retry, skip, or assertion weakening was introduced. Rescue requires evidence that the test catches a real regression plus a root-cause fix before the 2026-10-13 deletion deadline.

### 16. Native updater setup mock lifecycle

- **Status:** Closed — quarantined 2026-09-24 after three artifact-backed second sightings; deletion deadline 2026-10-08.
- **File:** `packages/desktop/src/__tests__/native.test.ts`
- **Exact tests:** `native integrations > setupAutoUpdater > registers updater listeners and checks for updates`; `native integrations > setupAutoUpdater > sets updater download and install flags`.
- **First-sighting tree/SHA:** GitHub Actions Full Suite push run [35920595803](https://github.com/Runfusion/Fusion/actions/runs/35920595803), `2ed9b65c116cf85e19f2428832a335fc56b0fa09`.
- **First-sighting artifact provenance:** complete, unexpired `test-timings-shard-4` artifact `10777232469`, created `2026-09-23T21:18:59Z`; normalized Vitest reporter records identify both exact names.
- **Local reproduction at first sighting:** `pnpm --filter @fusion/desktop exec vitest run src/__tests__/native.test.ts --silent=passed-only --reporter=dot` passed, including both subjects.
- **Repeated Full Suite evidence:** QA downloaded the completed `test-timings-shard-4` artifacts for push runs [35959852349](https://github.com/Runfusion/Fusion/actions/runs/35959852349) (`70f6fc2d43fb68da91f20f890f8f024a381a20aa`, artifact `10791528512`), [35965109937](https://github.com/Runfusion/Fusion/actions/runs/35965109937) (`ee71b2a82f7bede2d906c15e1ad28e32299f4181`, artifact `10794177333`), and [35965648898](https://github.com/Runfusion/Fusion/actions/runs/35965648898) (`d05dd7e8b4d18d47c9de74438d74b8b521cb058e`, artifact `10794277474`). Each artifact records both exact tests as failed.
- **Failure modes:** the listener case timed out at `native.test.ts:326` with `expected "vi.fn()" to be called 1 times, but got 2 times`; the flags case reported `STACK_TRACE_ERROR` from the Vitest runner.
- **Disposition:** FN-9383 quarantined the complete file through `scripts/lib/test-quarantine.json` and a matching literal desktop Vitest exclusion. No timeout, retry, skip, assertion, or updater implementation changed. Rescue requires evidence that the tests catch a real regression plus a root-cause fix before the 2026-10-08 deletion deadline.

### 14. Merge-node paused-abort retry sequence

- **Status:** Closed 2026-09-09 by FN-9283 — deleted after the deterministic stale-lifecycle-assertion diagnosis.
- **File:** `packages/engine/src/__tests__/reliability-interactions/merge-node-paused-abort-retryable.test.ts`
- **Exact test:** `merge-node paused-abort retry classification (FN-6735) > re-enqueues benign paused merge graph failure at node %s without operator-action failure` (parameterized `it.each`; the observed case was `%s` = `merge`, plus 12 sibling sequence failures).
- **Observed tree/SHA:** first sighting `f3e1e7d1f`; second sighting during FN-249 verification after `2ab621ac6`.
- **Observed frequency:** Two file-sequence failures; the selected exact subject passed in isolation after each.

| run | result |
|---|---|
| first file as `engine-reliability` | **13 failed / 44 passed**; paused-abort retry and implementation-incomplete sibling assertions missed their expected recovery writes |
| first selected exact subject alone | passed (exit 0) |
| second file as `engine-reliability` | **13 failed / 44 passed** with the same recovery-write misses |
| second selected exact subject alone | passed (exit 0) |

The failure remains sequence-only evidence, not an attribution to FN-249: its changed user-cancellation path is not enabled by this fixture, and the selected pre-existing engine-abort subject passes in isolation. Per the mandatory deletion ratchet, the second sighting is quarantined in `scripts/lib/test-quarantine.json` and the matching `engine-reliability` exclude; no timeout, retry, or assertion was changed. Rescue requires a root-cause fix that proves the file's recovery coverage is stable.


**Closed by deletion 2026-09-09 (FN-9283):** The required whole-file `engine-reliability` reproduction still produced **13 failed / 44 passed**, but the same current failed cases also failed when selected with `-t`. A temporary unique-task-id probe retained the same 13 failures, ruling out the suspected task-id-keyed process-state channel. The failure is deterministic stale coverage after FN-217: `route-graph-failure-to-execution-resume.ts` now refuses automatic review-to-WIP moves, and `handle-graph-failure.ts` preserves failed in-review merge parks. Rescuing the file would reintroduce forbidden lifecycle authority or weaken/delete assertions, so FN-9283 selected the deletion decision rule's forbidden-repair clause.

The recorded failing shape was always the single whole-file `engine-reliability` run; the four-file command was only a derived neighbour probe and was never an observed reproduction. Deletion loses the file's direct FN-6735 matrix coverage for merge-seam node aliases, auto-merge pause-abort retry, manual-hold stale clearing, implementation-incomplete resume, and preserved active-worktree registration. The source-tree grep found no surviving test file that references FN-6735. Follow-up task **FN-9297 — Restore merge pause-abort recovery coverage** delivered the mandatory deterministic successor: the restored coverage now lives in `packages/engine/src/__tests__/merge-pause-abort-recovery.test.ts` as narrow unit coverage over `is-retryable-benign-merge-pause-abort.ts` and `graph-failure-pure.ts`, including pause-abort retry, manual hold, implementation-incomplete routing, and active-worktree registration.

| FN-9283 verification | result |
|---|---|
| whole file, engine-reliability | **13 failed / 44 passed** |
| three selected current failures with `-t` | each failed in isolation |
| unique-task-id whole-file diagnostic | **13 failed / 44 passed** |
| four-file derived neighbour probe | subject 13 failed; unrelated sibling baseline failures also present |

### 3. Plugin runner complete-lane lifecycle hook

- **Status:** Closed 2026-08-17 by FN-9141 — rescued (fixture defect).

- **File:** `packages/engine/src/__tests__/plugin-runner.test.ts`
- **Historical exact test:** `PluginRunner > task lifecycle hooks > should invoke onTaskCompleted when the complete lane is RENAMED`
- **Observed tree/SHA:** PR [#2799](https://github.com/Runfusion/Fusion/pull/2799) merged-with-main.

| run | result |
|---|---|
| full engine suite on #2799 merged-with-main (1st) | **8 failed** (7 in this file + 1 inherited) |
| full engine suite, same tree (2nd) | 1 failed (the inherited one only) |
| file alone | 80 passed |
| full engine suite on `origin/main` ×2 | clean |

Seven tests failed in `plugin-runner.test.ts`, but only this one identity survived capture: `--reporter=dot | tail -3` truncated the `FAIL` lines and retained only the summary.

**Quarantined 2026-08-16 (FN-9125):** Source inspection proved this unit file uses a local mocked TaskStore and has no PostgreSQL or harness import, so it does not belong to the database cluster. Three current full-engine lanes did not reproduce it, but the historical loaded failure lacks enough identities for a structural repair. The deletion-ratchet ledger and engine-default exclude were added together; assertions and timeouts are unchanged.

| verification | result |
|---|---|
| full engine ×3, 6 threads | subject passed; 35–36 unrelated baseline-red files remained |
| targeted plugin-runner | covered by subsequent quarantine-ledger verification |

**Retained after investigation 2026-08-17 (FN-9135):** FN-9135 temporarily lifted the paired default-lane exclusion and captured full verbose output for two runs each at 2, 6, and 8 workers. The subject passed every run and the 82-test isolated control; the loaded lane's unrelated baseline-red files did not identify a product or harness cause. The fixed microtask flush, duplicate helper, registry singleton, and hook timeout were investigated, but no root-cause defect or qualifying rescue was demonstrated. The test file, ledger row, and default-lane exclusion therefore remain together until the 2026-08-30 ratchet deadline, preserving plugin loading/contribution/runtime/hot-reload coverage and the remaining `onTaskCompleted` lifecycle-dispatch coverage.

| FN-9135 loaded reproduction | subject result | whole-lane result |
|---|---|---|
| 6 workers, run 1 (247.08s) | pass | 40 failed / 794 passed files; unrelated baseline-red |
| 8 workers, run 1 (197.47s) | pass | 40 failed / 794 passed files; unrelated baseline-red |
| 2 workers, run 1 (577.55s) | pass | 39 failed / 795 passed files; unrelated baseline-red |
| 6 workers, run 2 (230.06s) | pass | 39 failed / 795 passed files; unrelated baseline-red |
| 8 workers, run 2 (188.61s) | pass | 39 failed / 795 passed files; unrelated baseline-red |
| 2 workers, run 2 (590.97s) | pass | 39 failed / 795 passed files; unrelated baseline-red |

**Rescued 2026-08-17 (FN-9141):** FN-9141 completed the terminal new-strategy campaign with shuffled files/tests, worker reuse without per-file isolation, and a temporary byte-for-byte repeated subject. The completed two-worker lane reproduced a named test-fixture defect: a neighbouring worker-reused file can call `vi.clearAllMocks()` after `PluginRunner` has initialized, erasing `createLogger.mock.results` before the hot-reload warning assertion reads it. The assertion already catches the real `stopPlugin` rejection/warning contract; the repair keeps its logger instance in a hoisted stable reference and explicitly proves cleanup cannot erase that reference. The ledger row and default-lane exclusion remain removed together. No timeout, retry, assertion weakening, skip, polling, or permanent worker-policy change was used.

| FN-9141 new-strategy reproduction | seed | workers | isolation | duration | subject result | whole-lane result |
|---|---:|---:|---:|---:|---|---|
| shuffled, worker-reuse loaded engine-default | 914141 | 2 | disabled / worker reuse | 900.1s (campaign bound) | 82 passed | terminated before summary; unrelated `project-engine` timeouts after subject completed |
| shuffled, repeated-subject loaded engine-default | 914142 | 8 | enabled; temporary byte-for-byte subject repeat | 222.66s | original 82 passed; repeat 82 passed | complete: 48 failed / 787 passed / 1 skipped files; 117 failed / 11230 passed / 14 skipped / 1 todo tests; no subject failure |
| shuffled, worker-reuse, repeated-subject loaded engine-default | 914143 | 2 | disabled / worker reuse; temporary byte-for-byte subject repeat | 1548.60s | reproduced one hot-reload warning fixture failure; repeat passed | complete: 224 failed / 611 passed / 1 skipped files; 1801 failed / 9534 passed / 26 skipped / 1 todo tests; unrelated loaded failures also present |

The rescue retains plugin loading, contribution accessor, runtime compatibility, hot-reload, and lifecycle-hook assertions, including the renamed-complete-lane `onTaskCompleted` dispatch that would have been uniquely lost under deletion. The direct regression now covers the worker-reused cleanup sequence that caused the reproduced warning assertion failure.

### 4. Planning Mode direct task handoff

- **Status:** Closed 2026-08-10 by FN-8936 — superseded.

- **File:** `packages/dashboard/app/components/__tests__/PlanningModeModal.planning-flow.test.tsx`
- **Exact test:** `PlanningModeModal sequential flow > creates the task directly and offers task and session-list handoffs`
- **Observed tree/SHA:** `4e21f53996` (FN-8757 worktree)
- **Observed frequency:** first observation in the targeted file run.

| run | result |
|---|---|
| targeted file run | **1 failed** / 56 passed; `mockCreateTaskFromPlanning` was not called and jsdom reported unimplemented `window.scrollTo()` |
| isolated exact test | passed |

The failure is unrelated to the mobile question footer: it exercises the completed-plan Proceed handoff, while FN-8757 changes only the active-question footer. The file retains substantial coverage, so this first sighting is recorded rather than quarantined; a second sighting requires the normal file-level quarantine.

**Superseded 2026-08-10 (FN-8936):** The second sighting moved the file to the deletion-ratchet ledger. Investigation classified the direct handoff as a detached test-node hydration race, not a product create-state race; the suite was rescued by settling hydration and re-querying the live Proceed action before every previously unsafe direct click. The ledger and Vitest exclusion were removed together after exact and loaded-file proof, without timeout/retry/assertion appeasement.

### 5. Planning Mode mobile plan-tab selection

- **Status:** Closed 2026-08-10 by FN-8936 — suite re-admitted.

- **File:** `packages/dashboard/app/components/__tests__/PlanningModeModal.planning-flow.test.tsx`
- **Exact test:** `PlanningModeModal sequential flow > uses full-view Questions and Plan preview tabs on mobile`
- **Observed tree/SHA:** `main` at `4ff41a723c` with the Planning Mode task-creation fix uncommitted.
- **Observed frequency:** first observation in a targeted three-file dashboard run.

| run | result |
|---|---|
| targeted three-file dashboard run | **1 failed** / 198 passed; React reported an update outside `act(...)`, and the Plan tab still had `aria-selected="false"` immediately after `fireEvent.click` |

The failure exercises the pre-existing mobile tab transition, while the task-creation fix changes the completed-plan Proceed handoff. The file retains substantial coverage, so this first sighting is recorded rather than quarantined; a second sighting requires the normal file-level quarantine.

**Suite re-admitted 2026-08-10 (FN-8936):** This first-sighting mobile observation did not receive a second failure. The shared file-level quarantine was removed only after the direct-handoff root cause was structurally fixed and the unexcluded loaded suite, including this mobile coverage, passed.

### 8. Planning Mode duplicate-response generation reconciliation

- **Status:** Closed 2026-08-16 by FN-9116 — resolved (product race).
- **Re-sighted:** 2026-10-07 in fork Full Suite run 37648267708; the file is quarantined under entry 22.

- **File:** `packages/dashboard/app/components/__tests__/PlanningModeModal.planning-flow.test.tsx`
- **Exact test:** `PlanningModeModal sequential flow > silently reconciles duplicate-response generation conflicts on $viewport with $label`

<!-- FNXC:TestFlakeRegister 2026-08-16-10:52: Parametrized `it.each` cases are registered by their source-template title because the register validator checks raw test-file hierarchy segments. The concrete failing `'mobile'` row (`a durable next question`) and earlier contaminated `'desktop'` row remain recorded below as evidence. -->
- **Observed tree/SHA:** `main` at `8ee2ace2c1` (dashboard bare-run repair batch).
- **Observed frequency:** one clean sighting — solo standard-lane run (`node scripts/run-quality-tests.mjs`, lane `app:backfill-3`) on a quiet machine; the earlier `'desktop'`-row failure ran concurrently with a full bare vitest run and live peer-session edits to planning API files, so it is recorded as context, not as an independent clean sighting.

| run | result |
|---|---|
| solo standard lane (quiet machine) | **1 failed** (`'mobile'` row) / rest of lane passed |
| targeted file run immediately after | 58/58 passed |
| earlier busy-machine standard lane | **1 failed** (`'desktop'` row); targeted rerun 58/58 passed |

This file now carries THREE distinct register/ledger histories (entries 4 and 5 above plus this one) and one prior FN-8936 stabilization. Under the AGENTS.md repeated-quarantine rule this is a subsystem product-race smell: the duplicate-response generation reconciliation path (FN-8756 banner suppression / duplicate-generation dedup) should be investigated as a product race rather than stabilized a fourth time. Filed as a Fusion task; a second clean sighting of this exact test is an ordinary on-sight quarantine.

**Resolved 2026-08-16 (FN-9116): Product race.** `handleSubmitResponse` caught a duplicate response-generation rejection, awaited `fetchAiSession(sessionId)`, then wrote its old session snapshot after a newer writer could already own the UI. The fix captures the response load and turn epochs before the response await, so an A → B → A reload cannot let the old A response adopt the new A load epoch. Every reconciliation/fallback write drops when a newer load, response, stream event, or recovery transition owns the view.

Crucially, an accepted SSE `onError` is a turn boundary only after stale-event rejection. Its recovery captures that turn token across fetch and auto-retry awaits; a later response cannot be overwritten by an old reconnect, retry failure, or permanent error, and reconciliation from the errored turn cannot overwrite the recovery. The loading-poll error path now also claims its recovery turn *before* auto-retry: a successful retry returns early, so claiming afterward had left a held reconciliation authorized to overwrite recovery loading state.

FN-9116 adds deterministic ordering coverage for desktop and mobile rows across durable-question, result-only plan-review, generating snapshots, A → B → A reload/rejection, `onError`-before-reconciliation, `onError` recovery losing ownership to a later response, and loading-poll recovery landing before a held reconciliation. The non-duplicate actionable-error assertions remain intact and passing. Response actions now settle hydration and query the live control before dispatch, removing the detached hydration-node test seam without changing product semantics.

- **Resolved tree/SHA:** `d5f29bbdbc` (FN-9116 worktree; final documentation commit follows).

| verification | result |
|---|---|
| targeted planning-flow file ×3 | **passed** (76 tests each run) |
| shared-helper sibling suites ×1 | **passed** |
| `app:backfill-3` run 1 | **passed** (5,693 tests) |
| `app:backfill-3` run 2 | **passed** (5,693 tests) |
| `app:backfill-3` run 3 | **passed** (5,693 tests) |
| `pnpm lint`, `pnpm verify:fast`, `pnpm build` | **passed** |

The flake is structurally removed rather than stabilized: every hydration/recovery writer now has an ownership boundary before it can overwrite a newer turn. This is a published behavior fix, so FN-9116 includes a patch changeset.

### 11. Settings revision attribution reset-ordering assertion

- **Status:** Closed 2026-08-16 by FN-9129 — resolved (reset-ordering assertion).

- **File:** `packages/core/src/__tests__/settings-revision-attribution.test.ts`
- **Exact test:** `settings revision attribution > round-trips every explicit provenance variant through committed JSONB revisions`
- **Owner:** FN-9129
- **Observed tree/SHA:** retained FN-9128 logs; remediation started at `5e5422de6e57ead4f0c4a253b47b59063c1f9fe3`.
- **Observed frequency:** 5/5 retained loaded full-core runs (default, 4, 8, 12, and sampled 12 workers), not 4/5.

| run | result |
|---|---|
| FN-9128 loaded campaign | **failed 5/5**; retained `/tmp/fn-9128-core-*.log` |
| FN-9129 isolated pre-fix | **failed**; `/tmp/fn-9129-solo-1.log` |
| FN-9129 full core, 4 workers ×3 | subject passed after repair; first run had unrelated satellite-store failure, remaining two runs clean |
| FN-9129 full core, 12 workers ×1 | passed after repair; co-observed command-center cases passed |

Verbatim observed failure:

```
FAIL  src/__tests__/settings-revision-attribution.test.ts > settings revision attribution > round-trips every explicit provenance variant through committed JSONB revisions
AssertionError: expected [ { id: 'fusion-system', …(1) }, …(4) ] to deeply equal [ { kind: 'human', …(1) }, …(4) ]
```

**Resolved 2026-08-16 (FN-9129):** This was not configuration-provenance loss. A direct table dump retained in the FN-9129 `evidence` task document and `/tmp/fn-9129-instrumented.log` showed all five explicit actors physically persisted among 19 rows. The shared harness intentionally restarts identities between tests; consequently `ORDER BY sequence ASC` has duplicate values across reset boundaries, and the test's `.slice(before.length)` count window selected previous system rows. The assertion now identifies each explicit write by its test-owned `taskPrefix`, retains its immutable revision UUID, and re-reads only those IDs; regression coverage adds a post-snapshot background system write to prove it cannot enter the provenance assertion. This preserves the provenance invariant without retries, waits, quarantines, timeout changes, or a broad harness mutation.

The two command-center durable-agent activity cases observed once at 12 workers are classified as co-observed identity-reuse risk, not this subject's cause: the repaired 12-worker campaign passed them. Core PostgreSQL quarantine remains forbidden and `quarantinedCoreTests` remains empty.

### 9. Create Room picker loaded-lane state ordering

- **Status:** Closed 2026-08-16 by FN-9120 — resolved (product race).

- **File:** `packages/dashboard/app/components/__tests__/CreateRoomModal.test.tsx`
- **Exact test:** `CreateRoomModal > shows loading, empty, no-match, populated, and selected-member picker states`
- **Observed tree/SHA:** `7527d2651f` (FN-9120 baseline).
- **Observed frequency:** 2/2 loaded `dashboard-app-quality-backfill` shard-2 runs failed; a targeted rerun had passed before this investigation.

| run | result |
|---|---|
| loaded backfill shard 2 | **failed** — 1 failed / 2,134 passed; full output retained |
| loaded backfill shard 2 with picker instrumentation | **failed** — same assertion; fetch calls were exactly 1/2/3 and the member list still rendered Alpha/Beta after typing `zzz` |
| new ordering tests against unfixed component | **failed** — stale project result overwrote current roster; rejected load rendered no-agents copy |

**Resolved 2026-08-16 (FN-9120): both a timing-sensitive test assertion and a product race.** The original third phase synchronously asserted after `userEvent.type` while the loaded lane still rendered populated rows, even though its once queue had not shifted. Independently, the production effect had no cleanup or request identity, so a close/reopen, project change, or unmount could let a stale fetch write roster/loading/error state; initial `loadingAgents=false` also exposed terminal empty copy before the first effect.

The component now owns an explicit idle/loading/loaded/failed phase and fences each request with an epoch plus cleanup. A current successful reload removes selected IDs absent from its roster. The test uses controlled deferred promises in a single persistently-mounted modal, proves close/reopen/project ordering, failure and unmount fencing, duplicate-name/selection reconciliation, and desktop/mobile empty-state copy invariants without retries, sleeps, waits around the old assertion, or mock re-pinning.

### 10. Planning Mode loaded-turn affordance ownership

- **Status:** Closed 2026-08-16 by FN-9117 — resolved (product ownership race).

- **Files:** `packages/dashboard/app/components/__tests__/PlanningModeModal.planning-flow.test.tsx`, `PlanningModeModal.ui-interactions.test.tsx`
- **Exact cases:** `opens Plan preview without submitting and preserves the current mobile answer on return`; `can restart initial planning after stopping its first generation`; `can refine a stopped initial plan into the first question`; both desktop/mobile rows of `keeps five substantive choices and one Other usable on %s`; `submits an answer after deferred same-session hydration on %s`; and FN-9117's `keeps post-Stop plan review when a pre-Stop loading poll resolves on %s`.
- **Observed tree/SHA:** original reports at `9a9e591b72`; completed remediation tree `603373b93a`.

**Resolved 2026-08-16 (FN-9117): Product ownership race, not a timeout defect.** `QuestionForm` rendered from `workspaceQuestion`, while submit formerly branched on a closed-over `view`; a late hydration could therefore drop an enabled Next action. It also restored every new `initialResponse` object identity, overwriting a dirty same-question draft and disabling the mobile Next-question path. FN-9117 binds submit to the live session/question state and preserves a dirty same-question draft.

The Stop audit also confirmed the recovery-poll ownership hazard: Stop invalidates loading state then can restore the same session id for a question or summary terminal view. FN-9116's load-and-turn fence now rejects a poll started before that boundary. FN-9117 adds real-modal desktop and mobile deferred-poll coverage: fake timer time starts the 8-second poll, a deferred stale durable question resolves after Stop, and post-Stop plan review remains intact. The pre-FN-9116 source had effect-cleanup cancellation once terminal React state committed; the epoch fence closes the earlier render/cleanup interval structurally. No timeout, retry, widened wait, sleep, weakened assertion, or quarantine was used.

This completes the two Stop reports rather than deferring them as unreproduced. A same-session `ai_session:updated` rehydrate was the remaining transient-unmount path: `loadSession` cleared `workspaceQuestion` before its fetch resolved, unmounting `QuestionForm` and discarding the dirty answer. It now preserves an active question/plan-review workspace only for a refresh of that same session; a different session still enters the neutral loader. The real-modal deferred-hydration test uses per-character `userEvent.type` on desktop and the mobile Other choice, then asserts the exact `respondToPlanning` payload after the controlled commit.

It is the companion to entries 4, 5, and 8: FN-8936 fixed detached test-node handoff; FN-9116 fences duplicate-response and recovery writers; FN-9117 ensures visible question controls use the live turn and retain operator drafts.

| verification | result |
|---|---|
| targeted planning-flow + ui-interactions ×3 | **passed** (84 planning-flow tests, 20 UI-interaction tests) |
| all `PlanningModeModal.*` sibling suites | **passed** |
| `test:quality:app:backfill` aggregate attempt | shards 1–3 passed; initial 300s bound ended during shard 4, which passed when run directly |
| `test:quality:app:backfill` aggregate attempts 2–3 | blocked by repeated unrelated `CreateRoomModal` search-state failures; filed as FN-9121 with full logs `/tmp/fn-9117-backfill-run-{2,3}.log` |
| `pnpm lint`, `pnpm verify:fast`, `pnpm build` | **passed** |

No UI surface changed; this was a state-ownership and regression-coverage repair. The existing patch changeset remains applicable because Planning Mode behavior is user-visible.

### 12. Satellite approval audit lifecycle ordering assertion

- **Status:** Closed 2026-08-16 by FN-9132 — resolved (product ordering defect).

- **File:** `packages/core/src/__tests__/postgres/satellite-stores.pg.test.ts`
- **Exact test:** `PostgreSQL satellite stores (U6 consolidated, shared harness) > PostgreSQL satellite DB-injected stores (VAL-DATA-016) > ApprovalRequestStore: replayed/conflicting decisions 409, grants expire, ownership enforced`
- **Owner:** FN-9132
- **Observed tree/SHA:** deterministic pre-fix reproduction on `b31be1ba7c7415b9ee20c4c76875c961be73a0c3`; structural fix begins at `c3e3a2648a`.
- **Observed frequency:** co-observed in retained FN-9125 12-worker PostgreSQL-directory, FN-9129 4-worker full-core run 1, and FN-9130 loaded-measurement evidence.

Verbatim observed failure:

```
FAIL  src/__tests__/postgres/satellite-stores.pg.test.ts > PostgreSQL satellite stores (U6 consolidated, shared harness) > PostgreSQL satellite DB-injected stores (VAL-DATA-016) > ApprovalRequestStore: replayed/conflicting decisions 409, grants expire, ownership enforced
AssertionError: expected [ 'approved', 'created' ] to deeply equal [ 'created', 'approved' ]
```

| run | result |
|---|---|
| retained FN-9125 PostgreSQL directory, 12 workers | **failed** with the verbatim ordering assertion |
| retained FN-9129 full core, 4 workers run 1 | **failed** with the verbatim ordering assertion |
| FN-9132 deterministic one-worker frozen-Date repro, pre-fix | **failed**; both rows existed with identical `createdAt` values |
| FN-9132 targeted lifecycle, project-isolation, satellite, and dashboard-route suites | **passed** post-fix |
| FN-9132 PostgreSQL directory, 12 workers | **passed**; 173 files, 1370 tests passed, 1 skipped |

**Resolved 2026-08-16 (FN-9132):** This was a product ordering defect in `getApprovalAuditHistory`, not PostgreSQL DDL contention, harness identity reuse, or test timing. `appendAuditEvent` creates deterministic IDs containing the event type, while the read ordered tied timestamps by `id ASC`; that lexically placed `approved` before `created`. The read now applies a lifecycle rank derived from `APPROVAL_REQUEST_AUDIT_EVENT_TYPES`, followed by ID only as a final total-order tiebreak. Regression coverage freezes `Date` around real create/decide/complete writes and proves tied approved, denied, and completed states, distinct timestamps, mixed ties, project isolation, and the public store delegate. No timeout, retry, worker-count, skip, assertion weakening, or quarantine change was made; `quarantinedCoreTests` remains empty.

This resolves the previously unclassified “unrelated satellite-store ordering failure” mentions in entry 1's 12-worker verification table, entry 2's 12-worker verification table, and entry 11's FN-9129 4-worker run table. Those sightings are now classified separately from their entries' identity and DDL investigations.

**Terminal negative 2026-08-17 (FN-9131):** The reproduced 27-worker PostgreSQL-directory symptom was investigated with a cluster-shared connection-budget primitive. The first harness wiring and a follow-up that queued registry over-subscription while retaining leases both made the loaded run worse (135 failed files in 174.1s, then 144 failed files in 223.3s); the subject itself was not the only failure. The harness wiring was reverted, the primitive remains characterized independently, and FN-9139 owns a setup-safe admission boundary. No quarantine, timeout change, test retry, skip, worker cap, or assertion change was made.

---

## Entry: `self-healing-pending-wedge-notification` marker-selection count (first sighting)

- **Status:** Closed 2026-08-23 — file-level quarantine (second sighting); quarantine RESCUED and lifted 2026-09-02 by `9b29c6beab` (PR #3549).
- **File:** `packages/engine/src/__tests__/self-healing-pending-wedge-notification.test.ts`
- **Exact test:** `reconcile pending wedge notifications > selects elapsed markers and audits the completion outcome verbatim`
- **Owner:** unowned — first sighting, recorded rather than quarantined because the file's remaining coverage (4 tests over the pending-wedge reconciler) is substantial and quarantine is file-level.
- **Observed tree/SHA:** `ea48af7ab5`, during a full `@fusion/engine` suite run while auditing pre-existing failures.
- **Observed frequency:** once, suite-only. Passes deterministically in isolation.

Verbatim observed failure:

```
FAIL  |engine-default| src/__tests__/self-healing-pending-wedge-notification.test.ts > reconcile pending wedge notifications > selects elapsed markers and audits the completion outcome verbatim
AssertionError: expected 2 to be 1 // Object.is equality
 ❯ src/__tests__/self-healing-pending-wedge-notification.test.ts:50:62
```

| run | result |
|---|---|
| full engine suite (967 files), `ea48af7ab5` | **failed** with the verbatim count assertion |
| same file in isolation, same tree | **passed** (4/4) |
| full engine suite, baseline `3f448f7292` | not observed |

Reads as cross-test state bleed into the reconciler's marker selection (an expected-1 selection saw 2),
not a timing wait — so no timeout, retry, or assertion change was made. A SECOND sighting is an
ordinary on-sight quarantine with no further discretion, per the standing rule in AGENTS.md.

**Second sighting 2026-08-23, quarantine lifted 2026-09-02 (`9b29c6beab`, PR #3549).** The second
sighting arrived on a full engine-suite run at `a97aa84a20` and the file was quarantined on sight
(ledger entry plus a `packages/engine/vitest.config.ts` exclude, with a 2026-09-06 deletion
deadline). The quarantine was then lifted as a genuine rescue, not appeasement: the test now pins
its own clock (`vi.useFakeTimers()` plus `vi.setSystemTime`) and restores real timers in
`afterEach`, removing the cross-suite timer-state bleed this entry hypothesized — no timeout was
widened, no retry added, and no assertion relaxed. The ledger entry and the engine vitest exclude
were removed in the same commit and the file is live in the suite again. The commit message does
not mention the rescue — the evidence is in the test-file diff.

---

## Entry: `spec-drift-reconciler` exponential-backoff case (rescued 2026-09-12, FN-9290)

- **Status:** Rescued and closed 2026-09-12 by FN-9290. The quarantine-ledger row and matching `engine-default` Vitest exclude were removed together with the root-cause fix.
- **File:** `packages/engine/src/__tests__/spec-drift-reconciler.test.ts`
- **Exact test:** `SpecDriftReconciler > backs a persistent outage off exponentially instead of re-firing every second`
- **Root cause:** The test advanced coarse absolute 1s/1s/2s windows even though retries chain jittered delays from the prior firing. With d1 in [500,1000) and d2 in [1000,2000), the third attempt lands before 2000ms when d1 + d2 < 2000: a 25% probability. Minimum jitter deterministically reproduced `expected 3 to be 2`; this was neither load-dependent nor a product scheduler race.
- **Repair and coverage:** The reconciler now exposes its existing delay constants plus a default-identical random seam. The rescued test checks exact retry instants across eight gaps for four pinned draw sources, including two consecutive 60s-clamped ceiling gaps; a companion records arbitrary real `Math.random` draws and checks their exact schedule and ranges. Another companion keeps unrelated timeouts, an interval, microtasks, and promise chains active in every gap while checking no retry fires early. Additional tests cover success reset, duplicate retry-arm suppression, and `stop()` cancellation.
- **Mutation evidence:** Flattening delay and removing the ceiling clamp both fail the pinned and unpinned-random schedule guards. Removing the success reset fails the reset guard, and removing the pending-timer duplicate-arm guard fails the duplicate-arm guard.
- **Stability evidence:** 50 consecutive selected-file runs completed with zero failures, representing at least 50 independent asserted real-random samples rather than an assertion-free repetition loop.
- **Policy evidence:** No timeout was widened, retry added, assertion relaxed, or test skipped. The shared-harness cross-check found no timer fixture imported by both this file and `self-healing-pending-wedge-notification`; that separate quarantine record remains unchanged.

---

## Entry: `PlanningModeModal.planning-flow` under dashboard lane sharding (first sighting)

- **Superseded 2026-10-07:** the file is quarantined under archived entry 22.

- **File:** `packages/dashboard/app/components/__tests__/PlanningModeModal.planning-flow.test.tsx`
- **Exact tests:** a DIFFERENT case failed on each of two consecutive full-lane runs —
  `PlanningModeModal sequential flow > keeps the newer session when delayed duplicate reconciliation returns 'a durable question' on 'mobile'`, then
  `PlanningModeModal sequential flow > can refine a stopped initial plan into the first question`.
- **Owner:** unowned — first sighting for this file. Recorded rather than quarantined: the file carries 83 tests and quarantine is file-level.
- **Observed tree/SHA:** `c82e420ba0`, via the package's real command `pnpm --filter @fusion/dashboard test` (the `run-quality-tests.mjs` lane runner), lane `app:backfill-3` (`--project dashboard-app-quality-backfill --shard=3/4`), concurrency 2, 6144MiB heap per lane.
- **Observed frequency:** twice in two full-lane runs, each time a different case; passes 83/83 in isolation every time.

Verbatim observed failure (second run):

```
FAIL  |dashboard-app-quality-backfill| app/components/__tests__/PlanningModeModal.planning-flow.test.tsx > PlanningModeModal sequential flow > can refine a stopped initial plan into the first question
TestingLibraryElementError: Unable to find an element by: [data-testid="planning-plan-review"]
```

| run | result |
|---|---|
| lane runner, default (fail-fast), `c82e420ba0` | **failed** on the delayed-duplicate-reconciliation case |
| lane runner, `--all --no-fail-fast`, same tree | **failed** on the refine-stopped-plan case |
| isolated `vitest run <file>`, same tree, repeatedly | **passed** 83/83 |

The moving target plus a "cannot find element" shape points at render/settle timing under a loaded
shard, not a product defect — a wait that is adequate on an idle machine and not under four
concurrent 6GB lanes. No timeout was widened, no retry added, no assertion relaxed. A SECOND sighting
of the *same* case is an ordinary on-sight quarantine per the standing rule in AGENTS.md; because the
case moves, the honest rescue is a deterministic settle signal in this file's harness rather than a
longer wait.

---

## Entry: dashboard `api:backfill-*` lanes — PostgreSQL contention under lane concurrency (pattern, not a single test)

- **Files:** no fixed set. Across three consecutive full-lane runs on the same tree, a DIFFERENT file failed each time:
  - run 1: `app/components/__tests__/PlanningModeModal.planning-flow.test.tsx`
  - run 2: `src/__tests__/routes-branch-groups.test.ts`, `src/__tests__/routes-planning.test.ts`
  - run 3: `src/__tests__/register-signal-routes.test.ts`, `src/__tests__/server-view-preload.test.ts`
- **Command:** `pnpm --filter @fusion/dashboard test -- --all --no-fail-fast` (the `run-quality-tests.mjs` lane runner: 15 lanes, concurrency 2, 6144MiB heap per lane).
- **Observed tree/SHA:** `cc19584cc4`.
- **Every one passes in isolation**, including re-running the exact multi-file command that had just failed.

Failure shape in run 3 (`api:backfill-1`, `api:backfill-2`):

```
Error: Hook timed out in 15000ms.
fnlvl=warn [dashboard-github-tracking-reconciler] … pass failed (other passes still run): Failed query: select … from "project"."tasks" …
```

The hook timeout arrives alongside PostgreSQL `Failed query` warnings. Those warnings were FIRST READ
as proof of connection exhaustion; that reading was WRONG and is retracted here. The warnings come from
a background github-tracking reconciler still polling an already-torn-down store, i.e. noise that
follows the timeout rather than causing it. Measured 2026-08-23: a live `dashboard-api-quality-backfill`
lane peaked at **14 backend connections against `max_connections=100`**. There is no connection
shortage. Two attempts to act on the exhaustion theory were reverted — lowering the harness `poolMax`
from 5 to 2 took core's PostgreSQL suite from 1 failure to 11, matching FN-9131, where a shared
connection-budget primitive also made a loaded run worse.

This is suite infrastructure, not a defect in any of the five files above, and chasing the file that
happened to lose the race on a given run is whack-a-mole.

Scale for context: run 3 executed roughly 15,200 tests across 15 lanes and failed 2.

### Reproduction attempt 2026-08-23 — did NOT reproduce

Re-run on a quiet 28-core machine at `7e59494448`, after this session's 816 cross-package test failures
were fixed:

| Run | Result |
| --- | --- |
| `--group api` alone (3 lanes) | **passed** — 156 files, 1,437 tests, 0 hook timeouts, 0 gate degradations |
| full runner, all 15 lanes | **passed** — 23,584 tests, 0 hook timeouts, 0 gate degradations, 0 failed files |

Two candidate mechanisms were tested and NEITHER is supported by evidence:

1. **DDL admission saturation.** `pg-ddl-admission.ts` waits up to `acquireTimeoutMs` (default 10s),
   then degrades and runs the DDL anyway, against a 15s `hookTimeout` — mechanically enough to overrun.
   But both runs emitted **zero** `[pg-ddl-admission] degraded` warnings, so the gate never saturated.
   Unsupported; do not cite it as the cause without a run that actually shows the warning.
2. **CPU oversubscription.** The api group spends `import 191.63s` against `tests 45.01s`, and
   `hookTimeout` is wall-clock, so a starved worker overruns setup without any database involvement.
   This remains the leading candidate purely because it survives the disproofs above — the original
   sightings occurred while several agent subprocesses ran concurrently, and the clean 2026-08-23 runs
   had a quiet machine. It is UNPROVEN: no run has yet captured the failure with CPU pressure recorded.

**Next attempt should capture, at the moment of failure:** per-worker CPU wait, the gate's
`observe()` degradation counters, and which hook overran. Without those, any fix is a guess.

**Not quarantined deliberately, and nothing deleted.** Quarantine is file-level and the failing file
moves, so quarantining would evict healthy coverage without touching the cause. Deleting the files was
considered and rejected: they are 112 tests pinning FN-8823 (shared-branch-group merge boundaries),
FN-7438, FN-7611, FN-8341, and FN-8442, including an explicit guard against a hand-rolled
`promoteBranchGroup` mock. No timeout was widened, no retry added, and no assertion relaxed anywhere in
this investigation.

One genuinely structural failure WAS found and fixed rather than recorded here: the lane runner's own
self-tests spawned `pnpm --filter @fusion/dashboard test`, re-entering the suite from inside it. See
`cc19584cc4`.

---

## Entry: `executor-prompt` pause-resume agent-creation count (quarantined second sighting)

- **Status:** **Rescued 2026-10-08 by KB-048.** Root cause was a test-harness timing race, not a product race; the ledger row and engine-default exclusion were removed in lockstep and the file runs in engine-default again (not admitted to engine-core). Quarantined 2026-10-05 by FN-9510 under the deletion ratchet.
- **File:** `packages/engine/src/__tests__/executor-prompt.test.ts`
- **Exact test:** `TaskExecutor pause behavior > resumes unpaused in-progress task with no active session`
- **Observed trees/SHAs:** [run 33034719148](https://github.com/Runfusion/Fusion/actions/runs/33034719148) at `5769d5cd610e8830be24c4ede6eb79b38d2143c1`, and [run 37339500295](https://github.com/Runfusion/Fusion/actions/runs/37339500295) at `1a648d35d3987a6722b221e37df3084f75df6f0d`.
- **Observed frequency:** two shard/multi-file sightings. The first record's six-file arrangement and the current isolated file both passed locally; the current hosted shard failed with 564 reported engine results.

The second-sighting timing artifact [`11358593242`](https://github.com/Runfusion/Fusion/actions/runs/37339500295) reports the exact identity failed in 79.776822 ms at `executor-prompt.test.ts:1083:51` with `AssertionError: expected 0 to be greater than or equal to 2`. Post-merge artifact `11359244080` confirms it was the only failed engine identity in shard 2. The original assertion is retained unchanged; only routine engine-default discovery excludes the file.

| evidence | result |
|---|---|
| first sighting: six files in one command (`task-done-refusal-x-invariant`, `executor-workspace`, `executor-prompt`, `verify-worktree-invariants-missing`, `executor-workspace-config-propagation`, `executor-workspace-capture`) | **failed** — 1 failed / 147 passed |
| first sighting: `executor-prompt.test.ts` alone | **passed** (114/114) |
| FN-9510: current `executor-prompt.test.ts` alone | **passed** in 6.3s |
| FN-9510: documented six-file engine-default arrangement | **passed** in 8.6s |

The assertion counts `createFnAgent` calls after a resume and observed zero only in broad shard/multi-file execution. FN-9510 traced the production `task:updated` listener through its synchronous single-flight claim, pause/dependency admission, active session/graph re-check, resume log, and graph-owned execution handoff; no reachable resume invariant violation was found. No timeout was widened, no retry added, and no assertion relaxed. This is therefore a file-level quarantine rather than a product repair, with healthy coverage intentionally excluded until the 14-day deletion deadline.

**Resolution (KB-048, 2026-10-08).** The test fired the resume with a fire-and-forget `_trigger` and then slept a fixed 50 ms before counting agents. Delaying the resume chain's pause-label settings read past that window reproduces the exact hosted failure (`expected 0 to be greater than or equal to 2`, with no resume log written), and the test fails the same way when run alone on a cold worker. Full-file runs often passed vacuously: executors from earlier tests kept running (fire-and-forget `execute`, plus the in-place retry timers added by PR #32) and created agents inside later tests, while `settleLeakedBackgroundRuns` only polled `processWideGraphRouting` for 3 s and returned before a just-triggered listener had claimed an owner. The harness now tracks every store listener invocation, `dispatchUnpauseResume`, and `execute` of its executors. Tests await `_triggerAsync` plus the tracked work instead of sleeping, a file-wide `afterEach` drains it and cancels pending in-place retry timers, and the pause teardown asserts no process-wide owner leaked. Two regression scenarios (a slow resume-chain collaborator, and a fire-and-forget resume that must be fully drained) fail with the pre-fix sleep or poll. While excluded, the file had also drifted behind PR #32 (pause teardown now retries in place instead of moving to todo), so those fixtures were refreshed to state that contract. Verification: 117/117 five consecutive runs; the six-file arrangement passed three times under CPU oversubscription (24 busy loops, 16 workers).

---

## Entry: Windows Full Suite lane single sightings under runner load (KB-008, first sightings)

<!--
FNXC:TestFlakeRegister 2026-10-08-01:30:
KB-008 classified every unexpected Windows-lane failure across five consecutive Full Suite runs (9d216bec through 03cc07bb4). Deterministic failures were fixed at their root cause. The files below failed once each with load-shaped timeouts, retain substantial coverage, and pass in isolation on a Windows host, so they are recorded as first sightings rather than quarantined. Core PostgreSQL files cannot be quarantined inline under the gate-policy assertion.
-->

- **Status:** First sightings recorded 2026-10-08 by KB-008. A second sighting of any listed test follows normal escalation: an on-sight file-level quarantine, or an owner decision for a core PostgreSQL file.
- **Lane:** the Windows job of `full-suite.yml` (`windows-latest`, local PostgreSQL service), compared by `scripts/check-windows-known-failing.mjs`.

| file | exact test | sighting | failure |
|---|---|---|---|
| `packages/engine/src/__tests__/auth-storage-durability.test.ts` | `instance-scoped OAuth refresh > bounds a hanging refresh request instead of waiting on it indefinitely` | [run 37693147198](https://github.com/stjepanvrbic/Fusion/actions/runs/37693147198) at `9d216bec` | fetch mock still uncalled after its bounded 200-iteration poll |
| `packages/engine/src/__tests__/triage.test.ts` | `pause-abort status clearing (bug fix) > clears planning status to null on global pause (not a no-op)` | [run 37698750646](https://github.com/stjepanvrbic/Fusion/actions/runs/37698750646) at `0480b153` | 30s test timeout |
| `packages/engine/src/__tests__/hybrid-executor-multi-node-routing.test.ts` | `HybridExecutor multi-node routing > enables multi-node and initializes with node visibility` | [run 37702452940](https://github.com/stjepanvrbic/Fusion/actions/runs/37702452940) at `41950446` | 30s test timeout |
| `packages/core/src/__tests__/postgres/pg-harness-ddl-concurrency.pg.test.ts` | `harness DDL lifecycle (PostgreSQL) > creates distinct empty databases and removes every one` | [run 37702452940](https://github.com/stjepanvrbic/Fusion/actions/runs/37702452940) at `41950446` | 15s test timeout |
| `packages/core/src/__tests__/task-updated-lanes-emit-surfaces.test.ts` | `task:updated producer integration > delivers warm then cold metadata through TaskStore's direct emit producer` | [run 37702452940](https://github.com/stjepanvrbic/Fusion/actions/runs/37702452940) at `41950446` | 15s test timeout |

Each file passed in every other run of the five, and the engine files passed in a targeted run on a local Windows host at `c53017ac`.

**Already a second sighting, escalated rather than recorded:** `packages/core/src/__tests__/postgres/command-center-activity-durable-agents.pg.test.ts > durable agent Activity analytics > turns a production durable no-task heartbeat into Activity sessions and tool usage` failed with `expected 0 to be greater than 0` on `activity.sessions` in runs 37693147198 and 37702452940, and passed in the other three. Core PostgreSQL quarantine is policy-forbidden, so this goes to its owner for a decision. The zero-session read fits usage events landing after the aggregation, but that mechanism is unconfirmed.
