---
"@runfusion/fusion": patch
---

summary: Automatic recovery now retries in place and parks a card visibly after one fresh retry instead of looping forever.
category: fix
dev: Recovery episodes are bounded (ladder, one reseed, ladder, failed park) with `auto-recovery:retry-budget-escalated` audit rows; executor retries stay in the WIP lane behind a guarded in-place re-dispatch that honors `nextRecoveryAt`; self-healing sweeps no longer report no-op rebounds as recoveries; every engine `moveTask` names its `moveSource`.
