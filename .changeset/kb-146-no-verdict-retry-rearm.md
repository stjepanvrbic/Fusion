---
"@runfusion/fusion": patch
---

summary: Retrying a card stopped by the no-verdict review limit from the CLI or the retry tool now gives it fresh review tries.
category: fix
dev: Operator retries stamp `noVerdictBudgetRearmedAt` on failed verdict-less pre-merge review results; `hasExhaustedNoVerdictRecovery` and `hasExhaustedPlanReviewNoVerdictRecovery` count only attempts recorded after the newest stamped attempt. Review history is kept. Automatic sweeps never write the marker.
