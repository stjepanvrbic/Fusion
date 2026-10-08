---
"@runfusion/fusion": patch
---

summary: Desktop and mobile shells now carry the saved server token when connecting from onboarding or switching servers.
category: fix
dev: Shell handoff URLs use `?token=`; dashboard token capture keeps a legacy `?rt=` fallback (not on /remote-login).
