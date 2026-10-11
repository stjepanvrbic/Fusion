---
"@runfusion/fusion": patch
---

summary: Refinement and restored cards whose request quotes a file list are planned before they can run.
category: fix
dev: `refineTask` and archive restore now write seed prompts verbatim instead of File Scope sanitizing them, so `isUnplannedSeedPrompt` still recognizes them.
