---
"@runfusion/fusion": patch
---

summary: Indexed agent memory search now works on Windows when qmd is installed via npm or bun.
category: fix
dev: Core exports `runQmdCommand`; the engine's `refreshAgentMemoryQmdIndex` and `searchAgentMemoryWithQmd` launch qmd through it instead of an inline `execFile`.
