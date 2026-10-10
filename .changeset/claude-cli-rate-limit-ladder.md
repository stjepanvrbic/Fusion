---
"@runfusion/fusion": minor
---

summary: Retry Claude CLI rate limits in place (20 s, 45 s, 90 s) so account switchers like cswap can recover first.
category: feature
dev: `withRateLimitRetry` applies `CLAUDE_CLI_RATE_LIMIT_RETRY_DELAYS_MS` to failures marked by the pi-claude-cli provider, and workflow review steps and step reviews now use it for those failures. The provider reports the CLI's `api_error_status` so CLI limits classify as rate limits.
