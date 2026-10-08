---
"@runfusion/fusion": patch
---

summary: Project workers running in child-process isolation are now cleaned up when Fusion exits.
category: fix
dev: ChildProcessRuntime spawns its worker through `superviseSpawn` with the new `SUPERVISE_NO_LIFETIME_CAP` option exported from `@fusion/core`, replacing a raw `fork`.
