---
"@runfusion/fusion": patch
---

summary: Restore the audit record when merge cleanup keeps a worktree an agent session is still using.
category: fix
dev: `cleanupLandedTaskWorktree`'s live-session short-circuit (added by KB-003) again emits `worktree:removal-refused-active-session`, best-effort, with the removeWorktree metadata shape.
