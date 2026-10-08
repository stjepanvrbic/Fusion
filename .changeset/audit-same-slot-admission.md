---
"@runfusion/fusion": patch
---

summary: Merges no longer stall on capacity when a running workflow waits for its own merge.
category: fix
dev: ProjectAdmissionCoordinator measures a candidate that already holds a reservation or is a claimed holder against occupancy without its own id; a reused reservation stays with its owner.
