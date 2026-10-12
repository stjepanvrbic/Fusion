---
"@runfusion/fusion": patch
---

summary: Review steps that fail without an error message now record a specific reason instead of "failed".
category: fix
dev: `describeFailure` (engine `errors/describe-failure.ts`) replaces the `err instanceof Error ? err.message : String(err)` idiom at the review session catch in `executeWorkflowStep` and the node-exception branches of `executeNodeWithRetries`; non-blank messages are unchanged.
