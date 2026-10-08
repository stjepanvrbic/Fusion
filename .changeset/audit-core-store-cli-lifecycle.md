---
"@runfusion/fusion": patch
---

summary: Treat automatic PR-merge completion as an engine move so lifecycle checks still apply.
category: fix
dev: finalizePullRequestMerge and finalizeNoOpMergeTask pass `{ moveSource: "engine", bypassGuards: false }` instead of "operator".
