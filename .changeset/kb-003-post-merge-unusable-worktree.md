---
"@runfusion/fusion": patch
---

summary: Landed cards no longer stick in In Review when worktree cleanup half-fails; post-merge checks rebuild a checkout.
category: fix
dev: Post-landing cleanup adds `partially-removed`/`residual-unusable` outcomes and the `worktree:removal-partial` audit; landed post-merge graph nodes re-acquire unusable recorded worktrees at the integration branch.
