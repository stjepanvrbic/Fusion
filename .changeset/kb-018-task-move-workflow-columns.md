---
"@runfusion/fusion": patch
---

summary: `fn task move` accepts custom workflow columns; stalled audit writes no longer block agent session start.
category: fix
dev: runTaskMove validates via resolveWorkflowIrForTask + workflowHasColumn (legacy COLUMNS fallback); session:runtime-resolved and fallback-engaged emits use emitBoundedRunAudit.
