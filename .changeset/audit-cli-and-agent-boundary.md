---
"@runfusion/fusion": patch
---

summary: Harden agent shell boundaries, skill installs and credential storage, and make task retry reliably re-queue cards.
category: security
dev: Bash containment and the worktree bash boundary handle native Windows path spellings; skill installs validate source/skill and spawn without a shell; auth.json writes are atomic and refuse a corrupt file; instance OAuth refresh is single-flight with a bounded request; fn task retry and fn_task_retry reset before moving and no longer park the card; PR-refresh cleanup unregisters its worktree on Windows.
