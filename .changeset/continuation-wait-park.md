---
"@runfusion/fusion": patch
---

summary: Planned cards waiting behind another card's files no longer stop every other card from reaching Plan Review or planning.
category: fix
dev: A continuation whose dispatch is held by the outer dependency or file-scope gate is parked `held` from the state the due poll saw (`settlePlanningContinuationDispatch` `dispatchedState`), instead of staying `runnable` and winning every planning-lane admission pass. The stranded-continuation sweep leaves a current blocker wait alone and re-queues it immediately once the card's blocker marker is gone (`waiting-on-blocker` / `wait-released`).
