---
"@runfusion/fusion": patch
---

summary: `npx runfusion.ai` with no arguments now opens the dashboard on Windows instead of printing help.
category: fix
dev: runfusion.ai/runfusion bins now target runfusion.js (defaults to dashboard); fn/fusion keep index.js (verbatim). argv[1] basename sniffing removed.
