---
title: "Orphaned AI merge bodies need a durable-write authority fence"
date: 2026-08-09
problem_type: reliability
module: "@fusion/engine"
component: ai-merge
tags:
  - merge
  - cancellation
  - task-store
symptoms:
  - "an aborted merge body can outlive the bounded settle latch"
root_cause: "abort races reject the caller but cannot forcibly stop an already-running merge body"
resolution_type: investigation
---

## Mechanism

`ProjectEngine.awaitPriorMergeBodySettle()` bounds how long the merge lane waits. A body that ignores a cooperative abort may still run after that wait while a successor owns a fresh signal. FN-8912 correctly fences `writeTransientMergeStatus`: an aborted signal resolves without calling `updateTask`. It intentionally did not fence diagnostics or finalization.

This FN-8923 inventory is complete **only over the pinned closure and pinned writer surface with declared boundaries**. It does not claim coverage of the whole engine. No UI affordance is involved. Orphan log writes can refresh `updatedAt`, affecting age-based recovery; that recovery-policy question remains FN-8924.

## Derived writer surface and closure

The shared TypeScript-AST helper reads `packages/core/src/store.ts` and extracts the public `TaskStore` surface. Its durable surface includes every classified state-mutating method — including attachment, archive, atomic-update, task/workflow creation, deletion, recovery, lifecycle, and upsert operations — rather than only the methods currently seen in merge code. The complete method-by-method writer/non-writer classification (with reasons) is pinned as `writerSurfaceClassification` in `merge-orphan-durable-write-inventory.json` and compared to the AST result by the drift guard; an unclassified public method fails the guard. `markTaskWedgeNotificationPending` and `clearTaskWedgeNotificationPending` are writers because they respectively persist and remove deferred `wedgeNotification.pending` evidence through `updateTaskAtomic`. Module-level writers `finalizeProvenAutoMergeTask` and `syncGroupPrOnLanding` are explicit extras.

The walked closure is the sorted `scannedModules` list in the checked-in manifest. It is derived by following first-party emitted `.js` imports back to their TypeScript source, and currently includes 343 modules, including `packages/engine/src/merge/auto-merge-finalization.ts`, `packages/engine/src/merge/post-merge-gate-reseed.ts`, `packages/engine/src/merge/push-after-merge-policy.ts`, `packages/engine/src/worktree/workspace-base-refresh.ts`, and the run-audit/branch-group helpers. There are no declared closure boundaries: the walk runs to fixpoint. Task-store receivers are recognised from the reviewed, pinned `TASK_STORE_RECEIVER_SHAPES` table (normalised receiver text: `store`, `options.store`, `deps.store`, `this.store`, `ctx.store`, `input.store`, `opts.store`, `params.store`, `this.taskStore`, `taskStore`, `this.options.taskStore`, `deps.taskStore`, `callbackStore`) plus single-assignment `const`/`let` aliases of any recognised shape (for example `maybeStore`, `conditionalMoveStore`, `landingRecorder`); computed or destructured access becomes a fail-closed suspect. Receivers proven not to be a TaskStore in front of a writer-named method (in-process `this.emit`, `stuckDetector.recordActivity`, `extensionRunner.emit`, `this.options.prMonitor.updatePrInfo`, the fence's own `recorder`, injected `deps.moveTask` and `this.options` callbacks) are listed per module in `NON_TASK_STORE_RECEIVERS`, so a new module re-surfaces for review. Any other receiver in front of a writer-named method is a suspect with reason `unreviewed task-store receiver shape <shape>`, and a non-store entry that is no longer observed is stale; `deriveReceiverCensus()` reports both and the drift guard requires both lists to be empty. Legacy shapes (`store`, `options.store`, `deps.store` and their aliases) keep the `store.<method>` writer label so pre-existing ids stay byte-stable; newly recognised shapes use `<shape>.<method>`, and ordinals are counted per `path::writer` key.

## Reconciled frontier

<!--
FNXC:MergeReliability 2026-09-01-04:31:
FN-9221 re-synchronizes this inventory after the import closure gained new modules and durable writes.
Fence-wrapped workspace-finalization logs are backed by their local MergeWriteFence call, while the explicit no-fence branches remain unresolved under FN-8958; newly reached base-refresh writes have no call edge from the merge entry points and remain out of frontier.

FNXC:MergeReliability 2026-09-25-10:56:
FN-9397 reconciles the closure after triage imports the graph executor for held-planning cooldowns. Closure membership is not orphan-frontier reachability: all 22 graph/admission/IR-pin writes are entered only by independent task execution, with no call edge from `runAiMerge`, `landWorkspaceTask`, or `landOneRepo`.

FNXC:MergeReliability 2026-10-01-22:44:
FN-9446 reconciles the finalization-owned post-merge gate reseed. Its continuation insert is guarded by the captured task update timestamp and workflow selection, and merge finalization wraps the reseed in its finalization fence; its subsequent log follows only that accepted claim. The two call sites are therefore checkpoint-covered, not pending or an invented out-of-frontier exclusion.

FNXC:MergeReliability 2026-10-07-13:37:
KB-005 reconciles the four durable logs KB-003 added: the post-merge input-wait log and the two `reacquireLandedPostMergeCheckout` logs in `runGraphCustomNode`, plus the desktop-artifact cleanup log in `acquireTaskWorktree`. All four are `out-of-frontier`: no merge-module code reaches `runGraphCustomNode`, and `acquireTaskWorktree` is called only by the soft-deprecated legacy `aiMergeTask`, so neither function has a call edge from `runAiMerge`, `landWorkspaceTask`, or `landOneRepo`. Every row in both modules is out of frontier, so verdicts carried forward by id stay true after the KB-003 ordinal shifts.

FNXC:MergeReliability 2026-10-08-06:03:
KB-047 closes the receiver blind spot: the scanner previously recognised only `store`, `options.store`, `deps.store` and their aliases, so 473 writer calls behind other receivers (most through `this.store`, including the 13 wedge-notification writes in `notification-service.ts`) had no row or verdict. The reviewed receiver tables add `this.store`, `ctx.store`, `input.store`, `opts.store`, `params.store`, `this.taskStore`, `taskStore`, `this.options.taskStore`, `deps.taskStore` and `callbackStore`; the 439 pre-existing rows keep byte-identical ids, fingerprints and verdicts.
Of the 473 new rows, 461 are `out-of-frontier` (self-healing, triage, scheduler, heartbeat, notification event-listener, healing, scheduling, missions, runtime and legacy `aiMergeTask` paths). The 12 frontier rows are `already-fenced` for the post-landing `clearWorktreePointer` update and the tenancy fence-ref record; `benign-unfenced` append-only bookkeeping for the three post-landing cleanup logs, the squash file-scope agent log, the workspace base-branch decision log, the three agent-logger flushes and the agent-usage session-start event; and `unresolved` under FN-8958 for the `enforceAiMergeSquashGates` `params.store.updateTask`. No production module was edited.
-->

<!--
FNXC:MergeReliability 2026-09-25-10:56:
The structural reconciler owns module and call-site discovery, while reviewers own lifecycle verdicts. A newly derived writer receives a deterministic pending classification; a new merger call edge to an existing entry requires reviewers to revisit its out-of-frontier verdict rather than treating closure membership as proof.
-->

The manifest is final and keyed by AST-derived call-site id and argument-shape fingerprint. It contains 912 derived call sites across the 343-module pinned closure: 831 scanned-but-off-path rows are explicitly `out-of-frontier`, including the 22 graph-execution, admission, and IR-pin writes exposed by the held-planning import path, the four KB-003 post-merge re-acquisition and acquisition logs, and the 461 off-path rows surfaced by the KB-047 receiver tables. Of the 81 frontier rows, 58 are `already-fenced`, 17 are `benign-unfenced`, and 6 remain `unresolved`. This includes the transient-status leaf, locally fence-wrapped workspace-finalization logs, and the checkpointed post-merge gate reseed. Unresolved direct-body surfaces remain explicitly unresolved because the real exported body cannot yet isolate every call site without test-only production exports. Each `must-be-fenced` or unresolved surface needs the follow-up below.

| call site | writer | Axis 1 | final | Layer B evidence | proof | follow-up |
| --- | --- | --- | --- | --- | --- | --- |
| `packages/engine/src/merge/merger-ai.ts::finalizeMerged::store.recordRunAuditEvent::#1` | `store.recordRunAuditEvent` | indeterminate | unresolved | unobservable:production-body harness cannot isolate this call site without a test-only export | none:production-body harness cannot isolate this call site without a test-only export | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::finalizeMerged::store.recordBranchGroupMemberLanded::#1` | `store.recordBranchGroupMemberLanded` | checkpoint-gap | must-be-fenced | layerB-observed | positive-observation | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::finalizeMerged::store.updateTask::#1` | `store.updateTask` | checkpoint-gap | must-be-fenced | layerB-observed | positive-observation | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::finalizeMerged::store.updateTask::#2` | `store.updateTask` | indeterminate | unresolved | unobservable:production-body harness cannot isolate this call site without a test-only export | none:production-body harness cannot isolate this call site without a test-only export | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::finalizeMerged::store.updateTask::#3` | `store.updateTask` | indeterminate | unresolved | unobservable:production-body harness cannot isolate this call site without a test-only export | none:production-body harness cannot isolate this call site without a test-only export | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::finalizeMerged::store.upsertTaskCommitAssociation::#1` | `store.upsertTaskCommitAssociation` | indeterminate | unresolved | unobservable:production-body harness cannot isolate this call site without a test-only export | none:production-body harness cannot isolate this call site without a test-only export | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::finalizeTask::store.emit::#1` | `store.emit` | checkpoint-gap | must-be-fenced | layerB-observed | positive-observation | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::finalizeWorkspaceTask::store.logEntry::#1` | `store.logEntry` | checkpoint-covered | already-fenced | layerB-observed | static:per-call-site merge write fence or ownership checkpoint | none:no-follow-up-required |
| `packages/engine/src/merge/merger-ai.ts::finalizeWorkspaceTask::store.logEntry::#2` | `store.logEntry` | indeterminate | unresolved | unobservable:production-body harness cannot isolate this call site without a test-only export | none:production-body harness cannot isolate this call site without a test-only export | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::finalizeWorkspaceTask::store.logEntry::#3` | `store.logEntry` | checkpoint-covered | already-fenced | layerB-observed | static:per-call-site merge write fence or ownership checkpoint | none:no-follow-up-required |
| `packages/engine/src/merge/merger-ai.ts::finalizeWorkspaceTask::store.logEntry::#4` | `store.logEntry` | indeterminate | unresolved | unobservable:production-body harness cannot isolate this call site without a test-only export | none:production-body harness cannot isolate this call site without a test-only export | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::finalizeWorkspaceTask>cleanup::store.logEntry::#1` | `store.logEntry` | checkpoint-covered | already-fenced | layerB-observed | static:per-call-site merge write fence or ownership checkpoint | none:no-follow-up-required |
| `packages/engine/src/merge/merger-ai.ts::finalizeWorkspaceTask>cleanup::store.logEntry::#2` | `store.logEntry` | indeterminate | unresolved | unobservable:production-body harness cannot isolate this call site without a test-only export | none:production-body harness cannot isolate this call site without a test-only export | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::finalizeWorkspaceTask::store.updateTask::#1` | `store.updateTask` | checkpoint-covered | already-fenced | layerB-observed | static:per-call-site merge write fence or ownership checkpoint | none:no-follow-up-required |
| `packages/engine/src/merge/merger-ai.ts::landWorkspaceTask::store.logEntry::#1` | `store.logEntry` | indeterminate | unresolved | unobservable:production-body harness cannot isolate this call site without a test-only export | none:production-body harness cannot isolate this call site without a test-only export | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::landWorkspaceTask::store.moveTask::#1` | `store.moveTask` | indeterminate | unresolved | unobservable:production-body harness cannot isolate this call site without a test-only export | none:production-body harness cannot isolate this call site without a test-only export | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::landWorkspaceTask::store.updateTask::#1` | `store.updateTask` | indeterminate | unresolved | unobservable:production-body harness cannot isolate this call site without a test-only export | none:production-body harness cannot isolate this call site without a test-only export | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::landWorkspaceTask>log::store.appendAgentLog::#1` | `store.appendAgentLog` | indeterminate | unresolved | unobservable:production-body harness cannot isolate this call site without a test-only export | none:production-body harness cannot isolate this call site without a test-only export | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::landWorkspaceTask>log::store.logEntry::#1` | `store.logEntry` | indeterminate | unresolved | unobservable:production-body harness cannot isolate this call site without a test-only export | none:production-body harness cannot isolate this call site without a test-only export | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::persistRepoLandedSha::store.updateTask::#1` | `store.updateTask` | indeterminate | unresolved | unobservable:production-body harness cannot isolate this call site without a test-only export | none:production-body harness cannot isolate this call site without a test-only export | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::pushAfterMergeToRemote>recordRecoveryBranch::store.logEntry::#1` | `store.logEntry` | indeterminate | unresolved | unobservable:production-body harness cannot isolate this call site without a test-only export | none:production-body harness cannot isolate this call site without a test-only export | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::runAiMerge::store.logEntry::#1` | `store.logEntry` | indeterminate | unresolved | unobservable:production-body harness cannot isolate this call site without a test-only export | none:production-body harness cannot isolate this call site without a test-only export | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::runAiMerge::store.logEntry::#2` | `store.logEntry` | indeterminate | unresolved | unobservable:production-body harness cannot isolate this call site without a test-only export | none:production-body harness cannot isolate this call site without a test-only export | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::runAiMerge::store.logEntry::#3` | `store.logEntry` | indeterminate | unresolved | unobservable:production-body harness cannot isolate this call site without a test-only export | none:production-body harness cannot isolate this call site without a test-only export | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::runAiMerge::store.moveTask::#1` | `store.moveTask` | indeterminate | unresolved | unobservable:production-body harness cannot isolate this call site without a test-only export | none:production-body harness cannot isolate this call site without a test-only export | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::runAiMerge::store.moveTask::#2` | `store.moveTask` | indeterminate | unresolved | unobservable:production-body harness cannot isolate this call site without a test-only export | none:production-body harness cannot isolate this call site without a test-only export | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::runAiMerge::store.moveTask::#3` | `store.moveTask` | indeterminate | unresolved | unobservable:production-body harness cannot isolate this call site without a test-only export | none:production-body harness cannot isolate this call site without a test-only export | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::runAiMerge::store.updateTask::#1` | `store.updateTask` | indeterminate | unresolved | unobservable:production-body harness cannot isolate this call site without a test-only export | none:production-body harness cannot isolate this call site without a test-only export | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::runAiMerge::store.updateTask::#2` | `store.updateTask` | indeterminate | unresolved | unobservable:production-body harness cannot isolate this call site without a test-only export | none:production-body harness cannot isolate this call site without a test-only export | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::runAiMerge::store.updateTask::#3` | `store.updateTask` | indeterminate | unresolved | unobservable:production-body harness cannot isolate this call site without a test-only export | none:production-body harness cannot isolate this call site without a test-only export | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::runAiMerge>log::store.appendAgentLog::#1` | `store.appendAgentLog` | checkpoint-gap | must-be-fenced | layerB-observed | positive-observation | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::runAiMerge>log::store.logEntry::#1` | `store.logEntry` | checkpoint-gap | must-be-fenced | layerB-observed | positive-observation | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::runPushAfterMergeStep::store.logEntry::#1` | `store.logEntry` | indeterminate | unresolved | unobservable:production-body harness cannot isolate this call site without a test-only export | none:production-body harness cannot isolate this call site without a test-only export | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::runPushAfterMergeStep::store.logEntry::#2` | `store.logEntry` | indeterminate | unresolved | unobservable:production-body harness cannot isolate this call site without a test-only export | none:production-body harness cannot isolate this call site without a test-only export | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::runPushAfterMergeStep::store.logEntry::#3` | `store.logEntry` | indeterminate | unresolved | unobservable:production-body harness cannot isolate this call site without a test-only export | none:production-body harness cannot isolate this call site without a test-only export | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::runPushAfterMergeStep::store.updateTask::#1` | `store.updateTask` | indeterminate | unresolved | unobservable:production-body harness cannot isolate this call site without a test-only export | none:production-body harness cannot isolate this call site without a test-only export | FN-8958 |
| `packages/engine/src/merge/merger-ai.ts::writeTransientMergeStatus::store.updateTask::#1` | `store.updateTask` | checkpoint-covered | already-fenced | layerB-observed | direct exported `writeTransientMergeStatus` invocation | none:no-follow-up-required |

The real-tail fixture additionally observes `packages/engine/src/merge/auto-merge-finalization.ts::finalizeProvenAutoMergeTask::store.updateTask::#2`, `packages/engine/src/merge/auto-merge-finalization.ts::finalizeProvenAutoMergeTask>moved::store.moveTask::#1`, and `packages/engine/src/merge/merger-ai.ts::finalizeTask>finalization::finalizeProvenAutoMergeTask::#1` as `checkpoint-gap / must-be-fenced / layerB-observed / positive-observation`; all are assigned to FN-8958.

The complete machine-readable table is `packages/engine/src/__tests__/fixtures/merge-orphan-durable-write-inventory.json`; this document lists the direct merger-body subset for navigation. No negative deep-body observation is treated as evidence without a witness.

## Out-of-frontier rows

The import closure intentionally includes modules pulled in by the legacy `aiMergeTask` pipeline and other independently owned engine subsystems. Their durable calls are retained in the manifest ratchet, but they have no call edge from `runAiMerge`, `landWorkspaceTask`, or `landOneRepo`; they are classified with the required `out-of-frontier` five-tuple rather than invented as unresolved orphan writes. This currently accounts for 359 entries, including all `packages/engine/src/merger.ts` legacy-pipeline writes, the `refreshReusedWorktreeBase>persistBaseSha` update, workspace base-refresh persistence and skipped-refresh logging, and the 22 `executeWorkflowGraph`/admission/IR-pin rows exposed by the triage held-planning import. The remaining 59 entries are the direct merger-body modules (`merger-ai.ts`, `auto-merge-finalization.ts`, `post-merge-gate-reseed.ts`, and the `createRunAuditor` surface); each remains in the frontier and is separately classified in the manifest.

## Characterization and competing generations

Layer A pins the essential condition: an orphan signal remains aborted while a successor has a distinct live signal. Layer B directly drives the real exported `writeTransientMergeStatus` leaf and proves its no-write behavior with direct-entry execution proof. Crucially, its real `runAiMerge` fixtures abort from the clean-room review, the post-CAS integration-ref audit, and the `mergeDetails` persistence seam: the same aborted body then positively writes `mergeDetails`, moves to the complete column, emits `task:merged`, appends merger logs, and records shared branch-group landing. Those writes are attributed from the recorder slice taken at abort and are `must-be-fenced`, not speculative risks. The attempted data states are pre-land, clean-room review, post-ref advance, post-merge-details, and workspace partial land; unisolatable deep rows are explicitly unresolved, not covered by a pre-aborted fixture.

The workspace fixture now lands `repo-a`, aborts from the real second-repository merge seam, and partitions recorder rows by generation while a distinct non-aborted successor signal performs its production status write. This proves the partial-land boundary is reached after a durable first-repo `landedSha` write, rather than aborting before the loop. The principal hazard is a stale body moving/finalizing the same task or refreshing its durable activity while the successor owns the task. Logs are not pre-classified benign: their `updatedAt` consequence is evidence for FN-8924.

## Regenerating the manifest

Use the explicit opt-in command:

```sh
FUSION_UPDATE_MERGE_INVENTORY=1 pnpm --filter @fusion/engine exec vitest run src/__tests__/merge-orphan-durable-write-inventory-drift.test.ts
```

Regeneration overwrites only derivable structure: writer surface and classification, reachable module closure, call-site identity/fingerprint/location/writer/ordinal. It carries human judgement fields — lifecycle axes, evidence, observation, execution proof, ownership/data-state context, and follow-up — only when an exact `callSiteId` already exists. Removed call sites disappear. A newly derived call site receives `pending:classify`, which the guard deliberately rejects; reviewers must classify it before the inventory can be green. Regeneration also refuses unclassified TaskStore methods or unresolved receivers.

## Ratchet contract and enforcement

`_merge-durable-write-callsites.ts` is the sole derivation for manifest and guard. It pins closure, boundaries, writer source/surface, unique call-site ids, and fingerprints. The guard checks a bijection and fails closed on aliases it cannot prove. The final lifecycle requires real task ids for unresolved rows/boundaries and documented null markers for other dispositions.

The guard is not in the curated blocking `engine-core` merge gate. It runs when engine affected tests are selected by root `pnpm test`, and in the non-blocking full-suite push lane. It must not be described as a merge-blocking CI gate.

## Recommendation

Use a hybrid in FN-8958: retain cheap cooperative checkpoints around long git/agent awaits, but add generation authority to lifecycle-mutating durable writes (`updateTask`, `moveTask`, commit association, audit/finalization and `task:merged`). A generation guard protects future writes uniformly where a checkpoint cannot stop an already-resolved await. Decide `logEntry`/`appendAgentLog` separately with the recovery evidence; do not fence it speculatively.

A checkpoint-only fix is local but has gaps after unabortable awaits. A generation-only design is broader machinery. The hybrid gives lifecycle writes ownership protection while retaining responsive cancellation.
