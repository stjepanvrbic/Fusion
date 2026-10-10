---
"@runfusion/fusion": patch
---

summary: Fix Claude CLI sessions failing with "No conversation found with session ID" on their first turn.
category: fix
dev: pi-claude-cli chose `--resume` from the context length. It now checks the CLI's transcript store (`projects/*/<session>.jsonl`) and retries once in the other session mode when the CLI rejects the chosen one.
