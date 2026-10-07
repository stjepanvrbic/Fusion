/*
FNXC:WindowsProcessLaunch 2026-10-07-19:34:
The Claude CLI provider launches and kills `claude` through core's shared shell-free launch and process-tree kill seam, not a private copy.
This extension ships as raw TypeScript whose imports resolve against the published package's dependencies, which exclude private `@fusion/*` packages, so it reaches core by relative path; the CLI build stages core's dependency-free module over this file.
*/
export { killProcessTree, resolveShellFreeLaunch } from "../../core/src/process/windows-launch.js";
