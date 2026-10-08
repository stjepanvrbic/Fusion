---
"@runfusion/fusion": patch
---

summary: Automatic moves that never named their source are now held to the forward-only lifecycle rule.
category: fix
dev: `resolveDirectionPolicySource(undefined)` now returns `"engine"`; abandoned mesh-lease recovery and agent canonical routing stay in place instead of stepping backward, and auto-triage routing names `moveSource: "engine"`.
