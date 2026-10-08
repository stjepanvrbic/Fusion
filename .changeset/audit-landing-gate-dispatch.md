---
"@runfusion/fusion": patch
---

summary: Landed cards no longer stall in review with a post-merge verification that never starts.
category: fix
dev: The post-merge deferral in finalizeProvenAutoMergeTask clears a leftover merge-active stamp on a merge-confirmed card and records mergeDetails.postMergeDeferral so repeated passes log once. The continuation drain keeps dispatching same-slot handoffs after a capacity rejection, and self-healing's stale-merge sweep clears confirmed-landing stamps in place.
