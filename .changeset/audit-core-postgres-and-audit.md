---
"@runfusion/fusion": patch
---

summary: Embedded PostgreSQL shuts down cleanly on Windows and after Ctrl+C; run-audit no longer stores command or error text.
category: fix
dev: Lease generations keyed by postmaster identity; pg_ctl fast stop on win32; stale postmaster.pid requires a postgres image; CLI claims signal shutdown; central RunAuditor metadata sanitizer; sandbox audit ids/counts only; store:open restored; per-project legacy-adoption marker in project.__meta.
