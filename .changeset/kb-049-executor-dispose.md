---
"@runfusion/fusion": patch
---

summary: Restarting an engine in place no longer leaves the previous task runner reacting to task changes.
category: fix
dev: TaskExecutor.dispose() removes its store listeners and disposers; InProcessRuntime.stop() and executor replacement call it. The shared PG test harness now resets per-test listeners and offers trackDisposable.
