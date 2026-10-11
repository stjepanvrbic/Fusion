import { buildDesktopVitestArgs } from "./test-args";
import { packageRoot, runWorkspaceBin } from "./workspace-tools";

/**
 * FNXC:TestInfrastructure 2026-10-11-16:42:
 * The desktop test lane builds nothing before vitest.
 * The desktop vitest config resolves the workspace packages and the dashboard's plugin imports from source, so every desktop test runs in a checkout with no dist.
 * The build helpers in workspace-tools serve the packaged-app build (scripts/build.ts); dist for other test lanes comes from scripts/ensure-test-artifacts.mjs.
 */
async function main(): Promise<void> {
  console.log("[desktop:test] Running desktop Vitest suite...");
  await runWorkspaceBin("vitest", buildDesktopVitestArgs(process.argv.slice(2)), packageRoot);
}

void main().catch((error) => {
  console.error("[desktop:test] Test run failed", error);
  process.exitCode = 1;
});
