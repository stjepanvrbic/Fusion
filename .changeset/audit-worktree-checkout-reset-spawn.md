---
"@runfusion/fusion": patch
---

summary: Fix workspace Task Reset failing with a server error when a member repository folder no longer exists.
category: fix
dev: describeRegisteredWorktrees treats a missing root or a positive not-a-repository verdict as no registrations; the reset route reads the fallback path list lazily and maps WorktreeRegistrationUnknownError to 409.
