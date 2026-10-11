---
"@runfusion/fusion": patch
---

summary: Agent runs now finish saving their session and tool activity before they report completion.
category: fix
dev: `AgentLogger` tracks the usage-event writes it issues and `flush()` waits for those in flight, bounded by `FLUSH_DRAIN_TIMEOUT_MS` (2 000 ms) and fail-soft. `emitAgentSessionStart` takes the lane's logger as a required second argument so the session boundary uses the same tracked path.
