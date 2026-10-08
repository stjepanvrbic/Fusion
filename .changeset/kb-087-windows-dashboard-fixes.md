---
"@runfusion/fusion": patch
---

summary: Fix System panel rebuild/update dependency install and dev-server script detection on Windows.
category: fix
dev: pnpm install now launches shell-free via resolveShellFreeLaunch; devserver-detect reads package.json directly instead of a quoted `node -e` shell.
