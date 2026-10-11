---
"@runfusion/fusion": patch
---

summary: Automatic worktree cleanup now discards the merge gate's test bundle, so cards no longer get stuck retrying cleanup.
category: fix
dev: `REGENERABLE_IGNORED_REPO_PATHS` allowlists `packages/core/.gate-bundle` by exact repository path in the defensive-removal classifier.
