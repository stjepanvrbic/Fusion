# pi-claude-cli

A [pi](https://github.com/earendil-works/pi) extension that routes LLM calls through the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) as a subprocess. Use your Claude Pro/Max subscription as the LLM backend — no API key, no separate billing.

## How it works

The extension registers as a custom pi provider exposing all Claude models. Each request spawns a `claude -p` subprocess using the stream-json wire protocol, with `--resume` on follow-up turns to reuse the CLI's session state instead of replaying full history. Claude proposes tool calls, pi executes them natively. Custom pi tools are exposed to Claude via a schema-only MCP server.

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` on PATH)
- A Claude Pro or Max subscription
- [pi](https://github.com/earendil-works/pi) or [GSD](https://github.com/gsd-build/gsd-2)

## Installation

Add to `~/.gsd/agent/settings.json`:

```json
{
  "packages": ["npm:pi-claude-cli"]
}
```

Then select a Claude model via `/model` in the interactive UI. All Claude models appear under the `pi-claude-cli` provider.

## Features

- Streams text, thinking, and tool call tokens in real-time
- Runs the CLI without its own tools (`--tools=`, `--strict-mcp-config`), so pi is the only executor of a tool call
- Exposes every pi tool to Claude via MCP (schema-only; a call is acknowledged, never executed)
- Stops the CLI once it has recorded the acknowledgements, then resumes the session with pi's results
- Session resume via `--resume` eliminates history replay on follow-up turns
- Configurable thinking effort with elevated budgets for Opus models
- Cross-platform subprocess management (Windows, macOS, Linux)
- Inactivity timeout and process registry for cleanup

## License

MIT
