---
"@runfusion/fusion": patch
---

summary: Post-merge verification now waits for pending CI runs instead of rejecting and rechecks automatically for 8 hours.
category: fix
dev: Post-merge gates may return the post-merge-only `WAIT` verdict, recorded as the `awaiting-evidence` step status and rechecked on a 5/10/20/30-minute backoff; the 8-hour ceiling emits `task:post-merge-evidence-wait-exhausted`.
