---
"@runfusion/fusion": patch
---

summary: An engine restart no longer parks approved review cards as failed merges; their merge resumes after the restart.
category: fix
dev: ProjectEngine rejects shutdown-time merge requests with a name-tagged `EngineShutdownError`; the merge node returns `engine-shutdown`, the graph failure handler and bounded retry leave the card untouched, and the in-review stall sweep no longer counts a failed park toward the deadlock threshold.
