---
"@runfusion/fusion": patch
---

summary: Reusing a task's worktree keeps it reserved until setup finishes and no longer reports a stray background error.
category: fix
dev: `acquirePinnedWorktree` now uses `return await` for the warm-reuse and renamed-branch rebind returns inside its reservation `try/finally`, so the path reservation is released only after reuse settles and a rejected reuse is never left without a handler.
