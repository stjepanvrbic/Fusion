---
"@runfusion/fusion": patch
---

summary: Windows: the dashboard now accepts worktree and Task Reset paths spelled with 8.3 short folder names.
category: fix
dev: `resolveReadOnlyCommitGitDir`/`canonicalForCompare`, the registered-worktree allowlist in `git-worktree-safety.ts` (`assertWorktreePathSafe`, `isAuthorizedProjectOrRegisteredWorktreePath`), and the `POST /tasks/:id/reset` ownership, containment and root guards now compare through `@fusion/core` `isSamePath`/`isPathInside`/`pathIdentityKey`; `buildTaskResetWorktreePlan` deduplicates targets by path identity. `installCloudflared` stages each direct download in a private `fusion-cloudflared-*` temp directory instead of the fixed `/tmp/cloudflared`.
