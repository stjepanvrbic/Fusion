---
"@runfusion/fusion": patch
---

summary: Keep one running-agent slot free for merging so new executors can no longer starve approved cards.
category: fix
dev: Adds `ProjectAdmissionCoordinator.registerMergeLaneReservation`; execute/planning admission stops at limit-1 while merges are pending and the merge lane holds no slot.
