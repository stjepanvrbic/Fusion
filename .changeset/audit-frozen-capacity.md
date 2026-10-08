---
"@runfusion/fusion": patch
---

summary: A card blocked on an outside obstacle no longer holds an agent slot, and rate-limited cards retry automatically.
category: fix
dev: Frozen external-block parks are excluded from the running-agent count and the WIP column budget but still count toward maxWorktrees; resumes re-enter project admission; RATE_LIMIT freezes auto-resume with 5/15/30/60/120/120 min backoff (six at most); migration 0089 adds external_block_auto_resume_count.
