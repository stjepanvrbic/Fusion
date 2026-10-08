import { describe, it, expect } from "vitest";
import { validatePluginManifest as coreBarrelValidate } from "@fusion/core";
import { definePlugin, validatePluginManifest } from "../index.js";
import type { FusionPlugin, PluginUiContributionSurface } from "../../../core/src/plugins/plugin-types.js";
import type { TaskStore } from "../../../core/src/store.js";
import { validatePluginManifest as coreValidate } from "../../../core/src/plugins/plugin-types.js";

type AssertNever<T extends never> = T;
type NoStaleStructuredSurface = AssertNever<Extract<
  PluginUiContributionSurface,
  "settings-integration-card" | "onboarding-recommendation-card"
>>;

describe("Plugin SDK", () => {
  // ── definePlugin ────────────────────────────────────────────────────

  describe("definePlugin", () => {
    it("returns the input unchanged (identity function)", () => {
      const plugin = {
        manifest: {
          id: "test-plugin",
          name: "Test Plugin",
          version: "1.0.0",
        },
        state: "installed" as const,
        hooks: {},
        tools: [],
        routes: [],
      };

      const result = definePlugin(plugin);

      expect(result).toBe(plugin);
    });

    it("provides type narrowing for plugin definitions", () => {
      // This test verifies that definePlugin provides proper TypeScript inference
      const plugin = definePlugin({
        manifest: {
          id: "my-plugin",
          name: "My Plugin",
          version: "1.0.0",
          description: "A test plugin",
        },
        state: "installed",
        hooks: {
          onLoad: async (ctx) => {
            ctx.logger.info("Loaded!");
          },
        },
        tools: [
          {
            name: "my_tool",
            description: "A useful tool",
            parameters: {},
            execute: async (_params, _ctx) => ({
              content: [{ type: "text" as const, text: "Hello!" }],
            }),
          },
        ],
        routes: [],
      });

      expect(plugin.manifest.id).toBe("my-plugin");
      expect(plugin.manifest.name).toBe("My Plugin");
      expect(plugin.hooks.onLoad).toBeDefined();
      expect(plugin.tools).toHaveLength(1);
      expect(plugin.tools![0].name).toBe("my_tool");
    });

    it("works with minimal plugin definition", () => {
      const plugin = definePlugin({
        manifest: {
          id: "minimal",
          name: "Minimal",
          version: "0.1.0",
        },
        state: "installed",
        hooks: {},
        tools: [],
        routes: [],
      });

      expect(plugin.manifest.id).toBe("minimal");
    });

    it("preserves all plugin properties", () => {
      const plugin = definePlugin({
        manifest: {
          id: "full-plugin",
          name: "Full Plugin",
          version: "2.0.0",
          description: "A full-featured plugin",
          author: "Test Author",
          homepage: "https://example.com",
          fusionVersion: "1.0.0",
          dependencies: ["other-plugin"],
          settingsSchema: {
            apiKey: {
              type: "string" as const,
              required: true,
            },
          },
        },
        state: "installed",
        hooks: {
          onLoad: async () => {},
          onUnload: async () => {},
          onTaskCreated: async () => {},
          onTaskMoved: async () => {},
          onTaskCompleted: async () => {},
          onError: async () => {},
        },
        tools: [
          {
            name: "tool1",
            description: "Tool 1",
            parameters: {},
            execute: async () => ({ content: [] }),
          },
        ],
        routes: [
          {
            method: "GET" as const,
            path: "/status",
            handler: async () => ({ status: "ok" }),
            description: "Health check",
          },
        ],
      });

      expect(plugin.manifest.id).toBe("full-plugin");
      expect(plugin.manifest.description).toBe("A full-featured plugin");
      expect(plugin.manifest.author).toBe("Test Author");
      expect(plugin.manifest.homepage).toBe("https://example.com");
      expect(plugin.manifest.fusionVersion).toBe("1.0.0");
      expect(plugin.manifest.dependencies).toEqual(["other-plugin"]);
      expect(plugin.manifest.settingsSchema).toBeDefined();
      expect(plugin.hooks.onLoad).toBeDefined();
      expect(plugin.hooks.onUnload).toBeDefined();
      expect(plugin.hooks.onTaskCreated).toBeDefined();
      expect(plugin.hooks.onTaskMoved).toBeDefined();
      expect(plugin.hooks.onTaskCompleted).toBeDefined();
      expect(plugin.hooks.onError).toBeDefined();
      expect(plugin.tools).toHaveLength(1);
      expect(plugin.routes).toHaveLength(1);
    });
  });

  // ── Type exports ────────────────────────────────────────────────────

  describe("type exports", () => {
    it("exports PluginManifest type", () => {
      // This is a compile-time test - if types are exported correctly, this will compile
      const manifest: import("../../../core/src/plugins/plugin-types.js").PluginManifest = {
        id: "test",
        name: "Test",
        version: "1.0.0",
      };
      expect(manifest.id).toBe("test");
    });

    it("exports FusionPlugin type", () => {
      const plugin: FusionPlugin = {
        manifest: {
          id: "test",
          name: "Test",
          version: "1.0.0",
        },
        state: "installed",
        hooks: {},
        tools: [],
        routes: [],
      };
      expect(plugin.manifest.id).toBe("test");
    });

    it("exports CLI provider contract types", () => {
      const cliProvider: import("../../../core/src/plugins/plugin-types.js").CliProviderContribution = {
        providerId: "cursor-cli",
        displayName: "Cursor CLI",
        binaryName: "cursor-agent",
        providerType: "cli",
        statusRoute: "/providers/cursor-cli/status",
        authRoute: "/auth/cursor-cli",
      };
      expect(cliProvider.providerId).toBe("cursor-cli");
    });

    it("exports PluginContext type", () => {
      const ctx: import("../../../core/src/plugins/plugin-types.js").PluginContext = {
        pluginId: "test",
        taskStore: {} as unknown as TaskStore,
        settings: {},
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
        emitEvent: () => {},
      };
      expect(ctx.pluginId).toBe("test");
    });

    it("exports PluginUiSlotDefinition type", () => {
      // This is a compile-time test - if types are exported correctly, this will compile
      const slot: import("../../../core/src/plugins/plugin-types.js").PluginUiSlotDefinition = {
        slotId: "task-detail-tab",
        label: "Task Details",
        icon: "FileText",
        componentPath: "./components/TaskDetailTab.js",
      };
      expect(slot.slotId).toBe("task-detail-tab");
      expect(slot.label).toBe("Task Details");
      expect(slot.icon).toBe("FileText");
      expect(slot.componentPath).toBe("./components/TaskDetailTab.js");
    });

    it("PluginUiSlotDefinition icon is optional", () => {
      // This is a compile-time test - if types are exported correctly, this will compile
      const slot: import("../../../core/src/plugins/plugin-types.js").PluginUiSlotDefinition = {
        slotId: "header-action",
        label: "Header Action",
        componentPath: "./components/HeaderAction.js",
      };
      expect(slot.slotId).toBe("header-action");
      expect((slot as any).icon).toBeUndefined();
    });

    it("PluginUiSlotDefinition can be used in FusionPlugin", () => {
      // This verifies that PluginUiSlotDefinition can be used in the FusionPlugin interface
      const plugin: FusionPlugin = {
        manifest: {
          id: "test",
          name: "Test",
          version: "1.0.0",
        },
        state: "installed",
        hooks: {},
        tools: [],
        routes: [],
        uiSlots: [
          {
            slotId: "custom-tab",
            label: "Custom Tab",
            componentPath: "./components/CustomTab.js",
          },
        ],
      };
      expect(plugin.uiSlots).toHaveLength(1);
      expect(plugin.uiSlots![0].slotId).toBe("custom-tab");
    });
    it("PluginDashboardViewDefinition can be used in FusionPlugin", () => {
      const plugin: FusionPlugin = {
        manifest: { id: "test", name: "Test", version: "1.0.0" },
        state: "installed",
        hooks: {},
        tools: [],
        routes: [],
        dashboardViews: [
          { viewId: "graph", label: "Graph", componentPath: "./views/Graph.js", placement: "more" },
        ],
      };
      expect(plugin.dashboardViews).toHaveLength(1);
      expect(plugin.dashboardViews?.[0].viewId).toBe("graph");
    });

    it("exposes only normalized structured surface names", () => {
      const surface: PluginUiContributionSurface = "settings-config-section";
      expect(surface).toBe("settings-config-section");

      const compileGuard: NoStaleStructuredSurface | undefined = undefined;
      expect(compileGuard).toBeUndefined();
    });
  });

  // ── validatePluginManifest ───────────────────────────────────────────

  /*
  FNXC:PluginManifestValidation 2026-10-08-04:45:
  KB-034: these tests exercise the SDK export itself. The previous suite imported core's validator, so the SDK's id/name/version-only copy was never tested and accepted manifests the loader rejected.
  */
  describe("validatePluginManifest", () => {
    const base = { id: "demo-plugin", name: "Demo", version: "1.0.0" };

    it("is the loader's validator from @fusion/core, not a copy", () => {
      expect(validatePluginManifest).toBe(coreBarrelValidate);
      expect(validatePluginManifest).toBe(coreValidate);
    });

    const loaderRejected: Array<[string, Record<string, unknown>]> = [
      ["dependencies type", { dependencies: "x" }],
      ["dependencies entries", { dependencies: [""] }],
      ["settingsSchema type", { settingsSchema: { k: { type: "bogus" } } }],
      ["settingsSchema enum", { settingsSchema: { k: { type: "enum" } } }],
      ["settingsSchema array", { settingsSchema: { k: { type: "array" } } }],
      ["runtime", { runtime: {} }],
      ["skills", { skills: [{ skillId: "Bad" }] }],
      ["workflowSteps", { workflowSteps: [{ stepId: "s", name: "S", mode: "x" }] }],
      ["traits", { traits: [{ traitId: "t", name: "T", schemaVersion: 1, hooks: { guard: {} } }] }],
      ["workflowExtensions", { workflowExtensions: [{ extensionId: "e", name: "E", kind: "nope" }] }],
      ["promptSurfaces", { promptSurfaces: ["nope"] }],
      ["dashboardViews", { dashboardViews: [{ viewId: "v", label: "V" }] }],
      ["setup", { setup: { binaryName: "b", description: "d", channel: "alpha" } }],
    ];

    it.each(loaderRejected)("rejects a manifest with malformed %s exactly as the loader does", (_label, extra) => {
      const manifest = { ...base, ...extra };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result).toEqual(coreValidate(manifest));
    });

    it("rejects non-array dependencies with the loader's message", () => {
      expect(validatePluginManifest({ ...base, dependencies: "not-an-array" })).toEqual({
        valid: false,
        errors: ["dependencies must be an array"],
      });
    });

    it("accepts minimal and fully populated valid manifests", () => {
      expect(validatePluginManifest(base)).toEqual({ valid: true, errors: [] });
      expect(
        validatePluginManifest({
          ...base,
          dependencies: ["other-plugin"],
          settingsSchema: { mode: { type: "enum", enumValues: ["a"] }, tags: { type: "array", itemType: "number" } },
          runtime: { runtimeId: "demo-runtime", name: "Demo Runtime" },
          skills: [{ skillId: "demo-skill", name: "Demo Skill" }],
          workflowSteps: [{ stepId: "demo-step", name: "Demo Step", mode: "script" }],
          traits: [{ traitId: "demo-trait", name: "Demo Trait" }],
          workflowExtensions: [{ extensionId: "demo-ext", name: "Demo Ext", kind: "work-engine" }],
          promptSurfaces: ["reviewer"],
          dashboardViews: [{ viewId: "demo-view", label: "Demo", componentPath: "./view.js" }],
          setup: { binaryName: "demo", description: "Demo binary", channel: "stable" },
        }),
      ).toEqual({ valid: true, errors: [] });
    });

    it("rejects missing and non-object manifests with the loader's messages", () => {
      expect(validatePluginManifest(null)).toEqual({ valid: false, errors: ["Manifest is required"] });
      expect(validatePluginManifest(undefined)).toEqual({ valid: false, errors: ["Manifest is required"] });
      expect(validatePluginManifest([])).toEqual({ valid: false, errors: ["Manifest must be an object"] });
    });

    it("rejects empty required fields", () => {
      const result = validatePluginManifest({ id: "", name: "", version: "" });
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([
        "id is required and must be a non-empty string",
        "name is required and must be a non-empty string",
        "version is required and must be a non-empty string",
      ]);
    });

    it("accepts consecutive hyphens in the id, matching the loader slug rule", () => {
      expect(validatePluginManifest({ ...base, id: "a--b" })).toEqual({ valid: true, errors: [] });
    });
  });
});
