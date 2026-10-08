---
"@runfusion/fusion": patch
---

summary: Fusion restarts its built-in database instead of retrying a database process that has exited.
category: fix
dev: `runningInstances` entries in embedded-lifecycle are owner-scoped and liveness-checked, an exit watch reports an unexpected postmaster exit, the exited-child stop guard is cross-platform (library `stop()` no longer hangs), and a refused join verify restarts once when the postmaster is proven dead.
