---
"@runfusion/fusion": patch
---

summary: Task Detail now offers "Bypass failed review" for a required review gate that never ran.
category: fix
dev: Adds `GET /api/tasks/:id/bypass-review` backed by `TaskStore.getReviewBypassEligibility`, which shares one evaluator with the bypass mutation; the client-side eligibility predicate is removed and the menu item is now selectable.
