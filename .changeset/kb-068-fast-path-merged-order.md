---
"@runfusion/fusion": patch
---

summary: Merged cards recovered by auto-merge record their merge in activity history immediately again.
category: fix
dev: The merge-confirmed fast path in ProjectEngine emits `task:merged` before its completion task-log write again; c839c4914 had put the awaited log write first, which reddened pipeline smoke S16/S17.
