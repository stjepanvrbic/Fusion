---
title: "Post-merge gate stuck on a half-deleted task worktree"
date: 2026-10-07
category: reliability
problem_type: reliability
module: "@fusion/engine"
component: post-landing-worktree-cleanup
tags:
  - worktree
  - post-merge
  - windows
  - cleanup
applies_when:
  - "a landed card stays In Review because post-merge verification fails with 'incomplete worktree'"
  - "the task log says 'Post-landing worktree cleanup preserved …: deliverable' but git no longer lists the worktree"
  - "changing post-landing cleanup or graph-node worktree acquisition"
symptoms:
  - "Refusing to start coding agent in incomplete worktree: …/.fusion/worktrees/<id>"
  - "required post-merge evidence gate 'post-merge-verification' is not approved"
---

# Post-merge gate stuck on a half-deleted task worktree

## Problem

KB-001 landed, but the card stayed In Review forever. Every `post-merge-verification` recheck failed in about 2 seconds with `Refusing to start coding agent in incomplete worktree`. The task log claimed `Post-landing worktree cleanup preserved .fusion/worktrees/kb-001: deliverable`, yet the branch had been deleted, `git worktree list` no longer showed the checkout, and the folder had no `.git` and only part of its files.

## Root cause

1. `cleanupLandedTaskWorktree` uses the defensive `CompletionLandedCleanup` reason, so `NativeWorktreeBackend.remove` runs `git worktree remove` without `--force` and rethrows any failure.
2. Git deletes the work tree recursively and then **continues** to delete the admin entry even when the work-tree deletion failed. On Windows a locked or undeletable file therefore leaves a half-deleted, `.git`-less, unregistered folder while git still exits non-zero (reproduced by hand: `failed to delete '…': Directory not empty`, registration gone, folder left).
3. The cleanup catch-all mapped every unknown error to `preserved-deliverable`, so it logged a false "preserved" and kept the task pointer. Branch deletion then succeeded because git no longer saw the branch checked out.
4. `runGraphCustomNode` re-acquired a recorded worktree only for Plan Review and only when the path was absent. The broken folder still passed `existsSync`, so every recheck reused it and failed in `assertValidWorktreeSession`.

## Fix (KB-003)

- **Truthful cleanup.** Cleanup classifies the checkout before and after removal. A failure that leaves the checkout gone reports `removed`. A failure that leaves it half-deleted or unregistered deletes the residue (bounded `removeDirectoryWithRetry`) only when this call's own removal crossed git's deletion boundary, then reports `removed` or `partially-removed`. A checkout that was already unusable before cleanup reports `residual-unusable` and is never deleted. All three clear the task pointer. `preserved-*` now means a usable, registered checkout really remains. `worktree:removal-partial` records the state with ids and fixed outcomes only.
- **Post-merge re-acquisition.** Post-merge nodes on landed cards treat an absent, `.git`-less, or unregistered recorded worktree as missing and acquire a fresh checkout at the integration branch. Pinned acquisition preserves the residue under `.fusion/recovery/worktrees/`, which is the operator's manual repair. The node verifies that the checkout contains the landed commit; a clean checkout without it is detached in place at the landed branch tip (per repository for workspace tasks), and only a dirty or unrecoverable checkout fails. Failures are recoverable node outcomes (`post-merge-checkout-unavailable`, `post-merge-checkout-missing-landed-commit`) that the normal recheck retries. Workspace members get the same treatment; a forced per-repository path that is unusable is preserved aside before recreation.
- No new self-healing sweep: auto-merge finalization, the project-engine merge-gate pump, self-healing rechecks, manual reconcile, and dashboard restart-stage all dispatch the gate through `runGraphCustomNode`.

## Prevention

- Never treat a non-zero `git worktree remove` as all-or-nothing. Re-probe with `classifyTaskWorktree` before reporting what happened.
- `existsSync` is not a liveness check for a worktree; use the shared classifier.
- Symptom coverage lives in `packages/engine/src/__tests__/post-merge-gate-unusable-worktree.test.ts` and `post-landing-worktree-partial-removal.test.ts`.

## Follow-up: every defensive removal path

KB-003 fixed only post-landing cleanup. The same half-deleted state was reachable from every other defensive removal (self-healing reclaim, pool prune, step-session cleanup, merger cleanup, pre-execution release), which kept their task pointer to the broken folder.

- `packages/engine/src/worktree/remove-checkout.ts` is the shared seam. `settleFailedCheckoutRemoval` decides what a failed removal left behind, using only async filesystem reads: `.git` absent or a dangling `gitdir:` pointer is residue; a live link, a `.git` directory, or an unreadable `.git` is never deleted.
- Defensive `removeWorktree` settles a git failure through that seam when the checkout carried `.git` and passed the content probe before removal. A proven partial removal returns `{ removed: true, classification: "partially-removed" }`, so existing callers clear their pointer, and emits `worktree:removal-partial`. A checkout that is still usable after the failure keeps the original throw.
- `removeDirectoryWithRetry` waits up to ~10s with exponential backoff on win32 (POSIX stays ~1s). The pinned preserve-aside rename uses the same backoff and, if it still fails, deletes filesystem-proven residue instead of failing acquisition forever.
- AI merge awaits bounded agent-session disposal before removing its clean room, and clean-room cleanup failures no longer replace a landed outcome.
- The startup orphan reaper reclaims `.git`-less residue only under a worktrees root inside the project, unregistered, older than 15 minutes, without secret material or a live session, and referenced by no task row (archived and soft-deleted included).
- Coverage: `worktree-defensive-partial-removal.test.ts`, `worktree-removal-retry.test.ts`, `worktree-acquisition.test.ts` (rename-aside), `merger-ai-session-dispose-order.test.ts`, `dispose-agent-session.test.ts`, `worktree-orphan-residue-reap.test.ts`.
