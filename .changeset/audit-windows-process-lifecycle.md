---
"@runfusion/fusion": patch
---

summary: Windows timeouts, stops and cancels now end whole process trees, and npm-installed CLIs launch reliably.
category: fix
dev: One core tree kill (killProcessTreeByPid; windows-launch killProcessTree wraps it); superviseSpawn tree-kills with taskkill /T /F and bounds waits after a kill; launches are unwrap-first via resolveShellFreeLaunch (now also unwraps Node's npx.cmd), so no user, agent or plugin text reaches cmd.exe; CLI-agent PTY sessions settle on every exit, use core's Windows env list and resume with their original settings.
