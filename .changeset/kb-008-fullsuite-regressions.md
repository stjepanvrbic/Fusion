---
"@runfusion/fusion": patch
---

summary: Windows sandbox commands that time out or overflow now report termination correctly and leave no kill helper running.
category: fix
dev: NativeSandboxBackend reports exitCode null / signal SIGTERM for every backend-terminated run. superviseSpawn waitExit settles after its own async taskkill (5s bound). Session-registry and self-healing liveness compare path identity, so a live checkout's 8.3 short path still matches.
