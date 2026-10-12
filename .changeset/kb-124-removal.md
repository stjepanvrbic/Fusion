---
"@runfusion/fusion": patch
---

summary: Remove an unused internal branch-lookup helper; merge and worktree behavior are unchanged.
category: internal
dev: Removes the `resolveIntegrationBranchSync` export of the private engine package and its synchronous git readers. No code in the CLI, dashboard, desktop app, plugin SDK, bundled plugins, docs or the published package's importable entries used it; every caller uses the async `resolveIntegrationBranch`. The synchronous-shellout allowlist no longer has rows for `merge/integration-branch.ts`.
