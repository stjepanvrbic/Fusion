---
"@runfusion/fusion": patch
---

summary: Keep project test mode project-only, stop concurrent settings saves losing changes, fix Windows secrets and attachments.
category: fix
dev: Project settings sections no longer write global keys; global settings share a cross-process lock; project config RMW locks its row; master.key uses an owner-only ACL on Windows; useTasks mutations are project-scoped; forceFresh dedupe and task:merged columns fixed.
