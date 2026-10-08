---
"@runfusion/fusion": patch
---

summary: Windows checkout paths spelled with short 8.3 names (like RUNNER~1) are now recognized as the same folder.
category: fix
dev: External execution checkout inspection, review checkout routing, the workspace main-checkout guard, executor liveness, project-root store sharing, self-healing worktree-metadata and workspace-teardown sweeps, and AI-merge clean-room/push roots now canonicalize through `@fusion/core` `canonicalizePath` and compare with `isSamePath`/`isPathInside`/`pathIdentityKey` instead of JavaScript `realpathSync` plus raw string equality.
