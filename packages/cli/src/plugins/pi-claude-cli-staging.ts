import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Workspace modules the raw pi-claude-cli extension imports by relative path from outside its own package.
 * `from` is relative to the workspace `packages/` directory; `to` is the extension file it replaces when staged.
 *
 * FNXC:WindowsProcessLaunch 2026-10-07-19:34:
 * The published package ships pi-claude-cli as raw TypeScript under dist/pi-claude-cli, and imports there resolve only against the package's own tree and dependencies, never private `@fusion/*` packages.
 * The extension reaches core's shell-free launch and tree-kill seam through a one-line relative re-export; staging replaces that file with core's dependency-free module so the published tree is self-contained and runs the same code as the workspace.
 */
export const PI_CLAUDE_CLI_CORE_OVERLAYS = [
  { from: join("core", "src", "process", "windows-launch.ts"), to: join("src", "windows-launch.ts") },
] as const;

/** Copy the extension entry and sources into `destDir`, then overlay the core modules it re-exports. */
export function stagePiClaudeCliSources(packagesRoot: string, destDir: string): void {
  const srcDir = join(packagesRoot, "pi-claude-cli");
  mkdirSync(destDir, { recursive: true });
  cpSync(join(srcDir, "index.ts"), join(destDir, "index.ts"));
  cpSync(join(srcDir, "src"), join(destDir, "src"), { recursive: true });
  for (const overlay of PI_CLAUDE_CLI_CORE_OVERLAYS) {
    cpSync(join(packagesRoot, overlay.from), join(destDir, overlay.to));
  }
}
