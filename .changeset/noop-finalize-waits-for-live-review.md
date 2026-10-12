---
"@runfusion/fusion": patch
---

summary: No-change review tasks are no longer marked failed while their review is still running.
category: fix
dev: The self-healing no-op review finalize sweep skips cards with a live workflow run or an unrun required pre-merge gate, and its refusal parks wait out a review grace window and re-check liveness atomically.
