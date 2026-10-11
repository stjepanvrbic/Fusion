---
"@runfusion/fusion": patch
---

summary: A finished agent run now has its last activity-log lines saved before it reports completion.
category: fix
dev: `AgentLogger` tracks the agent-log batches it starts and `flush()` waits for those in flight together with usage-event writes, concurrently, under the shared `FLUSH_DRAIN_TIMEOUT_MS` (2 000 ms) bound and fail-soft. A sink that throws synchronously is logged instead of rejecting `flush()`.
