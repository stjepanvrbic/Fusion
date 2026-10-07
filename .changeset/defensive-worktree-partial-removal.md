---
"@runfusion/fusion": patch
---

summary: Half-deleted task worktrees left by a locked file on Windows are now cleaned up instead of blocking cards.
category: fix
dev: Defensive `removeWorktree` settles a git failure through the shared `worktree/remove-checkout.ts` seam (filesystem-proven residue only) and reports `classification: "partially-removed"` so callers clear their pointer; `removeDirectoryWithRetry` uses a ~10s exponential budget on win32; pinned rename-aside retries then deletes proven residue; AI-merge awaits bounded session disposal before clean-room cleanup; the startup orphan reaper reclaims unreferenced `.git`-less residue.
