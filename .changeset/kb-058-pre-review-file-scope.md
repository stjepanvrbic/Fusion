---
"@runfusion/fusion": patch
---

summary: Out-of-scope merges now park before the AI review instead of after a full merge cycle.
category: fix
dev: landOneRepo runs a pre-review File Scope check on the mechanical squash (git merge-tree) before the clean room; refusals emit `merge:file-scope-violation` with `scopeCheckPhase:"pre-review"`. The post-review check is unchanged and remains the invariant of record.
