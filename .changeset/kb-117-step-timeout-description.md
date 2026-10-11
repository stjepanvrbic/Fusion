---
"@runfusion/fusion": patch
---

summary: The workflow Step timeout description now says it limits AI-run steps; script steps keep a fixed 2-minute limit.
category: fix
dev: Script workflow steps and raw CLI workflow nodes share the engine constant `WORKFLOW_COMMAND_STEP_TIMEOUT_MS` (120000 ms) and never read `workflowStepTimeoutMs`. No runtime bound changed.
