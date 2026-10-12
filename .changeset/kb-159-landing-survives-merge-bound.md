---
"@runfusion/fusion": patch
---

summary: A merge that has already advanced the target branch now always finishes or is recorded as landed.
category: fix
dev: The merge reports `onMergeLandingStarted` before each integration-ref advance and both graph merge bounds stop there; the merge body records the landing proof (`mergeConfirmed`, `commitSha`, `landedBranchTipSha`) right after the advance, outside the write fence; `isLandingSettled` defines a landed card, and pre-merge gates, the stale-content reroute and the merge door skip a settled card while the merge sweep never reroutes the card whose merge is running.
