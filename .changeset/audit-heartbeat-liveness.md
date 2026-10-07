---
"@runfusion/fusion": patch
---

summary: Durable agents no longer stall, double-run, lose unread mail, or move cards backward after heartbeat failures.
category: fix
dev: Rejection-neutral per-agent start lock; session-activity liveness with a 30s persisted cadence and an in-process live-run guard for the reapers; per-id message acknowledgement; in-place worktree-acquisition recovery under a live-row guard; one bounded model-unavailable park for every trigger source; shared timer eligibility at arm and dispatch; a scheduler lifecycle generation that stop() advances.
