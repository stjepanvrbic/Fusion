---
"@runfusion/fusion": patch
---

summary: Your project checkout now catches up after a merge even when it contains Fusion task worktrees.
category: fix
dev: syncWorktreeToHead skips nested repository entries (`dir/`) from `ls-files --others` instead of failing the snapshot.
