---
title: Full Suite run 38171508610 engine shard disposition
date: 2026-10-12
category: test-failures
---

# Full Suite run 38171508610: engine failures in Test shard 1/4 and 2/4

## Source evidence

- Full Suite push run `38171508610` (run number 143), head `18fb7f0f456e11d1cbd2afdeca2c9ccc5e0752c5`.
- Test shard 1/4, job `114564906023`, conclusion `failure`. Test shard 2/4, job `114564905989`, conclusion `failure`. Shard 3/4, shard 4/4 and the Pipeline smoke tier concluded `success`.
- Artifact `post-merge-full-suite-evidence`, ID `11715001909`, and the two job logs.
- The previous Full Suite run was run 142 at `28e7c1244`. None of the 26 cases failed there. All four introducing commits below are ancestors of `18fb7f0f4` and not of `28e7c1244`.

The run, job and artifact identifiers, the shard conclusions, the run-142 comparison and the 348-against-350 module count come from the report that opened this work; the artifact and logs were not downloaded again. Two mechanism details were established when the fix was planned and not re-run afterwards: that a three-field answer in cause 3 is rejected for an unknown commit time, and that the cause 2 imports were the only value imports of the module inside the merge closure. Everything else below was observed on this branch.

All 26 failing cases are in `@fusion/engine`, project `engine-default`. None of them is a flake: each fails the same way on every run until its fixture is corrected, so the flake register and the quarantine ledger do not apply.

## Disposition by cause

| # | Cases | Files | Introduced by | Resolution |
| --- | ---: | --- | --- | --- |
| 1 | 17 | `review-inline-fix-fingerprint-recapture.real-git.test.ts` (11), `run-audit-sink-health-review-recapture.test.ts` (6) | `2917f8f29` "Run Anthropic sessions through the Claude CLI with in-place rate-limit retries (#74)" | Fixture corrected |
| 2 | 4 | `merge-orphan-durable-write-inventory-drift.test.ts` | `32f5f07ed` (KB-136) | Already fixed on main by `31f1e05b0` (KB-115) |
| 3 | 1 | `merger-merge-details.test.ts` | `d161e06c2` (KB-112) | Fixture corrected, one rejection case added |
| 4 | 4 | `self-healing-orphan-only-scope.test.ts` | `f96333ec2` (KB-114) | Fixture corrected |

No product source changed. Every timeout, retry setting and existing assertion in the five edited test files is unchanged.

### Cause 1: review-step deps bags lacked the workflow-graph abort-controller map

`2917f8f29` added the required field `activeWorkflowGraphAbortControllers` to `ExecuteWorkflowStepDeps` and reads it in `runOnce` (`packages/engine/src/executor/execute-workflow-step.ts`) when a reviewer session is opened:

```text
deps.activeWorkflowGraphAbortControllers.get(task.id)?.signal
```

`TaskExecutor` builds its own bag and carries the map. Three test files hand-roll the bag for the free `executeWorkflowStep` function, and none of them carried it, so the read threw `TypeError: Cannot read properties of undefined (reading 'get')`.

The three sink-health timeouts ("pending", "late-resolve" and "late-reject" audit sinks) are the same defect, not a second one. In those three modes the test helper `throughBoundedAudit` waits for the audit sink to be called before it looks at the promise returned by the step. The step threw before it reached the audit emit, so the sink was never called and the case waited until the 30 s test timeout. The "absent", "throws" and "rejects" modes skip that wait and reported the `TypeError` directly. With the map present all six pass.

Resolution: `activeWorkflowGraphAbortControllers: new Map()` added to all four hand-rolled bags. The fourth, `executeDeps()` in `review-input-proof-fail-closed.test.ts`, did not fail, because its two direct calls return before a reviewer session is created. It had the same gap against its declared `ExecuteWorkflowStepDeps` type.

### Cause 2: the merge closure no longer contains the step-session executor

`32f5f07ed` replaced `import { extractSection } from "../execution/step-session-executor.js"` in `spec-validation/external-integration-evidence.ts` and `spec-validation/task-document-references.ts` with `extractPlanSectionWithHeading` from `@fusion/core`. Those were the only modules in the merge closure that imported `step-session-executor.ts` by value, so it and `resolve-activity-run-agent-id.ts` left the closure (348 derived modules against 350 pinned). The change is intended: plan-section extraction moved to core.

`31f1e05b0` landed after the failing run's head and removed the 59 stale fixture lines and the stale `step-session-executor.ts::stuckTaskDetector` receiver entry. The drift guard passes 13/13 without the update flag, and neither `fixtures/merge-orphan-durable-write-inventory.json` nor `_merge-durable-write-callsites.ts` mentions either module. No edit was made for this cause.

### Cause 3: the landed-commit fixture answered the old single-commit read

`d161e06c2` changed the stored-commit read in `findOwnedLandedCommitForTask` (`packages/engine/src/merge/merger-owned-landed.ts`) from `git log -1 --format=%H%x1f%s%x1f%b <sha>` to `--format=%H%x1f%s%x1f%ct%x1f%b`, and made acceptance depend on a provenance verdict that uses the committer time. The fixture's mock was keyed on the old format string, so the read returned nothing, no commit was found, and `result.merged` was `false`.

Changing only the key is not enough. A three-field answer puts the commit body in the committer-time slot, and the verdict then rejects the commit because its time is unknown.

Resolution: the fixture pins the task's creation time and answers the read with four fields, the third being a committer time one hour after creation. A sibling case uses the same fixture with a committer time 48 hours before creation, which is outside the 24-hour skew allowance, and asserts that the commit is not treated as the task's landing: `result.merged` is `false`, no `task:merged` event is emitted, no `mergeDetails` update is written, and the task is not moved. The pair shows the fixture exercises the ownership rule and does not pass for an unrelated reason.

### Cause 4: the orphan-only scope fixture never answered argv git launches

The original lead pointed at the landed-commit provenance change (`d161e06c2`). That was wrong. `recoverOrphanOnlyScopeViolations` calls `findAlreadyMergedTaskCommit` (`packages/engine/src/merge/already-merged-detector.ts`), not `findLandedTaskCommit`. `f96333ec2` moved that detector's single git commands from a shell string to callback-form `execFile("git", argv, options, callback)`. The test file's `node:child_process` mock returned `execFile: vi.fn()`, which never calls back, so the first git read never settled and four cases ran into the 30 s timeout.

Resolution: the mock's `execFile` now joins `[file, ...args]` into a command string and routes it through the file's existing `exec` mock, in the shape `self-healing.test.ts` already uses. The existing command-string answers decide every result, and none of them changed.

## Run summaries

Command, run unchanged before and after from the repository root:

```text
pnpm --filter @fusion/engine exec vitest run src/__tests__/review-inline-fix-fingerprint-recapture.real-git.test.ts src/__tests__/run-audit-sink-health-review-recapture.test.ts src/__tests__/review-input-proof-fail-closed.test.ts src/__tests__/merge-orphan-durable-write-inventory-drift.test.ts src/__tests__/merger-merge-details.test.ts src/__tests__/self-healing-orphan-only-scope.test.ts --project=engine-default --silent=passed-only --reporter=dot
```

| File | Before (`849590e98`) | After |
| --- | --- | --- |
| `review-inline-fix-fingerprint-recapture.real-git.test.ts` | 1 passed, 11 failed | 12 passed |
| `run-audit-sink-health-review-recapture.test.ts` | 6 passed, 6 failed | 12 passed |
| `review-input-proof-fail-closed.test.ts` | 18 passed | 18 passed |
| `merge-orphan-durable-write-inventory-drift.test.ts` | 13 passed | 13 passed |
| `merger-merge-details.test.ts` | 26 passed, 1 failed | 28 passed |
| `self-healing-orphan-only-scope.test.ts` | 5 passed, 4 failed | 9 passed |
| Total | 69 passed, 22 failed (91) | 92 passed (92) |

Comparing the two JSON reports case by case: 22 cases moved from failing to passing, none still fails, none that passed before fails now, and the one added case passes. With the four inventory cases that `31f1e05b0` had already repaired, that accounts for all 26.

These runs were made on a Windows development host. The failures were recorded on the Linux Full Suite shards; the fixtures involved use mocked commands or plain `git` with no shell-specific syntax. The Full Suite push run on main that follows this change is the Linux confirmation.

## Prevention

1. **A process mock must call back for every launch form production uses.** A `node:child_process` mock whose `execFile` is a bare `vi.fn()` turns any production move from a shell string to an argument list into a hang, and the hang is reported as a timeout far from its cause. Route `execFile` through the same answers as `exec`. Of the six self-healing and reliability test files with the same inert mock that were identified when this work was planned, `849590e98` (KB-121) has since replaced four; `self-healing-stale-merger-status.test.ts` and `reliability-interactions/soft-delete-in-flight-abort.test.ts` still have it. Both pass on this branch (11 of 11 cases), so nothing they wait on launches git that way today. Across `packages/engine/src/__tests__`, fifteen files declare `execFile: vi.fn()` in a `node:child_process` mock; whether each of the other thirteen programs it per test was not checked here.
2. **A hand-rolled deps bag must carry every required field of its type.** Engine test files are excluded from `packages/engine/tsconfig.json`, so the compiler does not report a missing field, and an `as any` cast would hide it even if it did. When a required field is added to a deps interface, search the tests for object literals of that shape.
3. **A helper that waits for a side effect before observing the result hides the real error.** `throughBoundedAudit` reported a `TypeError` as a 30 s timeout in three of its six modes, which made one defect look like two.
