---
"@runfusion/fusion": patch
---

summary: Windows terminal support no longer loads native files from outside its staged folder.
category: security
dev: resolveBundledWindowsNativeRequest now rejects `..` escapes with the shared sep/isAbsolute containment idiom; the old win32 check compared against a two-backslash prefix.
