---
"@runfusion/fusion": patch
---

summary: A card that recovery keeps refusing for the same reason no longer loses its activity history to repeated log lines.
category: fix
dev: `SelfHealingManager.rejectForeignAlreadyMergedCandidate` skips the log line and the `task:auto-recover-already-merged-rejected` row when the task's persisted log already ends its rejection history with the identical line.
