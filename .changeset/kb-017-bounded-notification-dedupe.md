---
"@runfusion/fusion": patch
---

summary: Long-running engines no longer grow memory remembering every sent notification.
category: fix
dev: NotificationService.notifiedEvents is now a 10,000-entry LRU with refresh-on-hit.
