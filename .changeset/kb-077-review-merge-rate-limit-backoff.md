---
"@runfusion/fusion": patch
---

summary: Review steps and AI merges that hit a provider rate limit now wait and retry automatically instead of failing.
category: fix
dev: New shared helper `packages/engine/src/external-block/provider-rate-limit-deferral.ts` reuses the external-block freeze/auto-resume budget; new run-audit event `task:provider-rate-limit-deferred`; `WorkflowStepResult.providerFailure` marker records the classified provider error.
