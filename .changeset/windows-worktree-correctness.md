---
"@runfusion/fusion": patch
---

summary: On Windows, reused worktrees refresh to the latest base and drive-letter paths no longer bypass the worktree boundary.
category: fix
dev: `worktree-base-refresh` runs git with argv (no cmd.exe quoting); `bashCommandTargetsOutsideBoundary` inspects drive-qualified paths; rebind proof resolves git's `C:/` worktree paths before comparing.
