---
"@runfusion/fusion": patch
---

summary: A merge waiting in the merge queue no longer times out, and an interrupted merge is retried instead of parked failed.
category: fix
dev: The graph merge node's 30-minute bound is armed when the merge pump starts the attempt (`onMergeRunStarted`) and re-armed on a rebuild after the integration branch moves; the pump watchdog times one merge, not a whole drain pass; the bounded auto-merge retry re-requests an interrupted merge on the `mergeTransientRetryCount` budget.
