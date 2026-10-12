---
"@runfusion/fusion": patch
---

summary: On Windows, the model picker no longer waits on a stuck search for the Hermes CLI.
category: fix
dev: The Hermes runtime plugin's `windows-binary-launch.ts` bounds the default `where` lookup at `WHERE_LOOKUP_TIMEOUT_MS` (2 s), kills the child at the bound, falls back to the bare binary, and does not cache a timed-out lookup as a miss.
