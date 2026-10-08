---
"@runfusion/fusion": patch
---

summary: Approved merges no longer fail a false File Scope check, and a real scope refusal parks at once instead of re-merging.
category: fix
dev: File Scope bullet qualifiers ("(only if ...)") now apply to their own bullet only, and conditional non-changeset entries count as write scope. FileScopeViolationError is now terminal on every merge surface: the graph merge primitive and legacy seam return `file-scope-violation`, the sweep parks it before the conflict text check, and a workspace repository refusal rethrows instead of reporting a retryable partial land.
