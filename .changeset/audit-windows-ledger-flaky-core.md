---
"@runfusion/fusion": patch
---

summary: Fix Windows worktree reservations failing with EPERM when several processes reclaim a dead owner's claim at once.
category: fix
dev: A transient EPERM/EACCES/EBUSY probe of the reservation claim directory now re-polls within the acquire timeout instead of throwing.
