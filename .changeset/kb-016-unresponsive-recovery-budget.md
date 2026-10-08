---
"@runfusion/fusion": patch
---

summary: Agents that keep freezing mid-run are restarted a limited number of times, then parked as "retries exhausted".
category: fix
dev: Unresponsive heartbeat recovery now counts against the shared `heartbeatErrorRecovery` budget, aborts the run's controller before dispose, and releases a stalled run's start lock so the resume is not starved.
