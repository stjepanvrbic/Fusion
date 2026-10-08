---
"@runfusion/fusion": patch
---

summary: Landed merges waiting for post-merge verification no longer show as failed.
category: fix
dev: `finalizeTask` in merger-ai returns the shared finalizer's post-merge deferral for every caller instead of throwing; workspace landings forward it via `WorkspaceMergeResult.deferredPostMergeEvidence` so the merge pump treats it as a confirmed landing.
