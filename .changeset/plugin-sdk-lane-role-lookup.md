---
"@runfusion/fusion": minor
---

summary: Plugins can ask which lane role a column has, so lane guards work on boards with renamed columns.
category: feature
dev: The plugin SDK exports `taskColumnHasLaneRole(ctx.taskStore, taskId, columnId, role)`, `TASK_LANE_ROLES` and the `TaskLaneRole` and `TaskLaneRoleHost` types. The host answers through the new `TaskStore.taskColumnHasLaneRole` method. A host without the method yields the default board's column ids.
