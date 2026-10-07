---
"@runfusion/fusion": patch
---

summary: Fix git refresh, branch evidence, revert and conflict checks silently failing on Windows.
category: fix
dev: Fusion-generated POSIX command strings now run under Git Bash on win32 via `withPosixShell`/`bindPosixShell` in `@fusion/core` (override with `FUSION_POSIX_SHELL`); operator-configured commands keep the native shell, and inferred verification commands are double-quoted on Windows.
