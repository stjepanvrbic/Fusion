---
"@runfusion/fusion": patch
---

summary: Fix task Planner Chat briefly showing the top of a loaded conversation before jumping to the latest message.
category: fix
dev: Planner Chat anchors its transcript in a layout effect, in the same commit that renders loaded history, re-activation, or pinned streamed growth.
