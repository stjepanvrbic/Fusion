---
"@runfusion/fusion": patch
---

summary: Plan Review failing without a verdict now stops after three retries and parks the card as failed with a reason.
category: fix
dev: The stranded-hold sweep reports the no-action reason `no-verdict-recovery-exhausted` and parks through `parkExhaustedRecovery` with owner `self-healing-plan-review-no-verdict`. Failed, verdict-less Plan Review results now record the plan identity in `reviewInputFingerprint`.
