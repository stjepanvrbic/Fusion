---
"@runfusion/fusion": patch
---

summary: Task detail now shows recommendations for landed cards in every lane where Insights and the mailbox offer Create task.
category: fix
dev: TaskDetailModal consumes GET /tasks/:id/recommendations/eligibility instead of a client copy of the rule.
