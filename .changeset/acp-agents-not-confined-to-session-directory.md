---
"@runfusion/fusion": patch
---

summary: ACP and Claude runtime agents can read and write files outside their session directory; secrets and .git stay refused.
category: fix
dev: The ACP client fs handlers (ACP, Claude, Grok and OMP runtimes) drop the session-cwd jail; `path-jail.ts` becomes `path-deny-list.ts` with `resolveAllowedPath` / `openAllowedPath`, which keep the symlink-resolved secret and `.git/**` deny-list.
