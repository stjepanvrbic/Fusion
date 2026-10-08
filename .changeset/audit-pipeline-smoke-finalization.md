---
"@runfusion/fusion": patch
---

summary: Landed cards that finish through merge recovery are recorded as merged again in the activity log right away.
category: fix
dev: The merge-confirmed fast path emits task:merged directly after the completion move; its completion log line follows the emit.
