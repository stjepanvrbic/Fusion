---
"@runfusion/fusion": patch
---

summary: Fix System panel "link local fn" on Windows failing when the installed fn is still running.
category: fix
dev: The local install is staged and swapped in with renames, rolled back on failure; an un-movable entry reports that fn is running.
