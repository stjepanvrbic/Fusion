---
"@runfusion/fusion": patch
---

summary: Retry on a blocked card queues its resume and starts it as soon as an agent slot is free.
category: fix
dev: Reverts the synchronous Retry admit; the task update that records the resume request kicks the continuation drain so admission clears the freeze within one tick.
