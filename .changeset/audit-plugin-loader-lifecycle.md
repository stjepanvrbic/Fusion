---
"@runfusion/fusion": patch
---

summary: Plugin reload, rescan, uninstall, and hook failures now keep plugins scanned, bounded, and in an accurate state.
category: fix
dev: PluginLoader runs the aiScanOnLoad gate on reload/rescan, bounds each plugin's onLoad and hooks (new hookTimeoutMs/onLoadTimeoutMs options), unloads failed onLoad instances, keeps hook failures out of lifecycle state, appends PluginContext to onAgentRunStart/End, fixes a reload-stop-reload queue deadlock, and stops disabled or uninstalled plugins in every loader.
