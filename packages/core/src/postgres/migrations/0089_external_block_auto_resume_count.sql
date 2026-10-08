-- FNXC:ExternalBlockAutoResume 2026-10-08-08:29: durable budget of automatic resumes for transient external-block freezes, so a restart or re-freeze cannot reset the bound.
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS external_block_auto_resume_count integer DEFAULT 0;
