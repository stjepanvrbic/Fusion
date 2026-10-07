---
"@runfusion/fusion": patch
---

summary: Record an audit entry when merge cleanup keeps a multi-repository task folder an agent session is still using.
category: fix
dev: `recordActiveSessionRefusalAudit` gains optional `repoRelPath` metadata; `landWorkspaceTask` threads its run auditor through `finalizeWorkspaceTask` into `cleanupLandedWorkspaceTaskWorktrees`, which now emits `worktree:removal-refused-active-session` via the bounded run-audit seam.
