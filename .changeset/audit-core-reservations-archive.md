---
"@runfusion/fusion": patch
---

summary: Fix unarchive losing task plans, Windows path aliases bypassing worktree locks, and stuck worktree reservations.
category: fix
dev: Adds the shared core path-identity helper (`isSamePath`, `isPathInside`, `pathIdentityKey`, `canonicalizePath`) and `renewMergeQueueLease` with a `leaseToken` release fence; reservation claims publish atomically and reclaim by generation; unarchive restores PROMPT.md and commits atomically; archive cleanup never fails a committed archive; the SQLite migrator reads TEXT past U+0000.
