---
"@runfusion/fusion": patch
---

summary: Agents no longer show Running after a budget- or pause-skipped heartbeat.
category: fix
dev: completeRun restores running→active via AgentStore.updateAgentStateIfCurrent on skipStateTransition exits.
