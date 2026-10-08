---
"@runfusion/fusion": patch
---

summary: Fix Windows cleanup deleting a live task checkout when its path was spelled differently, such as a short 8.3 name.
category: fix
dev: The active-session registry, idle-worktree liveness match and reap ownership proof compare paths by identity (`pathIdentityKey`/`isSamePath`/`isPathInside`); the reap ownership git probes are settled before deciding.
