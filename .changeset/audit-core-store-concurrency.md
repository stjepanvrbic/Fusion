---
"@runfusion/fusion": patch
---

summary: Stop concurrent task and agent writes from reverting each other's changes, and harden related store edges.
category: fix
dev: Task-row writes merge against the caller's read baseline under the per-task advisory lock (one key space now); updateTaskAtomic re-runs on conflict; agent writes lock and rebase; heartbeats write only timestamps. Also: lease renewal RETURNING and project scope, best-effort hard-cancel cleanup, Windows rename retry and non-fatal task.json mirror, archive-cleanup snapshot kept, rollback config row lock, run-audit prose removed, explicit "operator" move source and a moveSource census.
