import type { TaskStore } from "@fusion/core";
import { classifyForeignOnlyContamination } from "../execution/branch-conflicts.js";
import type { AutoRecoveryContext, AutoRecoveryDecision, AutoRecoveryFailure, AutoRecoveryHandlers } from "../healing/auto-recovery.js";
import { createLogger, type Logger } from "../logger.js";
import { recoverForeignOnlyContamination } from "../recovery/foreign-only-contamination.js";
import { resolveIntegrationBranch } from "../merge/integration-branch.js";
import type { RunAuditor } from "../util/run-audit.js";

const baseLog = createLogger("auto-recovery:contamination");

export interface ContaminationRecoveryDeps {
  taskStore: TaskStore;
  runAudit: RunAuditor;
  logger?: Logger;
  repoDir: string;
  /** Arms the executor's guarded in-place re-dispatch once the contamination is repaired. */
  resumeInPlace: (taskId: string) => void;
}

export class ContaminationAutoRecoveryHandler implements Pick<AutoRecoveryHandlers, "issueRetry"> {
  constructor(private readonly deps: ContaminationRecoveryDeps) {}

  private get logger(): Logger {
    return this.deps.logger ?? baseLog;
  }

  async issueRetry(failure: AutoRecoveryFailure, decision: AutoRecoveryDecision, ctx: AutoRecoveryContext): Promise<void> {
    const task = ctx.task;
    if (task.userPaused) {
      this.logger.warn(`auto-recovery: skipped (userPaused) class=${failure.class} task=${task.id}`);
      return;
    }

    const ownCommits = Number(failure.evidence?.ownCommits ?? 0);
    const foreignAttributedCommits = Number(failure.evidence?.foreignAttributedCommits ?? 0);
    const maxRetries = ctx.settings.maxRetries ?? 3;

    if ((ownCommits > 0 && foreignAttributedCommits > 0) || ctx.retryCount >= maxRetries) {
      this.logger.warn(`auto-recovery: irreducible contamination reached retry path class=${failure.class} task=${task.id}`);
      await this.deps.runAudit.database({
        type: "contamination:irreducible-pause",
        target: task.id,
        metadata: {
          class: failure.class,
          rationale: decision.rationale,
          ownCommits,
          foreignAttributedCommits,
          retryCount: ctx.retryCount,
          maxRetries,
        },
      });
      return;
    }

    let recoveryKind: "default" | "foreign-only" = "default";
    let subtype: "reanchor" | "branch-discard" | undefined;

    if (ownCommits === 0 && foreignAttributedCommits > 0 && task.branch && task.worktree) {
      const integrationBranch = await resolveIntegrationBranch(
        this.deps.repoDir,
        ctx.settings as { integrationBranch?: string; baseBranch?: unknown },
      );
      const baseSha = task.baseCommitSha ?? task.baseBranch ?? task.executionStartBranch ?? integrationBranch;
      const classification = await classifyForeignOnlyContamination({
        repoDir: this.deps.repoDir,
        branchName: task.branch,
        baseSha,
        taskId: task.id,
      }).catch(() => null);

      if (classification && (classification.kind === "foreign-only-no-own-work" || classification.kind === "foreign-only-already-upstream")) {
        const recovered = await recoverForeignOnlyContamination(task, {
          repoDir: this.deps.repoDir,
          taskStore: this.deps.taskStore,
          runAudit: this.deps.runAudit,
          integrationBranch,
          resumeInPlace: this.deps.resumeInPlace,
        });
        if (recovered.recovered) {
          recoveryKind = "foreign-only";
          subtype = recovered.subtype;
        }
      }
    }

    if (recoveryKind === "default") {
      /*
      FNXC:LifecycleContainment 2026-10-07-18:04:
      Contamination recovery stays in the card's lane. The former contained move resolved to an
      in-place no-op under FN-217; the unpark below is the repair and the WIP lane is re-dispatched
      in place, since this handler runs while the executor still holds the task.
      */
      await this.deps.taskStore.updateTask(task.id, {
        paused: false,
        pausedReason: null,
        error: null,
      });
      this.deps.resumeInPlace(task.id);
    }

    await this.deps.runAudit.database({
      type: "contamination:retry-issued",
      target: task.id,
      metadata: {
        class: failure.class,
        rationale: decision.rationale,
        ownCommits,
        foreignAttributedCommits,
        retryCount: ctx.retryCount,
        recoveryKind,
        subtype,
      },
    });
  }
}
