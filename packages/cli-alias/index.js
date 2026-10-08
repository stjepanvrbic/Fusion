#!/usr/bin/env node
// runfusion.ai — `fn` / `fusion` entry: forwards arguments verbatim so behavior
// matches the main CLI exactly (bare `fn` prints help). See launcher.js.
import { launch } from "./launcher.js";

await launch();
