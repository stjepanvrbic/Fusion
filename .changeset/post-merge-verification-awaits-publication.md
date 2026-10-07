---
"@runfusion/fusion": patch
---

summary: Post-merge verification no longer reruns hourly while the landed commit is unpublished; it waits and says why.
category: fix
dev: `resumeMissingPostMergeGate` probes the push remote before reseeding the built-in `post-merge-verification` gate, retries confirmed-merge push recovery when Push after merge is on, and otherwise logs once and emits `task:post-merge-gate-awaiting-publication` (deduped via `mergeDetails.publicationWait`).
