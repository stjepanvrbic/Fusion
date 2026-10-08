#!/usr/bin/env node
/*
FNXC:CliAlias 2026-10-08-04:35:
`runfusion.ai` / `runfusion` entry: with no arguments it launches `dashboard` on every platform.
This lives in its own bin file because npm's Windows cmd-shim runs `node <target>`, so the bin name is not visible in `argv[1]`, and npm env vars are absent for global shims.
`fn`/`fusion` use index.js and forward verbatim.
*/
import { launch } from "./launcher.js";

await launch({ defaultCommand: "dashboard" });
