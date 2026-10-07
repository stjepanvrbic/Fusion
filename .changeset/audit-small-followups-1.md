---
"@runfusion/fusion": patch
---

summary: Interrupting `fn task merge` no longer stops the database mid-cleanup or leaves its merge status and worktree behind.
category: fix
dev: `runTaskMerge` claims `claimEmbeddedPostgresSignalShutdown()` while its signal handlers are installed and waits up to `MERGE_SIGNAL_SETTLE_TIMEOUT_MS` for the aborted merge body before clearing the stamp and closing the store.
