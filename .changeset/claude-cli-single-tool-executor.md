---
"@runfusion/fusion": patch
---

summary: Fix Claude CLI sessions running some tool calls twice and showing the model two conflicting results.
category: fix
dev: pi-claude-cli now starts `claude` with `--tools=` and `--strict-mcp-config`, offers every pi tool through the schema-only MCP server, and stops the CLI only after it has recorded the acknowledgement for each tool call. MCP servers configured in Claude Code itself are no longer loaded; use the `mcpServers` setting.
