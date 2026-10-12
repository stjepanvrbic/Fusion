---
"@runfusion/fusion": patch
---

summary: Fewer helper processes on Windows merges; non-main default branches are now detected on Linux and macOS.
category: fix
dev: `merge/integration-branch.ts` launches its git reads through `execFile` / `execFileSync` with argument lists (5 s timeout, 1 MiB output bound), and `captureSingleCommitLandedMetadata` in `merger.ts` launches its two `git show` reads through `execFile` (120 s timeout, 2 MiB output bound). As a `/bin/sh` command string, `git for-each-ref --format=%(refname:short) <prefix>` was a syntax error at the parenthesis, so on POSIX hosts branch inference saw empty branch lists and fell back to `main` whenever settings named no branch and `origin/HEAD` was unset.
