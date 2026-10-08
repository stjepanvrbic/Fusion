---
"@runfusion/fusion": patch
---

summary: Show native Windows paths for retained SQLite backups after the PostgreSQL migration.
category: fix
dev: defaultMigrationSources now uses node:path join; fn db migrate backup naming uses basename.
