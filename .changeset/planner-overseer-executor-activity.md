---
"@runfusion/fusion": patch
---

summary: Planner overseer no longer reports an actively working task as stuck after two hours in progress.
category: fix
dev: The executor stall check measures silence since the last execution activity (the newest step status transition in the task log or the newest agent-log entry, never earlier than lane entry) instead of time since `columnMovedAt`. `updatedAt` is no longer an input, so overseer feed lines and steering comments cannot restart the stall clock. A stage that recovers after exhausting its recovery budget can escalate again. `plannerOverseerExecutorStuckAfterMs` must exceed the longest single command the executor runs.
