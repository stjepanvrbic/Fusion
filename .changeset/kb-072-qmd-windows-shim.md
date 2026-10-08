---
"@runfusion/fusion": patch
---

summary: Indexed memory search now works on Windows when qmd is installed via npm or bun.
category: fix
dev: The core default qmd executor now routes every launch through `resolveShellFreeLaunch`, unwrapping `.cmd` shims without a shell.
