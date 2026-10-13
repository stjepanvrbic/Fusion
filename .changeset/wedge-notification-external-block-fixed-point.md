---
"@runfusion/fusion": patch
---

summary: Frozen cards no longer rewrite their record every few seconds and now send one operator notice.
category: fix
dev: The task-wedge notification module adds `classifyExternalBlockFreeze` and `hasWedgeSubjectMovedOn`, shared by the wedge classifier and every moved-on check. Freezes with `externalBlock.autoResume` or `externalBlock.resumeRequest` are recovery-owned and open no wedge episode.
