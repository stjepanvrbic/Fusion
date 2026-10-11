---
"@runfusion/fusion": patch
---

summary: Fix link-local fn on Windows so `fn` and `fusion` run by name in Git Bash.
category: fix
dev: The win32 link-local layout adds extensionless sh shims beside `fn.cmd`/`fusion.cmd`; use-global removes them only when they point into the local install.
