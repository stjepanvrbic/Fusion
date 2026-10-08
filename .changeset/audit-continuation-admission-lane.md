---
"@runfusion/fusion": patch
---

summary: Resumed review, verification, and post-merge steps now take a freed slot before new tasks start executing.
category: fix
dev: Workflow continuations register a `continuation:<projectId>` admission provider and take a role-derived lane (`resolveContinuationAdmissionLane`) instead of always `execute`.
