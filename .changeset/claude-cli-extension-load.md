---
"@runfusion/fusion": patch
---

summary: Fix the Claude CLI provider failing to load, which left `pi-claude-cli` models unavailable.
category: fix
dev: The pi-claude-cli and droid-cli extensions imported `@earendil-works/pi-ai/utils/transcript`; Pi's extension loader aliases the bare pi-ai specifier to `dist/compat.js` by prefix, so the subpath resolved under `compat.js/`. They now import the helpers from the package root.
