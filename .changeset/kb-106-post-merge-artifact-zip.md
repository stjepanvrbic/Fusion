---
"@runfusion/fusion": patch
---

summary: Post-merge verification can read GitHub artifact contents on Windows hosts without unzip installed.
category: fix
dev: `fn_post_merge_inspect` `github_artifact_contents` now parses the downloaded zip in memory with `node:zlib` (same 2 MB, 32-entry, entry-name and 30 s bounds); a missing `gh` or `git` reports `Inspection tool missing:` with `details.missingTool` instead of `Evidence unavailable:`.
