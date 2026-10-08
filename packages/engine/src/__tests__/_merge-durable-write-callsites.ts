/*
FNXC:MergeReliability 2026-08-09-12:00:
FN-8923 inventories durable writes over the pinned merge-module closure and the task-store
surface. This deliberately uses TypeScript AST nodes: textual scans cannot distinguish a call
from a comment or retain an enclosing closure when formatting changes.

The alias rule is deliberately narrow. A single-assignment local initialized from `store` or
`options.store` is a provable task-store alias; computed and destructured receivers fail closed
as suspects rather than being silently omitted from the frontier.

FNXC:MergeDurableWriteInventory 2026-10-08-05:21:
KB-047 superseded the `store`/`options.store`-only receiver rule. Receivers come from the reviewed
`TASK_STORE_RECEIVER_SHAPES` and per-module `NON_TASK_STORE_RECEIVERS` tables, aliases of any recognised shape
stay provable, and any other receiver in front of a writer-named method fails closed as an unreviewed suspect.
Legacy shapes keep the `store.<method>` writer label so pre-KB-047 call-site ids never change.
*/
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(__dirname, "../../../..");
const STORE_SOURCE = "packages/core/src/store.ts";
const ENTRY = "packages/engine/src/merge/merger-ai.ts";

/** These imports cross independently-owned subsystem boundaries; their internal writes are not
 * merge-body call sites. They remain explicit, pinned boundaries rather than an implicit cap. */
// FN-8923 walks the required finalization module. Boundaries are reserved for a genuinely
// structural edge that cannot be scanned; none is currently declared.
export const CLOSURE_BOUNDARY: readonly { module: string; reason: string }[] = [];

/** Module-level persistence helpers are not TaskStore methods. */
export const EXTRA_WRITERS = ["finalizeProvenAutoMergeTask", "syncGroupPrOnLanding"] as const;

/** Names which can look like extra writers but are local event callbacks, never TaskStore writes. */
const NOT_A_DURABLE_WRITE: Record<string, string> = {
  emit: "local merge strategy callback, not TaskStore.emit",
  checkAndRecordUnplannedExecutionBlock: "module helper call; its TaskStore write is scanned at the helper implementation rather than at this forwarding call",
};

export type SurfaceClassification = { method: string; kind: "writer" | "non-writer"; reason: string };
export type DerivedCallSite = { callSiteId: string; callSiteFingerprint: string; file: string; enclosingSymbolPath: string; writer: string; ordinal: number; lineHint: number };
export type Suspect = { file: string; line: number; text: string; reason: string };

function source(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function repo(path: string): string { return relative(ROOT, path).replaceAll("\\", "/"); }
function resolveRelative(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  // TypeScript source conventionally imports emitted `.js` paths. Resolve that emitted suffix
  // back to the authored TypeScript module before probing candidates.
  const sourceBase = base.replace(/\.(?:m?js|cjs)$/, "");
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), `${sourceBase}.ts`, `${sourceBase}.tsx`, join(sourceBase, "index.ts")]) if (existsSync(candidate)) return candidate;
  return undefined;
}

/**
 * FNXC:MergeReliability 2026-08-10-20:22:
 * The durable surface is not a second hand-maintained writer list. This single classification
 * map is checked against every AST-extracted public TaskStore member; a new member is
 * unclassified until its durable-write semantics are reviewed here.
 */
const STORE_METHOD_CLASSIFICATION: Record<string, Omit<SurfaceClassification, "method">> = {
  // FN-8923: These are public TaskStore operations that persist, mutate, or announce task-scoped state.
  // They must remain writers even when no current merge path calls them, or a future merge call would evade the frontier.
  _createTaskInternal: { kind: "writer", reason: "persists or mutates TaskStore state" },
  _createTaskInternalBackend: { kind: "writer", reason: "persists or mutates TaskStore state" },
  _maybeAutoArchiveSameAgentDuplicate: { kind: "writer", reason: "persists or mutates TaskStore state" },
  _maybeAutoArchiveSameAgentDuplicateBackend: { kind: "writer", reason: "persists or mutates TaskStore state" },
  addAttachment: { kind: "writer", reason: "persists or mutates TaskStore state" },
  addComment: { kind: "writer", reason: "persists or mutates TaskStore state" },
  addPrInfo: { kind: "writer", reason: "persists or mutates TaskStore state" },
  addSteeringComment: { kind: "writer", reason: "persists or mutates TaskStore state" },
  addTaskComment: { kind: "writer", reason: "persists or mutates TaskStore state" },
  appendAgentLogBatch: { kind: "writer", reason: "persists or mutates TaskStore state" },
  /*
  FNXC:MergeReliability 2026-08-11-21:57:
  Deferred wedge-notification evidence belongs to the task row. These methods persist or remove
  `wedgeNotification.pending` through `updateTaskAtomic`, so an orphaned merge body reaching either
  method would mutate state it no longer owns; classify by that durable semantic, not current callers.

  FNXC:MergeReliability 2026-10-07-22:23:
  Delivery acknowledgement clears the owed marker and stamps the per-reason cooldown through `updateTaskAtomic`, so it is a writer of the same task-row evidence.
  */
  acknowledgeTaskWedgeNotificationDelivery: { kind: "writer", reason: "clears owed wedge-notification delivery and persists the per-reason cooldown on the task row" },
  clearTaskWedgeNotificationPending: { kind: "writer", reason: "removes deferred wedge-notification evidence from the task row" },
  markTaskWedgeNotificationPending: { kind: "writer", reason: "persists deferred wedge-notification evidence on the task row" },
  appendCurrentPlanEvidence: { kind: "writer", reason: "persists or mutates TaskStore state" },
  appendSpecDriftReport: { kind: "writer", reason: "persists or mutates TaskStore state" },
  appendSpecDriftReportWhilePlanningLocked: { kind: "writer", reason: "persists or mutates TaskStore state" },
  appendSpecLock: { kind: "writer", reason: "persists or mutates TaskStore state" },
  applyBuiltInPromptOverridesAsync: { kind: "writer", reason: "persists or mutates TaskStore state" },
  applyBuiltInPromptOverridesSync: { kind: "writer", reason: "persists or mutates TaskStore state" },
  applyLegacyWorkflowStepOverrides: { kind: "writer", reason: "persists or mutates TaskStore state" },
  applyTerminalFailureAutoRecoveryRetry: { kind: "writer", reason: "persists terminal-failure recovery state" },
  claimTerminalFailureAutoRecoveryAttempt: { kind: "writer", reason: "persists terminal-failure recovery claim state" },
  applyPrMergedTransition: { kind: "writer", reason: "persists or mutates TaskStore state" },
  approveCliAutonomy: { kind: "writer", reason: "persists or mutates TaskStore state" },
  approveWorkflowCliCommand: { kind: "writer", reason: "persists or mutates TaskStore state" },
  archiveAllDone: { kind: "writer", reason: "persists or mutates TaskStore state" },
  archiveDb: { kind: "writer", reason: "persists or mutates TaskStore state" },
  archiveEntryToTask: { kind: "writer", reason: "persists or mutates TaskStore state" },
  archiveTask: { kind: "writer", reason: "persists or mutates TaskStore state" },
  archiveTaskAndCleanup: { kind: "writer", reason: "persists or mutates TaskStore state" },
  archiveTaskBackend: { kind: "writer", reason: "persists or mutates TaskStore state" },
  atomicCreateTaskJson: { kind: "writer", reason: "persists or mutates TaskStore state" },
  atomicWriteTaskJson: { kind: "writer", reason: "persists or mutates TaskStore state" },
  atomicWriteTaskJsonWithAudit: { kind: "writer", reason: "persists or mutates TaskStore state" },
  backfillCommitAssociationDiffStats: { kind: "writer", reason: "persists or mutates TaskStore state" },
  bypassFailedPreMergeReviewStep: { kind: "writer", reason: "persists or mutates TaskStore state" },
  cancelActiveWorkflowWorkItemsForTask: { kind: "writer", reason: "persists or mutates TaskStore state" },
  captureCurrentPlanEvidence: { kind: "writer", reason: "persists or mutates TaskStore state" },
  captureCurrentPlanEvidenceWhilePlanningLocked: { kind: "writer", reason: "persists or mutates TaskStore state" },
  checkAndRecordUnplannedExecutionBlock: { kind: "writer", reason: "persists or mutates TaskStore state" },
  claimNextToolFailureRetry: { kind: "writer", reason: "persists or mutates TaskStore state" },
  /*
  FNXC:MergeReliability 2026-09-24-17:09:
  FN-9388 classifies overlap-wait operations by their durable episode semantics. Claims, delivery
  publication, and completion mutate fenced episode ownership or receipts; listing is read-only.
  */
  claimTaskOverlapWait: { kind: "writer", reason: "claims and fences durable overlap-wait episode ownership" },
  completeTaskOverlapWait: { kind: "writer", reason: "persists a fenced overlap-wait receipt and completion phase" },
  listTaskOverlapWaits: { kind: "non-writer", reason: "reads durable overlap-wait episodes without mutation" },
  publishTaskOverlapDeliveries: { kind: "writer", reason: "persists delivery snapshots on open overlap-wait episodes" },
  claimTaskVerificationRequest: { kind: "writer", reason: "persists or mutates TaskStore state" },
  claimTaskWedgeNotificationEpisode: { kind: "writer", reason: "persists or mutates TaskStore state" },
  cleanupArchivedTasks: { kind: "writer", reason: "persists or mutates TaskStore state" },
  cleanupBranchForTask: { kind: "writer", reason: "persists or mutates TaskStore state" },
  cleanupNoOpTaskMovedActivityRowsOnce: { kind: "writer", reason: "persists or mutates TaskStore state" },
  cleanupOrphanedMaterializedSteps: { kind: "writer", reason: "persists or mutates TaskStore state" },
  cleanupStaleMergeQueueRows: { kind: "writer", reason: "persists or mutates TaskStore state" },
  clearActivityLog: { kind: "writer", reason: "persists or mutates TaskStore state" },
  clearCompletionHandoffAcceptedMarker: { kind: "writer", reason: "persists or mutates TaskStore state" },
  clearDoneTransientFields: { kind: "writer", reason: "persists or mutates TaskStore state" },
  clearLinkedAgentTaskIds: { kind: "writer", reason: "persists or mutates TaskStore state" },
  clearNearDuplicateReferencesTo: { kind: "writer", reason: "persists or mutates TaskStore state" },
  clearNearDuplicateReferencesToFailSoft: { kind: "writer", reason: "persists or mutates TaskStore state" },
  clearStaleExecutionStartBranchReferences: { kind: "writer", reason: "persists or mutates TaskStore state" },
  clearTaskWorkflowSelection: { kind: "writer", reason: "persists or mutates TaskStore state" },
  clearWorkflowRunBranches: { kind: "writer", reason: "persists or mutates TaskStore state" },
  clearWorkflowRunStepInstances: { kind: "writer", reason: "persists or mutates TaskStore state" },
  clearWorkflowRunStepInstancesAsync: { kind: "writer", reason: "persists or mutates TaskStore state" },
  consumePluginGateVerdicts: { kind: "writer", reason: "persists or mutates TaskStore state" },
  createBranchGroup: { kind: "writer", reason: "persists or mutates TaskStore state" },
  createCompletionHandoffWorkflowWork: { kind: "writer", reason: "persists or mutates TaskStore state" },
  createTask: { kind: "writer", reason: "persists or mutates TaskStore state" },
  createTaskBackend: { kind: "writer", reason: "persists or mutates TaskStore state" },
  createTaskVerificationRequest: { kind: "writer", reason: "persists or mutates TaskStore state" },
  createTaskWithDistributedReservation: { kind: "writer", reason: "persists or mutates TaskStore state" },
  createTaskWithReservedId: { kind: "writer", reason: "persists or mutates TaskStore state" },
  createWorkflowDefinition: { kind: "writer", reason: "persists or mutates TaskStore state" },
  createWorkflowStep: { kind: "writer", reason: "persists or mutates TaskStore state" },
  deleteAttachment: { kind: "writer", reason: "persists or mutates TaskStore state" },
  deleteTask: { kind: "writer", reason: "persists or mutates TaskStore state" },
  deleteTaskBackend: { kind: "writer", reason: "persists or mutates TaskStore state" },
  deleteTaskById: { kind: "writer", reason: "persists or mutates TaskStore state" },
  deleteTaskComment: { kind: "writer", reason: "persists or mutates TaskStore state" },
  deleteTaskDocument: { kind: "writer", reason: "persists or mutates TaskStore state" },
  deleteTaskIf: { kind: "writer", reason: "persists or mutates TaskStore state" },
  deleteWorkflowDefinition: { kind: "writer", reason: "persists or mutates TaskStore state" },
  deleteWorkflowStep: { kind: "writer", reason: "persists or mutates TaskStore state" },
  dequeueMergeQueueOnColumnExit: { kind: "writer", reason: "persists or mutates TaskStore state" },
  detectAndCacheTaskIdIntegrityReport: { kind: "writer", reason: "persists or mutates TaskStore state" },
  duplicateTask: { kind: "writer", reason: "persists or mutates TaskStore state" },
  emitObservedTaskDeleted: { kind: "writer", reason: "persists or mutates TaskStore state" },
  emitTaskLifecycleEventSafely: { kind: "writer", reason: "persists or mutates TaskStore state" },
  emitUsageEvent: { kind: "writer", reason: "persists or mutates TaskStore state" },
  enqueueMergeQueue: { kind: "writer", reason: "persists or mutates TaskStore state" },
  ensureBranchGroupForSource: { kind: "writer", reason: "persists or mutates TaskStore state" },
  ensurePrEntityForSource: { kind: "writer", reason: "persists or mutates TaskStore state" },
  ensureWorkflowStepForTemplate: { kind: "writer", reason: "persists or mutates TaskStore state" },
  finishTaskVerificationRequest: { kind: "writer", reason: "persists or mutates TaskStore state" },
  flushAgentLogBuffer: { kind: "writer", reason: "persists or mutates TaskStore state" },
  importLegacyAgentLogs: { kind: "writer", reason: "persists or mutates TaskStore state" },
  importLegacyAgentLogsOnce: { kind: "writer", reason: "persists or mutates TaskStore state" },
  insertArtifactRow: { kind: "writer", reason: "persists or mutates TaskStore state" },
  insertCompletionHandoffWorkflowWorkAudit: { kind: "writer", reason: "persists or mutates TaskStore state" },
  insertRunAuditEventRow: { kind: "writer", reason: "persists or mutates TaskStore state" },
  insertTask: { kind: "writer", reason: "persists or mutates TaskStore state" },
  insertTaskWithFtsRecovery: { kind: "writer", reason: "persists or mutates TaskStore state" },
  insertWorkflowDefinitionSync: { kind: "writer", reason: "persists or mutates TaskStore state" },
  invalidateConfigCacheAfterMigration: { kind: "writer", reason: "persists or mutates TaskStore state" },
  linkGithubIssue: { kind: "writer", reason: "persists or mutates TaskStore state" },
  linkTaskRecommendation: { kind: "writer", reason: "persists or mutates TaskStore state" },
  lockCurrentPlan: { kind: "writer", reason: "persists or mutates TaskStore state" },
  lockCurrentPlanWhilePlanningLocked: { kind: "writer", reason: "persists or mutates TaskStore state" },
  logTaskCreateConflict: { kind: "writer", reason: "persists or mutates TaskStore state" },
  markLegacyAutoMergeStampsOnce: { kind: "writer", reason: "persists or mutates TaskStore state" },
  markToolFailureRetryExhaustedAudit: { kind: "writer", reason: "persists or mutates TaskStore state" },
  markTerminalFailureAutoRecoveryBudgetExhausted: { kind: "writer", reason: "persists terminal-failure recovery budget state" },
  markTerminalFailureAutoRecoveryEscalationDelivered: { kind: "writer", reason: "persists terminal-failure escalation delivery state" },
  materializeDefaultWorkflowSteps: { kind: "writer", reason: "persists or mutates TaskStore state" },
  materializeExplicitWorkflowSteps: { kind: "writer", reason: "persists or mutates TaskStore state" },
  materializeWorkflowSteps: { kind: "writer", reason: "persists or mutates TaskStore state" },
  migrateActiveArchivedTasksToArchiveDb: { kind: "writer", reason: "persists or mutates TaskStore state" },
  migrateAgentLogEntriesToFilesOnce: { kind: "writer", reason: "persists or mutates TaskStore state" },
  migrateLegacyArchiveEntriesToArchiveDb: { kind: "writer", reason: "persists or mutates TaskStore state" },
  migrateLegacyWorkflowSteps: { kind: "writer", reason: "persists or mutates TaskStore state" },
  migrateMovedSettingsToWorkflowValuesOnce: { kind: "writer", reason: "persists or mutates TaskStore state" },
  moveTaskIf: { kind: "writer", reason: "persists or mutates TaskStore state" },
  moveTaskInternal: { kind: "writer", reason: "persists or mutates TaskStore state" },
  moveToDone: { kind: "writer", reason: "persists or mutates TaskStore state" },
  patchTaskRowInTransaction: { kind: "writer", reason: "persists or mutates TaskStore state" },
  pauseTask: { kind: "writer", reason: "persists or mutates TaskStore state" },
  pruneAgentActivityEventsAsync: { kind: "writer", reason: "persists or mutates TaskStore state" },
  pruneAgentLogFiles: { kind: "writer", reason: "persists or mutates TaskStore state" },
  pruneAgentLogFilesAsync: { kind: "writer", reason: "persists or mutates TaskStore state" },
  pruneImportTranslations: { kind: "writer", reason: "persists or mutates TaskStore state" },
  pruneOperationalLogs: { kind: "writer", reason: "persists or mutates TaskStore state" },
  pruneOperationalLogsAsync: { kind: "writer", reason: "persists or mutates TaskStore state" },
  publishArchivedTaskDocumentAddition: { kind: "writer", reason: "persists or mutates TaskStore state" },
  purgeTaskWorkflowSelectionRows: { kind: "writer", reason: "persists or mutates TaskStore state" },
  reconcileActiveTimingForEngineDowntime: { kind: "writer", reason: "persists or mutates TaskStore state" },
  reconcileDistributedTaskIdStateOnOpen: { kind: "writer", reason: "persists or mutates TaskStore state" },
  reconcileLegacyAutoMergeStamps: { kind: "writer", reason: "persists or mutates TaskStore state" },
  reconcileOrphanedTaskDirs: { kind: "writer", reason: "persists or mutates TaskStore state" },
  reconcilePhantomCommittedReservations: { kind: "writer", reason: "persists or mutates TaskStore state" },
  reconcileSoftDeletedColumnDriftBackend: { kind: "writer", reason: "persists or mutates TaskStore state" },
  reconcileSpecDrift: { kind: "writer", reason: "persists or mutates TaskStore state" },
  reconcileSpecDriftWhilePlanningLocked: { kind: "writer", reason: "persists or mutates TaskStore state" },
  reconcileStaleSymbolLocks: { kind: "writer", reason: "persists or mutates TaskStore state" },
  reconcileTaskCustomFieldsForSchema: { kind: "writer", reason: "persists or mutates TaskStore state" },
  recordActivity: { kind: "writer", reason: "persists or mutates TaskStore state" },
  recordActivityFromListener: { kind: "writer", reason: "persists or mutates TaskStore state" },
  recordAgentActivity: { kind: "writer", reason: "persists or mutates TaskStore state" },
  recordDependencyCycleRejectedAudit: { kind: "writer", reason: "persists or mutates TaskStore state" },
  recordGoalCitations: { kind: "writer", reason: "persists or mutates TaskStore state" },
  recordImportTranslation: { kind: "writer", reason: "persists or mutates TaskStore state" },
  recordPluginActivation: { kind: "writer", reason: "persists or mutates TaskStore state" },
  recordPluginGateVerdict: { kind: "writer", reason: "persists or mutates TaskStore state" },
  recordPrThreadOutcome: { kind: "writer", reason: "persists or mutates TaskStore state" },
  recordRunAuditEventBackend: { kind: "writer", reason: "persists or mutates TaskStore state" },
  recordVerificationCachePass: { kind: "writer", reason: "persists or mutates TaskStore state" },
  recoverExpiredMergeQueueLeases: { kind: "writer", reason: "persists or mutates TaskStore state" },
  recoverStaleTransitionPending: { kind: "writer", reason: "persists or mutates TaskStore state" },
  refreshTaskIdIntegrityReport: { kind: "writer", reason: "persists or mutates TaskStore state" },
  registerArtifact: { kind: "writer", reason: "persists or mutates TaskStore state" },
  rehomeOccupant: { kind: "writer", reason: "persists or mutates TaskStore state" },
  releaseMergeQueueLease: { kind: "writer", reason: "persists or mutates TaskStore state" },
  releaseSymbolLocks: { kind: "writer", reason: "persists or mutates TaskStore state" },
  removeMaterializedSelection: { kind: "writer", reason: "persists or mutates TaskStore state" },
  renewCheckoutLease: { kind: "writer", reason: "persists or mutates TaskStore state" },
  renewSymbolLocks: { kind: "writer", reason: "persists or mutates TaskStore state" },
  repairOverlapBlocker: { kind: "writer", reason: "persists or mutates TaskStore state" },
  replaceActiveTaskWorkflowContinuation: { kind: "writer", reason: "persists or mutates TaskStore state" },
  replaceLegacyTaskCommitAssociations: { kind: "writer", reason: "persists or mutates TaskStore state" },
  resetAllStepsToPending: { kind: "writer", reason: "persists or mutates TaskStore state" },
  resetPromptCheckboxes: { kind: "writer", reason: "persists or mutates TaskStore state" },
  resetTerminalFailureAutoRecoveryBudget: { kind: "writer", reason: "persists terminal-failure recovery budget state" },
  restoreFromArchive: { kind: "writer", reason: "persists or mutates TaskStore state" },
  resumeWorkflowStep: { kind: "writer", reason: "persists or mutates TaskStore state" },
  revokeCliAutonomy: { kind: "writer", reason: "persists or mutates TaskStore state" },
  rewriteBlockedByResidueDependentsForRemoval: { kind: "writer", reason: "persists or mutates TaskStore state" },
  rewriteDependentsForRemoval: { kind: "writer", reason: "persists or mutates TaskStore state" },
  rewriteLineageChildrenForRemoval: { kind: "writer", reason: "persists or mutates TaskStore state" },
  rollbackConfiguration: { kind: "writer", reason: "persists or mutates TaskStore state" },
  runPluginColumnTransitionHooks: { kind: "writer", reason: "persists or mutates TaskStore state" },
  runPluginSchemaInits: { kind: "writer", reason: "persists or mutates TaskStore state" },
  runTaskFtsWriteWithRecovery: { kind: "writer", reason: "persists or mutates TaskStore state" },
  saveWorkflowRunBranch: { kind: "writer", reason: "persists or mutates TaskStore state" },
  saveWorkflowRunStepInstance: { kind: "writer", reason: "persists or mutates TaskStore state" },
  saveWorkflowRunStepInstanceAsync: { kind: "writer", reason: "persists or mutates TaskStore state" },
  scanAndRecordCitations: { kind: "writer", reason: "persists or mutates TaskStore state" },
  seedStrandedPlanReviewContinuation: { kind: "writer", reason: "persists or mutates TaskStore state" },
  selectTaskWorkflow: { kind: "writer", reason: "persists or mutates TaskStore state" },
  selectTaskWorkflowAndReconcile: { kind: "writer", reason: "persists or mutates TaskStore state" },
  setCompletionHandoffAcceptedMarker: { kind: "writer", reason: "persists or mutates TaskStore state" },
  setDefaultWorkflowId: { kind: "writer", reason: "persists or mutates TaskStore state" },
  setPluginPostgresSchemaExecutor: { kind: "writer", reason: "persists or mutates TaskStore state" },
  setPluginWorkflowStepTemplates: { kind: "writer", reason: "persists or mutates TaskStore state" },
  setTaskBranchGroup: { kind: "writer", reason: "persists or mutates TaskStore state" },
  setTaskDeclaredSymbols: { kind: "writer", reason: "persists or mutates TaskStore state" },
  setupActivityLogListeners: { kind: "writer", reason: "persists or mutates TaskStore state" },
  startStep: { kind: "writer", reason: "persists or mutates TaskStore state" },
  suppressWatcher: { kind: "writer", reason: "persists or mutates TaskStore state" },
  syncAgentTaskLinkOnReassignment: { kind: "writer", reason: "persists or mutates TaskStore state" },
  transitionMergeRequestState: { kind: "writer", reason: "persists or mutates TaskStore state" },
  transitionQueuedEpisode: { kind: "writer", reason: "persists or mutates TaskStore state" },
  transitionWorkflowWorkItem: { kind: "writer", reason: "persists or mutates TaskStore state" },
  transitionWorkflowWorkItemSync: { kind: "writer", reason: "persists or mutates TaskStore state" },
  tryClaimCheckout: { kind: "writer", reason: "persists or mutates TaskStore state" },
  unarchiveTask: { kind: "writer", reason: "persists or mutates TaskStore state" },
  unlinkGithubIssue: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateArtifact: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateBranchGroup: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateGithubTracking: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateGlobalSettings: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateIssueInfo: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updatePrEntity: { kind: "writer", reason: "persists or mutates TaskStore state" },
  /*
  FNXC:MergeDurableWriteInventory 2026-10-05-01:35:
  Readiness snapshots persist project-scoped pull-request state under an expected-head CAS and
  terminal-state fence, so the public writer remains classified even without a merge-body closure edge.
  */
  updatePrReadiness: { kind: "writer", reason: "persists project-scoped readiness through expected-head CAS and terminal-state fence" },
  /*
  FNXC:MergeDurableWriteInventory 2026-10-05-03:34:
  FN-9439 makes readiness observation and the awaiting-pr-checks hold one transactional operation,
  while the paired release clears that hold only for the current ready head and emits its lifecycle event.
  Both public methods therefore persist fenced task or pull-request state even without a merge-body call edge.
  */
  updatePrReadinessAndAwaitChecksIfBlocked: { kind: "writer", reason: "persists readiness and the transactional awaiting-pr-checks task hold" },
  releaseAwaitingPrChecksIfCurrentHead: { kind: "writer", reason: "persists a current-head-gated task-status release and lifecycle event" },
  updatePrInfo: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updatePrInfoByNumber: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateSettings: { kind: "writer", reason: "persists or mutates TaskStore state" },
  /*
  FNXC:DurableWriteInventory 2026-08-23-00:40:
  Public TaskStore write surfaces added since this inventory was last regenerated. Each persists or
  mutates task state, so each is a durable writer:
    - dismissAiMergeReviewFinding / mutateTaskRepositoryScope / resetTaskPublication /
      normalizeWorkspaceTaskWorktreeMetadata -> updateTask(Atomic) mutations
    - logEntryOnce -> appends a deduplicated task log entry
    - seedWorkspaceCodeReviewContinuationIfIdle -> inserts a workflow continuation row
  */
  dismissAiMergeReviewFinding: { kind: "writer", reason: "persists or mutates TaskStore state" },
  logEntryOnce: { kind: "writer", reason: "persists or mutates TaskStore state" },
  mutateTaskRepositoryScope: { kind: "writer", reason: "persists or mutates TaskStore state" },
  normalizeWorkspaceTaskWorktreeMetadata: { kind: "writer", reason: "persists or mutates TaskStore state" },
  resetTaskPublication: { kind: "writer", reason: "persists or mutates TaskStore state" },
  seedWorkspaceCodeReviewContinuationIfIdle: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateStep: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateTaskRepositoryScope: { kind: "writer", reason: "persists or mutates TaskStore state" },
  publishWorkspaceCodeReviewEvidence: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateWorkspaceReviewState: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateTaskAtomic: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateTaskComment: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateTaskCustomFields: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateTaskDependencies: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateTaskUnlocked: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateWorkflowDefinition: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateWorkflowPromptOverrides: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateWorkflowSettingValues: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateWorkflowStep: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateWorkflowStepResultsFenced: { kind: "writer", reason: "atomically persists workflow-step results behind their durable fence" },
  updateWorkflowStepResultsWithLogFenced: { kind: "writer", reason: "atomically persists workflow-step results and one task-log entry behind the same durable fence" },
  upsertMergeRequestRecord: { kind: "writer", reason: "persists or mutates TaskStore state" },
  upsertPrInfoByNumber: { kind: "writer", reason: "persists or mutates TaskStore state" },
  upsertTask: { kind: "writer", reason: "persists or mutates TaskStore state" },
  upsertTaskDocument: { kind: "writer", reason: "persists or mutates TaskStore state" },
  upsertTaskWithFtsRecovery: { kind: "writer", reason: "persists or mutates TaskStore state" },
  upsertWorkflowWorkItem: { kind: "writer", reason: "persists or mutates TaskStore state" },
  walCheckpoint: { kind: "writer", reason: "persists or mutates TaskStore state" },
  writeArtifactData: { kind: "writer", reason: "persists or mutates TaskStore state" },
  writeConfig: { kind: "writer", reason: "persists or mutates TaskStore state" },
  writeTaskJsonFile: { kind: "writer", reason: "persists or mutates TaskStore state" },
  writeTaskWorkflowSelection: { kind: "writer", reason: "persists or mutates TaskStore state" },
  /*
  FNXC:MergeReliability 2026-08-29-01:10:
  FN-251's inventory regeneration found six previously unclassified TaskStore methods. Patchnode
  completion, revert, reconciliation, and feed reads can mutate the durable ledger; remediation
  appends mutate task steps. Project identity is a synchronous scoped read and stays non-writer.
  */
  appendRemediationSteps: { kind: "writer", reason: "persists task remediation steps" },
  /*
  FNXC:MergeReliability 2026-10-01-22:44:
  FN-9429 adds an attested stale-callback waiver receipt. Reading receipts is merge-gate input only,
  while issuing one replaces durable receipt state and must remain a writer even when current merge
  entry points do not issue it.
  */
  getProjectId: { kind: "non-writer", reason: "returns the bound project identity without persistence" },
  getStaleReviewCallbackWaiverReceipts: { kind: "non-writer", reason: "reads project-scoped stale review callback waiver receipts without mutation" },
  issueStaleReviewCallbackWaiver: { kind: "writer", reason: "issues or replaces an attested stale review callback waiver receipt" },
  listPatchnodeEntries: { kind: "writer", reason: "may reconcile and persist the patchnode ledger before reading" },
  reconcilePatchnodeLedger: { kind: "writer", reason: "reconciles durable patchnode ledger entries" },
  recordPatchnodeCompletion: { kind: "writer", reason: "persists a patchnode completion ledger entry" },
  recordPatchnodeRevert: { kind: "writer", reason: "persists patchnode revert and pairing state" },
  appendAgentLog: { kind: "writer", reason: "persists task-scoped agent timeline state" },
  emit: { kind: "writer", reason: "announces task lifecycle events to durable subscribers" },
  logEntry: { kind: "writer", reason: "persists task-scoped log state and refreshes updatedAt" },
  moveTask: { kind: "writer", reason: "persists task column and lifecycle movement" },
  recordBranchGroupMemberLanded: { kind: "writer", reason: "persists branch-group landing state" },
  recordRunAuditEvent: { kind: "writer", reason: "persists task-associated run audit state" },
  updateTask: { kind: "writer", reason: "persists task row mutations" },
  upsertTaskCommitAssociation: { kind: "writer", reason: "persists task commit association" },
  /*
  FNXC:MergeReliability 2026-08-16-05:28:
  FN-9059 workspace coordination surface. Lease acquire/renew/release/reclaim/reconcile and
  fence-ref recording mutate `workspaceCoordinationLeases`; land-intent record/resolve mutate the
  write-ahead intent rows; mergeWorkspaceWorktreeEntry persists workspace worktree entries; and
  withValidWorkspaceLease runs caller mutations transactionally under a validated lease fence.
  An orphaned merge body reaching any of these would mutate coordination state it no longer owns.
  */
  acquireWorkspaceLease: { kind: "writer", reason: "persists workspace coordination lease state" },
  mergeWorkspaceWorktreeEntry: { kind: "writer", reason: "persists workspace worktree entry state" },
  reclaimWorkspaceLease: { kind: "writer", reason: "persists workspace coordination lease state" },
  reconcileExpiredWorkspaceLeases: { kind: "writer", reason: "persists workspace coordination lease state" },
  recordWorkspaceLandIntent: { kind: "writer", reason: "persists workspace land write-ahead intent state" },
  recordWorkspaceLeaseFenceRef: { kind: "writer", reason: "persists workspace coordination lease state" },
  releaseStaleWorkspaceLeasesForNode: { kind: "writer", reason: "persists workspace coordination lease state" },
  releaseWorkspaceLease: { kind: "writer", reason: "persists workspace coordination lease state" },
  renewWorkspaceLease: { kind: "writer", reason: "persists workspace coordination lease state" },
  resolveOrphanedWorkspaceLandIntent: { kind: "writer", reason: "persists workspace land write-ahead intent state" },
  resolveWorkspaceLandIntent: { kind: "writer", reason: "persists workspace land write-ahead intent state" },
  withValidWorkspaceLease: { kind: "writer", reason: "runs caller mutations transactionally under a validated workspace lease fence" },
};
const NON_WRITER_REASONS: Record<string, string> = Object.fromEntries([
  "__invokeHandoffMergeQueueFailureInjectorForTesting",
  "__setHandoffMergeQueueFailureInjectorForTesting",
  "_createTaskInternal",
  "_createTaskInternalBackend",
  "_maybeAutoArchiveSameAgentDuplicate",
  "_maybeAutoArchiveSameAgentDuplicateBackend",
  "acquireMergeQueueLease",
  "acquireSymbolLocks",
  "acquireWorkflowWorkItemLease",
  "addAttachment",
  "addComment",
  "addPrInfo",
  "addSteeringComment",
  "addTaskComment",
  "appendAgentLogBatch",
  "appendCurrentPlanEvidence",
  "appendSpecDriftReport",
  "appendSpecDriftReportWhilePlanningLocked",
  "appendSpecLock",
  "applyBuiltInPromptOverridesAsync",
  "applyBuiltInPromptOverridesSync",
  "applyLegacyWorkflowStepOverrides",
  "applyPrMergedTransition",
  "approveCliAutonomy",
  "approveWorkflowCliCommand",
  "archiveAllDone",
  "archiveDb",
  "archiveEntryToTask",
  "archiveFts5Available",
  "archiveTask",
  "archiveTaskAndCleanup",
  "archiveTaskBackend",
  "areAllDependenciesDone",
  "artifactRegistryDir",
  "artifactStoredName",
  "assertNoDependencyCycle",
  "assertTaskIdAvailable",
  "assertWorkflowIrTraitsValid",
  "atomicCreateTaskJson",
  "atomicWriteTaskJson",
  "atomicWriteTaskJsonWithAudit",
  "backendMode",
  "backfillCommitAssociationDiffStats",
  "buildActiveTaskDependencyLookup",
  "buildArchivedAgentLogFields",
  "buildTaskIdIntegrityFallbackReport",
  "bypassFailedPreMergeReviewStep",
  "cancelActiveWorkflowWorkItemsForTask",
  "captureCurrentPlanEvidence",
  "captureCurrentPlanEvidenceWhilePlanningLocked",
  "checkAndRecordUnplannedExecutionBlock",
  "claimNextToolFailureRetry",
  "claimTaskVerificationRequest",
  "claimTaskWedgeNotificationEpisode",
  "cleanupArchivedTasks",
  "cleanupBranchForTask",
  "cleanupNoOpTaskMovedActivityRowsOnce",
  "cleanupOrphanedMaterializedSteps",
  "cleanupStaleMergeQueueRows",
  "clearActivityLog",
  "clearCompletionHandoffAcceptedMarker",
  "clearDoneTransientFields",
  "clearLinkedAgentTaskIds",
  "clearNearDuplicateReferencesTo",
  "clearNearDuplicateReferencesToFailSoft",
  "clearStaleExecutionStartBranchReferences",
  "clearStartupSlimListMemo",
  "clearTaskWorkflowSelection",
  "clearWorkflowRunBranches",
  "clearWorkflowRunStepInstances",
  "clearWorkflowRunStepInstancesAsync",
  "close",
  "collectMergeDetails",
  "computeMovedSettingsTargetWorkflowIds",
  "computeTimedExecutionMs",
  "consumePluginGateVerdicts",
  "countActiveInCapacitySlotAsync",
  "countActiveInCapacitySlotSync",
  "createBranchGroup",
  "createCompletionHandoffWorkflowWork",
  "createTask",
  "createTaskBackend",
  "createTaskPersistSerializationContext",
  "createTaskVerificationRequest",
  "createTaskWithDistributedReservation",
  "createTaskWithReservedId",
  "createWorkflowDefinition",
  "createWorkflowStep",
  "db",
  "deleteAttachment",
  "deleteTask",
  "deleteTaskBackend",
  "deleteTaskById",
  "deleteTaskComment",
  "deleteTaskDocument",
  "deleteTaskIf",
  "deleteWorkflowDefinition",
  "deleteWorkflowStep",
  "dequeueMergeQueueOnColumnExit",
  "detectAndCacheTaskIdIntegrityReport",
  "duplicateTask",
  "emitObservedTaskDeleted",
  "emitTaskLifecycleEventSafely",
  "emitUsageEvent",
  "enqueueMergeQueue",
  "ensureBranchGroupForSource",
  "ensurePrEntityForSource",
  "ensureWorkflowStepForTemplate",
  "evaluateWorkflowMovePolicies",
  "findInArchive",
  "findLiveDependents",
  "findLiveLineageChildren",
  "findOpenRevertTaskForSource",
  "findRecentTasksByContentFingerprint",
  "findRecentTasksBySourceParentTaskId",
  "findTaskByProposalClaimId",
  "finishTaskVerificationRequest",
  "flushAgentLogBuffer",
  "fts5Available",
  "generateBranchGroupId",
  "generatePrEntityId",
  "generatePromptFromArchiveEntry",
  "generateSpecifiedPrompt",
  "getActiveMergingTask",
  "getActivePrEntityBySource",
  "getActiveSpecLock",
  "getActivityLog",
  "getAgentLogCount",
  "getAgentLogs",
  "getAgentLogsByTimeRange",
  "getAllDocuments",
  "getArchiveFtsIndexBytes",
  "getArchivedRowCount",
  "getArtifact",
  "getArtifacts",
  "getAsyncLayer",
  "getAttachment",
  "getBootstrappedAt",
  "getBranchGroup",
  "getBranchGroupByBranchName",
  "getBranchGroupBySource",
  "getBranchProgressByTask",
  "getBuiltInWorkflowTemplate",
  "getCompletionHandoffAcceptedMarker",
  "getDatabase",
  "getDatabaseHealth",
  "getDefaultWorkflowId",
  "getDistributedTaskIdAllocator",
  "getEvalStore",
  "getExperimentSessionStore",
  "getFtsIndexBytes",
  "getFusionDir",
  "getGlobalSettingsDir",
  "getGlobalSettingsStore",
  "getGoalStore",
  "getIdeationStore",
  "getImportTranslation",
  "getInReviewDurationEvents",
  "getInsightStore",
  "getIntakeOwnerAgentStore",
  "getLatestCurrentPlanEvidence",
  "getLatestSpecDriftReport",
  "getLatestSpecLock",
  "getLegacyWorkflowStepSnapshot",
  "getMalformedTaskMetadataReason",
  "getMergeQueuedTaskIds",
  "getMergeQueuedTaskIdsAsync",
  "getMergeRequestRecord",
  "getMergeRequestRecordAsync",
  /* FNXC:MergeAuthority 2026-08-23-00:40: batched sibling of the read above; same read-only shape. */
  "getMergeRequestRecordsAsync",
  "getMissionStore",
  "getMutationsForRun",
  "getOrCreateForProject",
  "getPluginStore",
  "getPrEntity",
  "getPrEntityByNumber",
  "getPrThreadState",
  "getResearchStore",
  "getReviewBypassEligibility",
  "getRootDir",
  "getRunAuditEvents",
  "getRunAuditEventsAsync",
  "getSecretsStore",
  "getSettings",
  "getSettingsByScope",
  "getSettingsByScopeFast",
  "getSettingsFast",
  "getSettingsSync",
  "getSoftDeletedWriteConflict",
  "getTask",
  "getTaskColumns",
  "getTaskCommitAssociationsByLineageId",
  "getTaskDir",
  "getTaskDocument",
  "getTaskDocumentRevisions",
  "getTaskDocuments",
  "getTaskIdFromDir",
  "getTaskIdIntegrityReport",
  "getTaskMergedTaskIds",
  "getTaskMovedCountsByDay",
  "getTaskPatchDescriptors",
  "getTaskPersistValues",
  "getTaskPrInfos",
  "getTaskRowCount",
  "getTaskSelectClause",
  "getTaskSelectClauseWithActivityLogLimit",
  "getTaskVerificationRequestAsync",
  "getTaskWorkflowSelection",
  "getTaskWorkflowSelectionAsync",
  "getTaskWorkflowSelectionsAsync",
  "getTasksByAssignedAgent",
  "getTasksDir",
  "getTodoStore",
  "getVerificationCacheHit",
  "getWorkflowDefinition",
  "getWorkflowPromptOverrides",
  "getWorkflowPromptOverridesAsync",
  "getWorkflowSettingValues",
  "getWorkflowSettingValuesAsync",
  "getWorkflowSettingsProjectId",
  "getWorkflowStep",
  "getWorkflowWorkItem",
  "getWorkflowWorkItemByIdentity",
  "handoffToReview",
  "hasActiveTask",
  "hasWorkflowRunStepInstancesForTask",
  "healthCheck",
  "importLegacyAgentLogs",
  "importLegacyAgentLogsOnce",
  "init",
  "insertArtifactRow",
  "insertCompletionHandoffWorkflowWorkAudit",
  "insertRunAuditEventRow",
  "insertTask",
  "insertTaskWithFtsRecovery",
  "insertWorkflowDefinitionSync",
  "inspectSymbolLockConflicts",
  "inspectWorkspaceLeases",
  "invalidateConfigCacheAfterMigration",
  "invokeTaskCreatedHook",
  "isActiveWorkflowWorkItemState",
  "isBackendMode",
  "isCliAutonomyApproved",
  "isLegacyAutoMergeStampCandidate",
  "isPluginInstalled",
  "isTaskArchived",
  "isTaskArchivedAsync",
  "isTaskIdConflictError",
  "isTaskIdPresentInArchivedTasksTable",
  "isTaskIdPresentInArchivedTasksTableAsync",
  "isTerminalWorkflowWorkItemState",
  "isValidMergeRequestTransition",
  "isWatching",
  "isWorkflowCliCommandApproved",
  "linkGithubIssue",
  "linkTaskRecommendation",
  "listActivePrEntities",
  "listApprovedCliAutonomyAdapters",
  "listArchivedTasks",
  "listArtifacts",
  "listBranchGroups",
  "listCurrentPlanEvidence",
  "listDueWorkflowWorkItems",
  "listGoalCitations",
  "listLegacyAutoMergeStampCandidates",
  "listPendingWorkspaceLandIntents",
  "listPrThreadStates",
  "listSpecDriftReports",
  "listSpecLocks",
  "listStrandedRefinements",
  "listTaskRecommendations",
  "listTasks",
  "listTasksByBranchGroup",
  "listTasksBySourceLineage",
  "listTasksForGithubTrackingReconcile",
  "listTasksForGitlabTrackingReconcile",
  "listTasksModifiedSince",
  "listWorkflowDefinitions",
  "listWorkflowOccupantTaskIds",
  "listWorkflowPromptOverridesForProject",
  "listWorkflowSettingValuesForProject",
  "listWorkflowSteps",
  "listWorkflowWorkItemsForTask",
  /* FNXC:MergeAuthority 2026-08-23-00:40: batched sibling of the read above; same read-only shape. */
  "listWorkflowWorkItemsForTasks",
  "listWorkflowWorkItemsForTaskSync",
  "loadWorkflowRunBranches",
  "loadWorkflowRunStepInstances",
  "loadWorkflowRunStepInstancesAsync",
  "lockCurrentPlan",
  "lockCurrentPlanWhilePlanningLocked",
  "logTaskCreateConflict",
  "makeSyntheticDeleteRunId",
  "markLegacyAutoMergeStampsOnce",
  "markToolFailureRetryExhaustedAudit",
  "materializeDefaultWorkflowSteps",
  "materializeExplicitWorkflowSteps",
  "materializeWorkflowSteps",
  "maybeResolveTombstonedTaskId",
  "mergeCustomFieldPatch",
  "mergeTask",
  "mergeTaskIdIntegrityReports",
  "migrateActiveArchivedTasksToArchiveDb",
  "migrateAgentLogEntriesToFilesOnce",
  "migrateLegacyArchiveEntriesToArchiveDb",
  "migrateLegacyWorkflowSteps",
  "migrateMovedSettingsToWorkflowValuesOnce",
  "moveTaskIf",
  "moveTaskInternal",
  "moveToDone",
  "nextWorkflowDefinitionId",
  "normalizeMergeRequestState",
  "normalizeTaskFromDisk",
  "normalizeWorkflowWorkItemKind",
  "normalizeWorkflowWorkItemState",
  "occupantsByColumnForWorkflow",
  "optimizeArchiveFts5",
  "optimizeFts5",
  "optionalGroupIdSet",
  "parseDependenciesFromPrompt",
  "parseFileScopeFromPrompt",
  "parseStepsFromPrompt",
  "parseWorkflowLayout",
  "parseWorkflowPromptOverrideJson",
  "patchTaskRowInTransaction",
  "pauseTask",
  "peekMergeQueue",
  "peekMergeQueueHead",
  "pgRowToTaskRow",
  "planningLifecycleLockTransportAvailability",
  "preflightPluginSchema",
  "prepareWorkflowMovePolicyPreflight",
  "projectMergeRequestToWorkflowWorkItem",
  "pruneAgentActivityEventsAsync",
  "pruneAgentLogFiles",
  "pruneAgentLogFilesAsync",
  "pruneImportTranslations",
  "pruneOperationalLogs",
  "pruneOperationalLogsAsync",
  "publishArchivedTaskDocumentAddition",
  "purgeTaskWorkflowSelectionRows",
  "readAllWorkflowDefinitions",
  "readArchiveLog",
  "readConfig",
  "readConfigFast",
  "readPreArchiveColumnFromTaskFile",
  "readPromptForArchive",
  "readRawProjectSettings",
  "readTaskForMove",
  "readTaskFromDb",
  "readTaskJson",
  "readTaskRowFromDb",
  "rebuildArchiveFts5Index",
  "reconcileActiveTimingForEngineDowntime",
  "reconcileDistributedTaskIdStateOnOpen",
  "reconcileLegacyAutoMergeStamps",
  "reconcileOrphanedTaskDirs",
  "reconcilePhantomCommittedReservations",
  "reconcileSoftDeletedColumnDriftBackend",
  "reconcileSpecDrift",
  "reconcileSpecDriftWhilePlanningLocked",
  "reconcileStaleSymbolLocks",
  "reconcileTaskCustomFieldsForSchema",
  "recordActivity",
  "recordActivityFromListener",
  "recordAgentActivity",
  "recordDependencyCycleRejectedAudit",
  "recordGoalCitations",
  "recordImportTranslation",
  "recordPluginActivation",
  "recordPluginGateVerdict",
  "recordPrThreadOutcome",
  "recordRunAuditEventBackend",
  "recordVerificationCachePass",
  "recoverExpiredMergeQueueLeases",
  "recoverStaleTransitionPending",
  "refineTask",
  "refreshDatabaseHealth",
  "refreshDatabaseHealthAsync",
  "refreshTaskIdIntegrityReport",
  "registerArtifact",
  "rehomeOccupant",
  "releaseMergeQueueLease",
  "releaseSymbolLocks",
  "removeMaterializedSelection",
  "removePrInfoByNumber",
  "renewCheckoutLease",
  "renewSymbolLocks",
  "repairOverlapBlocker",
  "replaceActiveTaskWorkflowContinuation",
  "replaceLegacyTaskCommitAssociations",
  "resetAllStepsToPending",
  "resetPromptCheckboxes",
  "resolveEnabledWorkflowSteps",
  "resolveLocalNodeIdForTaskAllocation",
  "resolveOriginWorkflowOverrideId",
  "resolvePluginWorkflowStep",
  "resolvePrimaryPrInfo",
  "resolveTaskCustomFieldDefsSync",
  "resolveTaskSymbols",
  "resolveTaskSymbolsForWorkItem",
  "resolveTaskWedgeNotificationEpisode",
  "resolveTaskWorkflowIrSync",
  "resolveUnarchiveTargetColumn",
  "resolveWorkflowBypassGuards",
  "resolveWorkflowMoveActor",
  "resolveWorkflowSettingDeclarations",
  "restoreFromArchive",
  "resumeWorkflowStep",
  "revokeCliAutonomy",
  "rewriteBlockedByResidueDependentsForRemoval",
  "rewriteDependentsForRemoval",
  "rewriteLineageChildrenForRemoval",
  "rollbackConfiguration",
  "rowToArtifact",
  "rowToBranchGroup",
  "rowToCompletionHandoffMarker",
  "rowToGoalCitation",
  "rowToMergeQueueEntry",
  "rowToMergeRequestRecord",
  "rowToPrEntity",
  "rowToRunAuditEvent",
  "rowToTask",
  "rowToTaskDocument",
  "rowToTaskDocumentRevision",
  "rowToWorkflowWorkItem",
  "runGitCommand",
  "runPluginColumnTransitionHooks",
  "runPluginSchemaInits",
  "runTaskFtsWriteWithRecovery",
  "saveWorkflowRunBranch",
  "saveWorkflowRunStepInstance",
  "saveWorkflowRunStepInstanceAsync",
  "scanAndRecordCitations",
  "searchTasks",
  "seedStrandedPlanReviewContinuation",
  "selectNextTaskForAgent",
  "selectTaskWorkflow",
  "selectTaskWorkflowAndReconcile",
  "serializeConfigForDisk",
  "setCompletionHandoffAcceptedMarker",
  "setDefaultWorkflowId",
  "setPluginPostgresSchemaExecutor",
  "setPluginWorkflowStepTemplates",
  "setTaskBranchGroup",
  "setTaskDeclaredSymbols",
  "setupActivityLogListeners",
  "shouldSkipWorkflowMovePolicies",
  "startStep",
  "startTaskDeletedOutboxConsumer",
  "stopTaskDeletedOutboxConsumer",
  "stopWatching",
  "summarizeAgentLog",
  "suppressWatcher",
  "syncAgentTaskLinkOnReassignment",
  "taskDir",
  "taskIdExistsAnywhere",
  "taskToArchiveEntry",
  "throwSoftDeletedWriteBlocked",
  "toBuiltInWorkflowStep",
  "toStoredWorkflowStep",
  "toWorkflowDefinition",
  "trackDeferredTaskCreatedWork",
  "transitionMergeRequestState",
  "transitionQueuedEpisode",
  "transitionWorkflowWorkItem",
  "transitionWorkflowWorkItemSync",
  "tryClaimCheckout",
  "unarchiveTask",
  "unlinkGithubIssue",
  "updateArtifact",
  "updateBranchGroup",
  "updateGithubTracking",
  "updateGlobalSettings",
  "updateIssueInfo",
  "updatePrEntity",
  "updatePrInfo",
  "updatePrInfoByNumber",
  "updateSettings",
  "updateStep",
  "updateTaskAtomic",
  "updateTaskComment",
  "updateTaskCustomFields",
  "updateTaskDependencies",
  "updateTaskUnlocked",
  "updateWorkflowDefinition",
  "updateWorkflowPromptOverrides",
  "updateWorkflowSettingValues",
  "updateWorkflowStep",
  "upsertMergeRequestRecord",
  "upsertPrInfoByNumber",
  "upsertTask",
  "upsertTaskDocument",
  "upsertTaskWithFtsRecovery",
  "upsertWorkflowWorkItem",
  "validateWorkspaceLeaseFence",
  "walCheckpoint",
  "watch",
  "withConfigLock",
  "withPlanningLifecycleLock",
  "withPlanningLifecycleLocks",
  "withTaskLock",
  "withWorktreeAllocationLock",
  "workflowStateForMergeRequestState",
  "writeArtifactData",
  "writeConfig",
  "writeTaskJsonFile",
  "writeTaskWorkflowSelection"
].map((method) => [method, "reviewed public TaskStore operation; not a durable writer reached by this merge frontier"]));


export function deriveDurableWriterSurface(): { source: string; writers: string[]; classified: SurfaceClassification[]; unclassified: string[] } {
  const file = resolve(ROOT, STORE_SOURCE); const sf = source(file); const methods = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === "TaskStore") for (const member of node.members) {
      if ((ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member))
        && member.name && ts.isIdentifier(member.name) && !member.modifiers?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)) methods.add(member.name.text);
    }
    ts.forEachChild(node, visit);
  }; visit(sf);
  const classified = [...methods].sort().map((method): SurfaceClassification => {
    const classification = STORE_METHOD_CLASSIFICATION[method];
    if (classification) return { method, ...classification };
    if (NON_WRITER_REASONS[method]) return { method, kind: "non-writer", reason: NON_WRITER_REASONS[method] };
    return { method, kind: "non-writer", reason: "UNCLASSIFIED: review this new public surface before the scan can be trusted" };
  });
  const unclassified = classified.filter((entry) => entry.reason.startsWith("UNCLASSIFIED:")).map((entry) => entry.method);
  return { source: STORE_SOURCE, writers: [...new Set([...classified.filter((x) => x.kind === "writer").map((x) => x.method), ...EXTRA_WRITERS])].sort(), classified, unclassified };
}

export function deriveMergeReachableModules(): { modules: string[]; boundary: { module: string; reason: string }[] } {
  const seen = new Set<string>(); const pending = [resolve(ROOT, ENTRY)];
  while (pending.length) {
    const file = pending.pop()!; if (seen.has(file) || /__tests__/.test(file)) continue; seen.add(file);
    const sf = source(file);
    sf.forEachChild((node) => {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || node.importClause?.isTypeOnly) return;
      const specifier = node.moduleSpecifier.text; if (!specifier.startsWith(".")) return;
      const next = resolveRelative(file, specifier); if (!next) return;
      const nextRepo = repo(next);
      if (CLOSURE_BOUNDARY.some((entry) => entry.module === nextRepo)) return;
      pending.push(next);
    });
  }
  return { modules: [...seen].map(repo).sort(), boundary: [...CLOSURE_BOUNDARY] };
}

function fingerprint(call: ts.CallExpression, sf: ts.SourceFile): string {
  const text = (node: ts.Node) => node.getText(sf).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "").replace(/\s+/g, " ").trim();
  const args = [...call.arguments].map((arg) => ts.isObjectLiteralExpression(arg)
    ? `{${arg.properties.map((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) ? p.name.text : "?").join(",")}}`
    : text(arg).slice(0, 120));
  return `${text(call.expression)}(${args.join(",")})`;
}
function unwrapStoreExpr(expr: ts.Expression): ts.Expression {
  // FNXC:MergeReliability 2026-08-10-23:55:
  // FN-8923 must classify optional TaskStore calls whose receiver is type-asserted. The
  // branch-group landing write uses `(store as Partial<TaskStore>)?.method(...)`; stripping
  // transparent assertion/chain wrappers keeps it a provable store receiver instead of a blind spot.
  while (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)
    || ts.isTypeAssertionExpression(expr) || ts.isNonNullExpression(expr)
    || ts.isPartiallyEmittedExpression(expr) || ts.isSatisfiesExpression(expr)) {
    expr = expr.expression;
  }
  return expr;
}
/*
FNXC:MergeDurableWriteInventory 2026-10-08-05:21:
KB-047: the scanner used to recognise only `store`, `options.store`, `deps.store` and their aliases, so every
write through `this.store` (including notification-service wedge-notification state) and other store-holding
receivers had no inventory row and no human verdict. Receivers are now reviewed tables, never a name heuristic:
agent, mission and plugin stores share writer method names such as `emit`, so "ends in store" would be wrong.
- `TASK_STORE_RECEIVER_SHAPES`: receiver shapes whose declared type is a TaskStore or a TaskStore-shaped subset.
- `NON_TASK_STORE_RECEIVERS`: per-module receivers proven NOT to be a TaskStore; a per-module entry wins over a
  global shape so a single mis-typed module can be excluded precisely.
- Census rule: any other receiver in front of a writer-named method fails closed as the suspect
  `unreviewed task-store receiver shape <shape>`, and a non-store entry that is no longer observed is stale.
Id stability: legacy shapes (and their aliases) keep the writer label `store.<method>` so the pre-KB-047 rows keep
byte-identical ids; new shapes use `<shape>.<method>`, and an alias of a new shape uses its root shape. Ordinals
are counted per `path::writer`, so a new-shape row can never shift a legacy row's ordinal.
*/

/** Receivers whose rows keep the historical `store.<method>` writer label (id stability). */
const LEGACY_STORE_SHAPES: ReadonlySet<string> = new Set(["store", "options.store", "deps.store"]);

/** Reviewed receiver shapes whose declared type is a TaskStore (or a TaskStore-shaped subset). */
export const TASK_STORE_RECEIVER_SHAPES: readonly { shape: string; reason: string }[] = Object.freeze([
  { shape: "store", reason: "legacy FN-8923 receiver: TaskStore parameter or local" },
  { shape: "options.store", reason: "legacy FN-8923 receiver: TaskStore option field" },
  { shape: "deps.store", reason: "legacy FN-8923 receiver: TaskStore dependency field" },
  { shape: "this.store", reason: "class field typed TaskStore, or a TaskStore-shaped subset (NotificationServiceStore, OverseerLogStore)" },
  { shape: "ctx.store", reason: "merger.ts and agent-usage-telemetry.ts contexts declare `store: TaskStore`" },
  { shape: "input.store", reason: "merge/executor/runtime input objects declare `store: TaskStore` or a Pick of it" },
  { shape: "opts.store", reason: "merger.ts and workspace-base-branch.ts options declare `store: TaskStore` or `Pick<TaskStore, \"logEntry\">`" },
  { shape: "params.store", reason: "merger-ai-squash-gates.ts and merger-file-scope.ts params declare `store: TaskStore`" },
  { shape: "this.taskStore", reason: "agent-heartbeat, mission-autopilot and in-process-runtime class field typed TaskStore" },
  { shape: "taskStore", reason: "agent-heartbeat and agent-tools parameters typed TaskStore" },
  { shape: "this.options.taskStore", reason: "mesh-lease-manager and routine-runner options declare `taskStore: TaskStore`" },
  { shape: "deps.taskStore", reason: "foreign-only-contamination dependencies declare `taskStore: TaskStore`" },
  { shape: "callbackStore", reason: "worktree-acquisition.ts `new Proxy(store, ...)` over the TaskStore; a Proxy initializer is not an alias" },
]);

/** Reviewed receivers in front of writer-named methods that are proven NOT to be a TaskStore, per module. */
export const NON_TASK_STORE_RECEIVERS: readonly { module: string; shape: string; reason: string }[] = Object.freeze([
  { module: "packages/engine/src/cli-agent/adapters/codex.ts", shape: "this", reason: "CodexWaitingAnalyzer's own adapter-event emit" },
  { module: "packages/engine/src/cli-agent/adapters/generic.ts", shape: "this", reason: "GenericHeuristicAnalyzer's own adapter-event emit" },
  { module: "packages/engine/src/missions/mission-execution-loop.ts", shape: "this", reason: "MissionExecutionLoop extends EventEmitter; in-process event emit" },
  { module: "packages/engine/src/runtimes/in-process-runtime.ts", shape: "this", reason: "InProcessRuntime's private recordActivity and EventEmitter emit" },
  { module: "packages/engine/src/scheduler.ts", shape: "this", reason: "Scheduler's private transitionQueuedEpisode; its TaskStore writes are inventoried at this.store call sites" },
  { module: "packages/engine/src/self-healing.ts", shape: "this", reason: "SelfHealingManager.reconcileStaleSymbolLocks; its TaskStore writes are inventoried at this.store call sites" },
  { module: "packages/engine/src/workflows/workflow-graph-task-runner.ts", shape: "this", reason: "WorkflowGraphTaskRunner's private telemetry emit" },
  { module: "packages/engine/src/execution/step-session-executor.ts", shape: "stuckTaskDetector", reason: "StuckTaskDetector.recordActivity in-memory heartbeat" },
  { module: "packages/engine/src/triage.ts", shape: "stuckDetector", reason: "StuckTaskDetector.recordActivity in-memory heartbeat" },
  { module: "packages/engine/src/pi.ts", shape: "extensionRunner", reason: "pi ExtensionRunner session_shutdown event emit" },
  { module: "packages/engine/src/scheduler.ts", shape: "this.options.prMonitor", reason: "PrMonitor.updatePrInfo in-memory PR tracking" },
  { module: "packages/engine/src/credential-instance-rotation.ts", shape: "this.options", reason: "injected RotationAudit callback option, not a TaskStore receiver" },
  { module: "packages/engine/src/merge/merge-write-fence.ts", shape: "recorder", reason: "OrphanFenceAuditRecorder for the fence's own merge:orphan-write-fenced row; production callers inject the function form" },
  { module: "packages/engine/src/workflows/workflow-column-boundary.ts", shape: "deps", reason: "injected WorkflowColumnMove seam (deps.moveTask), not a TaskStore receiver" },
]);

const TASK_STORE_SHAPE_SET: ReadonlySet<string> = new Set(TASK_STORE_RECEIVER_SHAPES.map((entry) => entry.shape));
const NON_TASK_STORE_KEYS: ReadonlySet<string> = new Set(NON_TASK_STORE_RECEIVERS.map((entry) => `${entry.module}::${entry.shape}`));

/** Normalised receiver shape: an unwrapped `this`/identifier property chain, `?.` folded into `.`. */
function receiverShape(expr: ts.Expression): string | undefined {
  expr = unwrapStoreExpr(expr);
  if (ts.isIdentifier(expr)) return expr.text;
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    const inner = receiverShape(expr.expression);
    return inner === undefined ? undefined : `${inner}.${expr.name.text}`;
  }
  return undefined;
}

/** Census text for a receiver that is not a simple chain (call results, element access, ...). */
function receiverCensusText(expr: ts.Expression, sf: ts.SourceFile): string {
  return receiverShape(expr) ?? unwrapStoreExpr(expr).getText(sf).replace(/\s+/g, "").replaceAll("?.", ".");
}

/**
 * Resolves a receiver to its root task-store shape, or undefined when it is not a reviewed task store.
 * Legacy shapes win over aliases so a `const store = this.store` never relabels legacy rows.
 */
function storeRoot(expr: ts.Expression, aliases: ReadonlyMap<string, string>, module: string): string | undefined {
  const shape = receiverShape(expr);
  if (shape === undefined || NON_TASK_STORE_KEYS.has(`${module}::${shape}`)) return undefined;
  if (LEGACY_STORE_SHAPES.has(shape)) return shape;
  return aliases.get(shape) ?? (TASK_STORE_SHAPE_SET.has(shape) ? shape : undefined);
}

function writerLabel(root: string, method: string): string {
  return LEGACY_STORE_SHAPES.has(root) ? `store.${method}` : `${root}.${method}`;
}

type FileScan = { callSites: DerivedCallSite[]; suspects: Suspect[]; observedNonStore: Set<string>; observedStoreShapes: Set<string> };

/** The single receiver-rule implementation shared by the production derivation and the test seam. */
function scanSourceFile(sf: ts.SourceFile, entry: string, writers: ReadonlySet<string>): FileScan {
  const callSites: DerivedCallSite[] = []; const suspects: Suspect[] = [];
  const observedNonStore = new Set<string>(); const observedStoreShapes = new Set<string>();
  const aliases = new Map<string, string>(); const paths: string[] = []; const ordinals = new Map<string, number>();
  const line = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const root = (expr: ts.Expression): string | undefined => {
    const resolved = storeRoot(expr, aliases, entry);
    if (resolved !== undefined) observedStoreShapes.add(resolved);
    return resolved;
  };
  const pushSite = (node: ts.CallExpression, writer: string): void => {
    const path = paths.join(">") || "<module>"; const key = `${path}::${writer}`; const ordinal = (ordinals.get(key) ?? 0) + 1; ordinals.set(key, ordinal);
    callSites.push({ callSiteId: `${entry}::${path}::${writer}::#${ordinal}`, callSiteFingerprint: fingerprint(node, sf), file: entry, enclosingSymbolPath: path, writer, ordinal, lineHint: line(node) });
  };
  // A local alias is provable only when it has one declaration and no later write. Keeping
  // this conservative turns reassignments into suspects instead of guessing their receiver.
  const writes = new Map<string, number>();
  const countWrites = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      writes.set(node.left.text, (writes.get(node.left.text) ?? 0) + 1);
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && ts.isIdentifier(node.operand)
      && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) {
      writes.set(node.operand.text, (writes.get(node.operand.text) ?? 0) + 1);
    }
    ts.forEachChild(node, countWrites);
  };
  countWrites(sf);
  const visit = (node: ts.Node): void => {
    let pushed: string | undefined;
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isVariableDeclaration(node)) && node.name && ts.isIdentifier(node.name)) { pushed = node.name.text; paths.push(pushed); }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const aliasRoot = root(node.initializer);
      if (aliasRoot !== undefined) {
        const declarationList = node.parent;
        const isConstOrLet = ts.isVariableDeclarationList(declarationList)
          && declarationList.flags !== ts.NodeFlags.None;
        if (isConstOrLet && (writes.get(node.name.text) ?? 0) === 0) aliases.set(node.name.text, aliasRoot);
        else suspects.push({ file: entry, line: line(node), text: node.getText(sf), reason: `non-single-assignment task-store alias ${node.name.text}` });
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && root(node.initializer) !== undefined) {
      for (const element of node.name.elements) {
        const name = element.name.getText(sf);
        const property = element.propertyName?.getText(sf) ?? name;
        if (writers.has(property)) suspects.push({ file: entry, line: line(node), text: node.getText(sf), reason: `destructured task-store writer ${property}` });
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && EXTRA_WRITERS.includes(callee.text as (typeof EXTRA_WRITERS)[number])) {
        pushSite(node, callee.text);
      } else if (ts.isIdentifier(callee) && writers.has(callee.text) && !NOT_A_DURABLE_WRITE[callee.text]) {
        suspects.push({ file: entry, line: line(node), text: node.getText(sf), reason: `unbound task-store writer identifier ${callee.text}` });
      }
      if (ts.isElementAccessExpression(callee) && root(callee.expression) !== undefined) suspects.push({ file: entry, line: line(node), text: node.getText(sf), reason: "computed task-store receiver" });
      if (ts.isPropertyAccessExpression(callee) && writers.has(callee.name.text)) {
        const storeShape = root(callee.expression);
        if (storeShape !== undefined) pushSite(node, writerLabel(storeShape, callee.name.text));
        else {
          const shape = receiverCensusText(callee.expression, sf);
          const nonStoreKey = `${entry}::${shape}`;
          if (NON_TASK_STORE_KEYS.has(nonStoreKey)) observedNonStore.add(nonStoreKey);
          else suspects.push({ file: entry, line: line(node), text: node.getText(sf), reason: `unreviewed task-store receiver shape ${shape}` });
        }
      }
    }
    ts.forEachChild(node, visit); if (pushed) paths.pop();
  }; visit(sf);
  return { callSites, suspects, observedNonStore, observedStoreShapes };
}

/*
FNXC:MergeReliability 2026-10-08-02:04:
KB-012: inventory identity is `callSiteId` + `callSiteFingerprint`; line position must never be persisted.
A persisted `lineHint` was a line pin in disguise: any unrelated edit above a merge-reachable write turned the
"rebuilds a current manifest" guard red. `DerivedCallSite.lineHint` stays for diagnostics only.
*/
/** Derived call-site fields that are persisted in the inventory manifest (never the diagnostic `lineHint`). */
export type PersistedCallSite = Omit<DerivedCallSite, "lineHint">;

/** Strip diagnostic-only fields so a manifest entry never carries a line pin. */
function toPersistedEntry<T extends PersistedCallSite & { lineHint?: number }>(entry: T): Omit<T, "lineHint"> {
  const { lineHint: _lineHint, ...persisted } = entry;
  return persisted;
}

export type InventoryEntry = PersistedCallSite & {
  owningEntryPoint: string;
  reachableDataStates: string[];
  axis1: string;
  axis1Evidence: string;
  axis2Provisional: string;
  axis2Final: string;
  observedInSuite: string;
  executionProof: string;
  followUpTaskId: string;
};
export type InventoryManifest = {
  inventoryStatus: string;
  scannedModules: string[];
  closureBoundary: Array<{ module: string; reason: string; followUpTaskId: string }>;
  writerSurface: string[];
  writerSurfaceSource: string;
  writerSurfaceClassification: SurfaceClassification[];
  entries: InventoryEntry[];
};

type ClosureScan = { callSites: DerivedCallSite[]; suspects: Suspect[]; observedNonStore: Set<string>; observedStoreShapes: Set<string>; scannedModules: string[]; closureBoundary: { module: string; reason: string }[]; writerSurface: string[]; writerSurfaceSource: string };

function scanMergeClosure(): ClosureScan {
  const surface = deriveDurableWriterSurface(); const closure = deriveMergeReachableModules(); const writers = new Set(surface.writers);
  const callSites: DerivedCallSite[] = []; const suspects: Suspect[] = [];
  const observedNonStore = new Set<string>(); const observedStoreShapes = new Set<string>();
  for (const entry of closure.modules) {
    const scan = scanSourceFile(source(resolve(ROOT, entry)), entry, writers);
    callSites.push(...scan.callSites); suspects.push(...scan.suspects);
    for (const key of scan.observedNonStore) observedNonStore.add(key);
    for (const shape of scan.observedStoreShapes) observedStoreShapes.add(shape);
  }
  return { callSites: callSites.sort((a, b) => a.callSiteId.localeCompare(b.callSiteId)), suspects, observedNonStore, observedStoreShapes, scannedModules: closure.modules, closureBoundary: closure.boundary, writerSurface: surface.writers, writerSurfaceSource: surface.source };
}

export function deriveMergeDurableWriteCallSites(): { callSites: DerivedCallSite[]; suspects: Suspect[]; scannedModules: string[]; closureBoundary: { module: string; reason: string }[]; writerSurface: string[]; writerSurfaceSource: string } {
  const { observedNonStore: _observedNonStore, observedStoreShapes: _observedStoreShapes, ...derived } = scanMergeClosure();
  return derived;
}

/**
 * FNXC:MergeDurableWriteInventory 2026-10-08-05:21:
 * KB-047 receiver census over the merge closure. `unreviewed` lists writer-named calls behind a receiver that is
 * in neither reviewed table; `staleNonStoreEntries` and `staleTaskStoreShapes` list reviewed entries that are no
 * longer observed, so the tables cannot silently outlive the code they describe.
 */
export function deriveReceiverCensus(): { unreviewed: Suspect[]; staleNonStoreEntries: string[]; staleTaskStoreShapes: string[] } {
  const scan = scanMergeClosure();
  return {
    unreviewed: scan.suspects.filter((suspect) => suspect.reason.startsWith("unreviewed task-store receiver shape ")),
    staleNonStoreEntries: [...NON_TASK_STORE_KEYS].filter((key) => !scan.observedNonStore.has(key)).sort(),
    staleTaskStoreShapes: [...TASK_STORE_SHAPE_SET].filter((shape) => !scan.observedStoreShapes.has(shape)).sort(),
  };
}

/**
 * Rejects a regeneration input that would conceal the two fail-closed derivation failures.
 * Exported so the guard can pin this contract without mutating the source tree.
 */
export function assertInventoryRegenerationInputs(input: { unclassified: string[]; suspects: Suspect[] }): void {
  if (input.unclassified.length > 0) throw new Error(`cannot regenerate inventory with unclassified TaskStore methods: ${input.unclassified.join(", ")}`);
  if (input.suspects.length > 0) throw new Error(`cannot regenerate inventory with unresolved durable-write receivers: ${input.suspects.map((suspect) => `${suspect.file}:${suspect.line}`).join(", ")}`);
}

function pendingInventoryEntry(site: DerivedCallSite): InventoryEntry {
  return {
    ...toPersistedEntry(site),
    owningEntryPoint: "indeterminate",
    reachableDataStates: ["unobservable:human classification required for new durable write"],
    axis1: "indeterminate",
    axis1Evidence: "pending: human classification required for newly derived durable write",
    axis2Provisional: "unresolved",
    axis2Final: "unresolved",
    observedInSuite: "unobservable:human classification required for new durable write",
    executionProof: "none:human classification required for new durable write",
    followUpTaskId: "pending:classify",
  };
}

/**
 * Rebuilds derivable inventory structure while carrying human lifecycle verdicts only by an exact
 * call-site identity. A new call site intentionally receives a red `pending:classify` sentinel.
 */
export function buildInventoryManifest(previous: InventoryManifest): InventoryManifest {
  const surface = deriveDurableWriterSurface();
  const derived = deriveMergeDurableWriteCallSites();
  assertInventoryRegenerationInputs({ unclassified: surface.unclassified, suspects: derived.suspects });
  const priorEntries = new Map(previous.entries.map((entry) => [entry.callSiteId, entry]));
  const priorBoundaries = new Map(previous.closureBoundary.map((entry) => [entry.module, entry]));
  return {
    inventoryStatus: previous.inventoryStatus,
    scannedModules: derived.scannedModules,
    closureBoundary: derived.closureBoundary.map((boundary) => ({
      ...boundary,
      followUpTaskId: priorBoundaries.get(boundary.module)?.followUpTaskId ?? "pending:classify",
    })),
    writerSurface: surface.writers,
    writerSurfaceSource: surface.source,
    writerSurfaceClassification: surface.classified,
    entries: derived.callSites.map((site) => {
      const prior = priorEntries.get(site.callSiteId);
      return prior ? toPersistedEntry({ ...prior, ...site }) : pendingInventoryEntry(site);
    }),
  };
}

/**
 * Test seam for direct receiver assertions. It runs the production `scanSourceFile` rules, not a regex:
 * any suspect (destructured, computed, unreviewed receiver) wins; otherwise a derived call site is provable.
 */
export function classifyReceiverForTest(code: string, module = "alias-fixture.ts"): "provable" | "suspect" {
  const sf = ts.createSourceFile(module, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const scan = scanSourceFile(sf, module, new Set(deriveDurableWriterSurface().writers));
  return scan.suspects.length === 0 && scan.callSites.length > 0 ? "provable" : "suspect";
}

/** Test seam exposing the suspects (with reasons) that the production receiver rules raise for a snippet. */
export function receiverSuspectsForTest(code: string, module = "alias-fixture.ts"): Suspect[] {
  const sf = ts.createSourceFile(module, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return scanSourceFile(sf, module, new Set(deriveDurableWriterSurface().writers)).suspects;
}
