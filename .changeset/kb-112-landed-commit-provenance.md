---
"@runfusion/fusion": patch
---

summary: Stop closing a task as merged when an older unrelated commit reuses its task number.
category: fix
dev: Self-healing `findLandedTaskCommit` and the merger's `findOwnedLandedCommitForTask` now accept a landed commit only on an accepted `assessLandedCommitProvenance` verdict. That needs a lineage trailer, descent from `baseCommitSha`, or, for any other candidate, a committer time not older than the task plus task-branch membership for subject-only hits.
