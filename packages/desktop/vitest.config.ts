import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { computeMaxWorkers } from "../core/src/__test-utils__/vitest-workers";

const maxWorkers = computeMaxWorkers();
const fusionAliases = {
  /*
  FNXC:VitestAliases 2026-07-30-13:10:
  Must precede the broader `@fusion/core` alias: Vite string aliases match by PREFIX, so that key
  rewrites this subpath to `index.ts/task-delete-attribution` and resolution fails. Reached here
  transitively — this project aliases `@fusion/dashboard`, and `app/api/client.ts` imports the
  browser-safe delete-attribution leaf.
  */
  "@fusion/core/column-roles": resolve(__dirname, "../core/src/column-roles.ts"),
  "@fusion/core/task-delete-attribution": resolve(__dirname, "../core/src/task-delete-attribution.ts"),
  /*
  FNXC:VitestAliases 2026-08-15-15:08:
  `@fusion/engine` (aliased below) imports the Node-only `@fusion/core/mcp-builtin-servers`
  subpath (FN-8926). Without this entry the broad `@fusion/core` prefix alias rewrites it to
  `index.ts/mcp-builtin-servers` and desktop's runtime-resolution test fails with ENOTDIR.
  Mirrors the same alias in engine/dashboard vitest configs.
  */
  "@fusion/core/mcp-builtin-servers": resolve(__dirname, "../core/src/config/mcp-builtin-servers.ts"),
  "@fusion/core": resolve(__dirname, "../core/src/index.ts"),
  "@fusion/dashboard": resolve(__dirname, "../dashboard/src/index.ts"),
  "@fusion/engine": resolve(__dirname, "../engine/src/index.ts"),
  "@fusion/plugin-sdk": resolve(__dirname, "../plugin-sdk/src/index.ts"),
  /*
  FNXC:VitestAliases 2026-10-11-16:16:
  `@fusion/dashboard` is aliased to source and statically imports these plugin entries; the plugin sources import `@fusion/plugin-sdk` (aliased above).
  Their export maps all point at dist/, which a fresh checkout does not have, so a direct `vitest run` of a dashboard-loading test would fail to resolve them.
  String aliases match by prefix, so a subpath key must stay above its package root key.
  */
  "@fusion-plugin-examples/droid-runtime/probe": resolve(__dirname, "../../plugins/fusion-plugin-droid-runtime/src/probe.ts"),
  "@fusion-plugin-examples/hermes-runtime": resolve(__dirname, "../../plugins/fusion-plugin-hermes-runtime/src/index.ts"),
  "@fusion-plugin-examples/openclaw-runtime": resolve(__dirname, "../../plugins/fusion-plugin-openclaw-runtime/src/index.ts"),
  "@fusion-plugin-examples/paperclip-runtime": resolve(__dirname, "../../plugins/fusion-plugin-paperclip-runtime/src/index.ts"),
  "@fusion-plugin-examples/cursor-runtime": resolve(__dirname, "../../plugins/fusion-plugin-cursor-runtime/src/index.ts"),
  "@fusion-plugin-examples/antigravity-runtime": resolve(__dirname, "../../plugins/fusion-plugin-antigravity-runtime/src/index.ts"),
  "@fusion-plugin-examples/grok-runtime": resolve(__dirname, "../../plugins/fusion-plugin-grok-runtime/src/index.ts"),
  // Probe and model discovery only, as in the dashboard lane: the full adapter pulls the ACP SDK.
  "@fusion-plugin-examples/claude-runtime": resolve(__dirname, "../../plugins/fusion-plugin-claude-runtime/src/probes-entry.ts"),
  "@fusion-plugin-examples/omp-runtime": resolve(__dirname, "../../plugins/fusion-plugin-omp-runtime/src/index.ts"),
  "@fusion-plugin-examples/roadmap/roadmap-suggestions": resolve(__dirname, "../../plugins/fusion-plugin-roadmap/src/roadmap-suggestions.ts"),
  "@fusion-plugin-examples/roadmap": resolve(__dirname, "../../plugins/fusion-plugin-roadmap/src/index.ts"),
};

export default defineConfig({
  resolve: {
    alias: fusionAliases,
  },
  test: {
    setupFiles: [resolve(__dirname, "../core/src/__test-utils__/vitest-setup.ts")],
    globalSetup: [resolve(__dirname, "../core/src/__test-utils__/vitest-teardown.ts")],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "threads",
    maxWorkers,
    minWorkers: 1,
    fileParallelism: true,
    passWithNoTests: true,
    projects: [
      {
        resolve: {
          alias: fusionAliases,
        },
        test: {
          name: "desktop",
          /*
          FNXC:DesktopTests 2026-10-11-13:29:
          Desktop package-script tests run in this project because Vitest is the desktop package's only test lane (package `test` script, CI Full Suite shards, changed-only `pnpm test`).
          They must be Vitest files: Vitest does not collect `node:test` cases.
          */
          include: ["src/__tests__/**/*.test.ts", "scripts/__tests__/**/*.test.ts"],
          pool: "threads",
          isolate: true,
        },
      },
      {
        resolve: {
          alias: fusionAliases,
        },
        test: {
          name: "desktop-renderer",
          include: ["src/renderer/**/*.test.ts", "src/renderer/**/*.test.tsx"],
          environment: "jsdom",
          isolate: true,
        },
      },
    ],
  },
});
