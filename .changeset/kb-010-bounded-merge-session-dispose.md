---
"@runfusion/fusion": patch
---

summary: Merge helper agents now fully shut down before worktree cleanup, avoiding "Directory not empty" on Windows.
category: fix
dev: Autostash, complex-rebase, commit, verification-fix, and PR-response sessions await `disposeAgentSessionBounded`.
