---
"@runfusion/fusion": minor
---

summary: Agents can now read and run commands outside their task worktree instead of having those tool calls refused.
category: feature
dev: Removes the pi tool path boundary (`wrapToolsWithBoundary`, bash command-target inspection, cwd fence) and the `fn_task_attach` worktree confinement; the system prompt instructs agents to keep changes in the worktree. `read-only-root` sessions still refuse write, edit and bash.
