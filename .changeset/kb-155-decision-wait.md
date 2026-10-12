---
"@runfusion/fusion": minor
---

summary: Let a task wait for an owner decision at a planned step, and stop explanation text from freezing a card.
category: feature
dev: `fn_task_done(outcome="blocked")` accepts `obstacle: "decision-required"` with `decision: { question, unblockCondition }` while a step headed `### Step N (decision-gate): Title` is open. The card freezes as `human-decision/DECISION_REQUIRED`, never resumes automatically, and resumes through Retry. `obstacle: "outside-worktree"` now requires `externalFailure: { cause, observedError }`. Fusion classifies `observedError` only and no longer reads `reason` for failure words.
