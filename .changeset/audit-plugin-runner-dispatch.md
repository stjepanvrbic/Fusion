---
"@runfusion/fusion": patch
---

summary: Plugin tools keep their schemas and owners, and plugin routes respect each project's plugin enablement.
category: fix
dev: PluginRunner passes declared tool JSON Schemas through, binds tools to their owning plugin, and guards trait removal against live cards; createPluginRouter takes a per-request project scope and excludes reserved management paths.
