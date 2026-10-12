---
"@runfusion/fusion": patch
---

summary: Losing a saved-login file lock while it is in use now fails that one action instead of stopping the engine.
category: fix
dev: All three `auth.json` locks (credential write, OAuth refresh, instance login) are taken through one `withAuthFileLock` helper with an explicit `onCompromised`. A lock lost while held rejects its holder with `code: "ECOMPROMISED"`, an uncommitted credential write is refused, and a report that arrives after release is ignored. The lock renewal interval is 10 s (`update: 10_000`) so it no longer coincides with the 15 s OAuth refresh request timeout.
