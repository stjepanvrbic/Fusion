---
"@runfusion/fusion": minor
---

summary: A branch whose work another landed task already carried now closes as landed instead of parking failed.
category: fix
dev: When the AI merge agent makes no commit and says the target already has the branch's work, two review passes check the claim against the branch diff; a confirmed claim finalizes as a no-op landing (`task:empty-merge-landed-claim-confirmed`), a disputed one keeps the park with both agents' statements. Adds the operator fallback `fn task close-landed <id> --reason` and `POST /tasks/:id/close-as-landed` (dashboard "Close as landed"), backed by `SelfHealingManager.closeEmptyMergeParkAsLanded` and recorded as `task:closed-as-landed`.
