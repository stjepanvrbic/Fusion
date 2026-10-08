---
"@runfusion/fusion": patch
---

summary: Plugin SDK validatePluginManifest now applies the same rules as the plugin loader.
category: fix
dev: The validator moved to the pure `packages/core/src/plugins/plugin-manifest-validation.ts` module; the SDK re-exports it from `@fusion/core` and the CLI plugin-sdk runtime shim re-exports it from core source, so no copy exists.
