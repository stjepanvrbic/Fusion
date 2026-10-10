---
"@runfusion/fusion": patch
---

summary: Fix System panel "link local fn" on Windows: installs fn.exe with fn.cmd shims and removes them on switch-back.
category: fix
dev: Build/install child processes now launch shell-free via `resolveShellFreeLaunch` (`shell: false`); shim removal uses platform-aware path containment.
