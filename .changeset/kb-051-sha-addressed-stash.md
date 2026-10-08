---
"@runfusion/fusion": patch
---

summary: Merges and pulls no longer restore another session's stashed edits when worktrees stash concurrently.
category: fix
dev: New `packages/engine/src/merge/tagged-stash.ts` addresses stash entries by unique label then SHA (apply-by-SHA, SHA-verified drop with foreign-entry re-store); used by landSquash local sync, smartPull, experiment revert and dropAutostashBySha. `no-bare-git-stash.test.ts` bans `stash pop`/positional refs in engine and CLI code, and executor prompts forbid `git stash` in task worktrees.
