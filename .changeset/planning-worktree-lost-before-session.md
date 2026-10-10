---
"@runfusion/fusion": patch
---

summary: Planning no longer loses its new worktree to cleanup and re-acquires a removed worktree instead of exhausting retries.
category: fix
dev: The self-owned branch reclaim sweep treats planner-owned cards as live. A missing declared session boundary root now raises the canonical missing-worktree session-start failure, so planning, executor and review lanes route it to worktree re-acquisition; planning retries it once in place before spending its recovery budget and reuses a recorded worktree only when it is a usable checkout. A failed worktree dependency install now logs the tail of its stderr and stdout.
