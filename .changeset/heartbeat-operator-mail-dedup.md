---
"@runfusion/fusion": patch
---

summary: Heartbeat agents stop re-sending the same unread report to operators and verify a requested action is possible first.
category: fix
dev: Heartbeat prompts list the agent's recent agent-to-user mail (24h, max 5, titles only); `fn_send_message` suppresses a normalized duplicate still unread within 6h; heartbeat Critical Rules require a feasibility/automation check before asking a human to act.
