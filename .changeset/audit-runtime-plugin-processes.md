---
"@runfusion/fusion": patch
---

summary: Fix runtime plugins on Windows and make session stop, task folders and test-run parameters behave correctly.
category: fix
dev: New core seam `resolveShellFreeLaunch`/`withPlatformBaseEnvKeys`/`killProcessTree` (re-exported by the plugin SDK and CLI core shim) unwraps npm/pnpm `.cmd` shims to the real executable or `node <entry>`, adds Windows base env keys to ACP allow-lists, and kills process trees with `taskkill /T`. Claude, Grok, OMP, ACP, Droid, OpenClaw, Paperclip CLI and agent-browser probes and sessions share it. The Claude bridge now launches its staged JS entry with node instead of a build-host `.cmd` wrapper. Droid consumes pi-ai's async stream, uses per-invocation prompt files, and honors the task cwd. Hermes, OpenClaw, Droid and Paperclip disposal aborts the active turn; Paperclip requests have deadlines. Printing Press runs generated CLIs with argv arrays instead of a shell string.
