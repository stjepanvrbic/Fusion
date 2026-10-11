---
"@runfusion/fusion": patch
---

summary: Fusion's already-landed check starts fewer helper processes on Windows.
category: performance
dev: `already-merged-detector.ts` runs its single git commands through `execFile` with argv (30 s bound each) and keeps the POSIX shell only for the two `git patch-id` pipelines. One detection computes the merge base once. AI merge reads each review fence's branch and integration tips in one `git rev-parse` process and derives the squash message body from one `git log` read.
