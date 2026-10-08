---
"@runfusion/fusion": patch
---

summary: Post-merge verification now recovers clean multi-repository checkouts to the landed commit without operator help.
category: fix
dev: The workspace post-merge admission in runGraphCustomNode runs `recoverCheckoutToLandedCommit` per repository against its recorded base branch; dirty or unrecoverable repositories still return `post-merge-checkout-missing-landed-commit` on the existing recheck ladder.
