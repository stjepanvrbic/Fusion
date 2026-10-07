---
"@runfusion/fusion": patch
---

summary: Windows timeouts, stops and cancels now end whole process trees, and npm-installed CLIs launch reliably.
category: fix
dev: superviseSpawn tree-kills with taskkill /T /F and bounds waits after a kill; new core killProcessTree and prepareNativeCommand; CLI-agent PTY sessions settle on every exit, keep Windows env essentials and resume with their original settings.
