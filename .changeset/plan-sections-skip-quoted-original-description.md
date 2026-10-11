---
"@runfusion/fusion": patch
---

summary: Plan sections and steps quoted in a task's original request are no longer read as the task's plan.
category: fix
dev: Every PROMPT.md section reader and writer locates through `listPlanHeadings` / `locatePlanSection` / `extractPlanSection` / `extractPlanSectionWithHeading` in `@fusion/core`, which skip the Original Description region; `matchStepHeadings` drops step headings inside it. Heading matching is now exact (case-sensitive, no trailing colon or prefix), and `plan-section-single-locator.test.ts` refuses new private locators.
