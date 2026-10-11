---
"@runfusion/fusion": patch
---

summary: Stored workflow settings such as "Step timeout" and model lanes now apply to workflow steps and merge reviews.
category: fix
dev: The workflow graph run, post-task reflection capture, the executor model hot-swap, the usage-limit pauser and the AI merge reviewer now read the task's effective workflow settings (`mergeEffectiveSettings`) instead of raw project settings.
