---
"@runfusion/fusion": patch
---

summary: Signed webhooks work in daemon mode, mailbox pages older mail, and failed alerts and deliveries stay retryable.
category: fix
dev: Daemon auth now gates /api paths case-insensitively and exempts only POST webhook ingress. Message store adds countInbox/countOutbox and sendMessageUnlessDuplicate; fn_send_message gains a `changes` field. Wedge episodes carry deliveryOwed until acknowledged. New GET /api/tasks/:id/recommendations/eligibility.
