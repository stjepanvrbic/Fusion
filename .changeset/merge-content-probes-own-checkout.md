---
"@runfusion/fusion": patch
---

summary: A half-deleted task working copy no longer makes a reviewed card look changed and start another Code Review.
category: fix
dev: The checkout-status and review-diff probes now check `isOwnGitTopLevel` (`git rev-parse --show-toplevel` compared with `isSamePath`) before and after their git command, and return their existing unavailable results, the diff probe with reason `checkout-not-own-top-level`, when git would answer for an enclosing repository.
