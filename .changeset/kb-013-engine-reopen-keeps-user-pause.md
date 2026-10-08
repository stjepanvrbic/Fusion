---
"@runfusion/fusion": patch
---

summary: Paused cards stay paused when automatic recovery or requeue sends them back to planning.
category: fix
dev: `applyResetOnEntryEffects`/`applyTimingEffects` now keep an operator pause (`holdsOperatorPause`) on every non-user move; `preservePause` is only needed for engine-owned parks.
