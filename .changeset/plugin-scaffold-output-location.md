---
"@runfusion/fusion": patch
---

summary: `fn plugin create` and `fn plugin new` now print a correct location when `--output` is an absolute path.
category: fix
dev: The scaffold success line prints the target relative to the working directory when it is inside it, otherwise the absolute path.
