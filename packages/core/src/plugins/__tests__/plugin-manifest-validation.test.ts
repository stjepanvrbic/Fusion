/*
FNXC:PluginManifestValidation 2026-10-08-04:45:
KB-034: the plugin manifest validator is one pure module shared by the core loader and the plugin SDK.
These tests pin identity of every re-export, the module's runtime-import purity (it is bundled into the published SDK), and the rule coverage the SDK now inherits.
*/
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as barrel from "@fusion/core";
import * as pluginTypes from "../plugin-types.js";
import * as shared from "../plugin-manifest-validation.js";

const validatePluginManifest = shared.validatePluginManifest;

const SLUG_ERROR = "must be a valid slug (lowercase, alphanumeric, hyphens only, cannot start or end with hyphen)";
const base = { id: "demo-plugin", name: "Demo", version: "1.0.0" };

describe("plugin-manifest-validation module", () => {
  it("is the single implementation re-exported by plugin-types and the core barrel", () => {
    for (const name of [
      "validatePluginManifest",
      "validatePluginTraitContribution",
      "validateWorkflowExtensionContribution",
      "PLUGIN_TRAIT_RESTRICTED_FLAGS",
      "PLUGIN_TRAIT_ALLOWED_HOOK_POINTS",
      "PLUGIN_TRAIT_SCHEMA_VERSION",
    ] as const) {
      expect(pluginTypes[name]).toBe(shared[name]);
      expect(barrel[name]).toBe(shared[name]);
    }
  });

  it("has no runtime imports beyond the pure workflow-extension-types module", () => {
    const source = readFileSync(fileURLToPath(new URL("../plugin-manifest-validation.ts", import.meta.url)), "utf8");
    const runtimeSpecifiers = [...source.matchAll(/^import\s+(?!type\b)[\s\S]*?from\s+["']([^"']+)["']/gm)].map((match) => match[1]);
    const dynamicImports = [...source.matchAll(/\bimport\(\s*["']([^"']+)["']/g)].map((match) => match[1]);
    const requires = [...source.matchAll(/\brequire\(\s*["']([^"']+)["']/g)].map((match) => match[1]);
    expect(runtimeSpecifiers.every((spec) => spec === "../workflows/workflow-extension-types.js")).toBe(true);
    expect(dynamicImports).toEqual([]);
    expect(requires).toEqual([]);
  });
});

describe("validatePluginManifest rule coverage", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["dependencies type", { dependencies: "x" }, "dependencies must be an array"],
    ["dependencies entries", { dependencies: [""] }, "All dependencies must be non-empty strings"],
    ["settingsSchema type", { settingsSchema: { k: { type: "bogus" } } }, "settingsSchema.k.type must be one of: string, number, boolean, enum, password, array"],
    ["settingsSchema enum", { settingsSchema: { k: { type: "enum" } } }, "settingsSchema.k.enumValues is required and must be a non-empty array when type is enum"],
    ["settingsSchema array", { settingsSchema: { k: { type: "array" } } }, 'settingsSchema.k.itemType is required and must be "string" or "number" when type is array'],
    ["runtime", { runtime: { name: "R" } }, "runtime.runtimeId is required and must be a non-empty string"],
    ["skills", { skills: [{ skillId: "Bad", name: "B" }] }, `skills[0].skillId ${SLUG_ERROR}`],
    ["workflowSteps", { workflowSteps: [{ stepId: "s", name: "S", mode: "x" }] }, "workflowSteps[0].mode must be one of: prompt, script"],
    ["traits full", { traits: [{ traitId: "t", name: "T", schemaVersion: 1, hooks: { guard: {} } }] }, "traits[0].hooks.guard is a sync (built-in-only) hook point and may not be declared by a plugin trait"],
    ["traits discovery", { traits: [{ traitId: "t" }] }, "traits[0].name is required and must be a non-empty string"],
    ["workflowExtensions full", { workflowExtensions: [{ extensionId: "e", name: "E", kind: "node-handler", schemaVersion: 1, fallback: "nope" }] }, "workflowExtensions[0].fallback must be one of: degradeToDefault, parkNeedsAttention, failClosed"],
    ["workflowExtensions discovery", { workflowExtensions: [{ extensionId: "e", name: "E", kind: "nope" }] }, "workflowExtensions[0].kind must be one of: column-metadata, move-policy, work-engine, node-handler, verdict-provider, merge-fact-provider"],
    ["promptSurfaces", { promptSurfaces: ["nope"] }, "promptSurfaces[0] must be one of: executor-system, executor-task, triage, reviewer, heartbeat"],
    ["dashboardViews", { dashboardViews: [{ viewId: "v", label: "V" }] }, "dashboardViews[0].componentPath is required and must be a non-empty string"],
    ["setup", { setup: { binaryName: "b", description: "d", channel: "alpha" } }, "setup.channel must be one of: stable, beta, nightly"],
  ];

  it.each(cases)("rejects malformed %s", (_label, extra, expectedError) => {
    expect(validatePluginManifest({ ...base, ...extra })).toEqual({ valid: false, errors: [expectedError] });
  });

  it("accepts a fully populated valid manifest", () => {
    const manifest = {
      ...base,
      description: "All blocks",
      dependencies: ["other-plugin"],
      settingsSchema: {
        mode: { type: "enum", enumValues: ["a", "b"] },
        tags: { type: "array", itemType: "string" },
        token: { type: "password" },
      },
      runtime: { runtimeId: "demo-runtime", name: "Demo Runtime", version: "1.2.3" },
      skills: [{ skillId: "demo-skill", name: "Demo Skill" }],
      workflowSteps: [{ stepId: "demo-step", name: "Demo Step", mode: "prompt" }],
      traits: [
        { traitId: "demo-trait", name: "Demo Trait" },
        { traitId: "gated-trait", name: "Gated", schemaVersion: 1, hooks: { gate: { mode: "prompt", gateMode: "advisory" } } },
      ],
      workflowExtensions: [
        { extensionId: "demo-ext", name: "Demo Ext", kind: "node-handler" },
        { extensionId: "full-ext", name: "Full Ext", kind: "move-policy", schemaVersion: 1, fallback: "failClosed", configSchema: { fields: [] } },
      ],
      promptSurfaces: ["executor-system", "triage"],
      dashboardViews: [{ viewId: "demo-view", label: "Demo", componentPath: "./view.js", placement: "overflow" }],
      setup: { binaryName: "demo", description: "Demo binary", channel: "beta", defaultTimeoutMs: 1000 },
    };
    expect(validatePluginManifest(manifest)).toEqual({ valid: true, errors: [] });
  });

  it("accepts ids with consecutive hyphens, matching the loader slug rule", () => {
    expect(validatePluginManifest({ ...base, id: "a--b" })).toEqual({ valid: true, errors: [] });
  });

  it("rejects missing and non-object manifests", () => {
    expect(validatePluginManifest(null)).toEqual({ valid: false, errors: ["Manifest is required"] });
    expect(validatePluginManifest(undefined)).toEqual({ valid: false, errors: ["Manifest is required"] });
    expect(validatePluginManifest([])).toEqual({ valid: false, errors: ["Manifest must be an object"] });
  });
});
