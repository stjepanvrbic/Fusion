---
"@runfusion/fusion": patch
---

summary: The mobile app now sets up its server connection on launch and opens your saved Fusion server.
category: fix
dev: The dashboard entry runs `@fusion/mobile/bootstrap` before React mounts inside a Capacitor WebView; also fixes release.mjs commit/publish integrity, the build cache, and Docker manifests.
