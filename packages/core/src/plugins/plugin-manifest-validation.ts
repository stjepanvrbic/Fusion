/**
 * FNXC:PluginManifestValidation 2026-10-08-04:45:
 * Single plugin manifest validator shared by the core plugin loader and the plugin SDK (KB-034).
 * The SDK previously shipped a hand-written copy that checked only id/name/version, so authors got "valid: true" and then "Invalid plugin manifest" at load.
 * This module must stay free of runtime dependencies (only the pure workflow-extension-types.js) because the CLI plugin-sdk runtime shim bundles it into the published SDK.
 * Do not import from ./plugin-types.js here: plugin-types.ts re-exports these symbols and derives its types from the exported constants.
 */

import type {
  WorkflowExtensionFallback,
  WorkflowExtensionKind,
} from "../workflows/workflow-extension-types.js";
import {
  WORKFLOW_EXTENSION_SCHEMA_VERSION,
} from "../workflows/workflow-extension-types.js";

const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
/** Prompt injection surfaces a plugin may declare; plugin-types.ts derives PluginPromptSurface from it. */
export const PROMPT_CONTRIBUTION_SURFACES = ["executor-system", "executor-task", "triage", "reviewer", "heartbeat"] as const;
/** Setup release channels; plugin-types.ts derives PluginSetupManifest.channel from it. */
export const SETUP_CHANNELS = ["stable", "beta", "nightly"] as const;

/** The restricted flag keys a plugin trait may not declare (R22, KTD-7). */
export const PLUGIN_TRAIT_RESTRICTED_FLAGS = ["complete", "archived"] as const;

/** The async-only hook points a plugin trait may declare (R22). The sync
 *  `guard` hook point is built-in-only and rejected at validation. */
export const PLUGIN_TRAIT_ALLOWED_HOOK_POINTS = [
  "gate",
  "onEnter",
  "onExit",
  "releaseCondition",
] as const;

/** The current plugin trait hook-descriptor schema version. */
export const PLUGIN_TRAIT_SCHEMA_VERSION = 1 as const;

/**
 * Validate one plugin trait contribution. Returns a list of human-readable
 * error strings (empty = valid). Mirrors the validation posture of
 * `validatePluginManifest`'s `workflowSteps` block: structural checks plus the
 * R22 restricted-capability checks (sync `guard` key, restricted flags) and the
 * required versioned `schemaVersion`.
 */
export function validatePluginTraitContribution(
  trait: unknown,
  index = 0,
): string[] {
  const errors: string[] = [];
  const prefix = `traits[${index}]`;
  if (!trait || typeof trait !== "object" || Array.isArray(trait)) {
    return [`${prefix} must be an object`];
  }
  const t = trait as Record<string, unknown>;

  if (!t.traitId || typeof t.traitId !== "string" || t.traitId.trim() === "") {
    errors.push(`${prefix}.traitId is required and must be a non-empty string`);
  } else if (!SLUG_PATTERN.test(t.traitId)) {
    errors.push(
      `${prefix}.traitId must be a valid slug (lowercase, alphanumeric, hyphens only, cannot start or end with hyphen)`,
    );
  }

  if (!t.name || typeof t.name !== "string" || t.name.trim() === "") {
    errors.push(`${prefix}.name is required and must be a non-empty string`);
  }

  // schemaVersion is required and must be the supported version (versioned
  // hook-descriptor extension contract).
  if (t.schemaVersion === undefined) {
    errors.push(`${prefix}.schemaVersion is required (versioned hook-descriptor schema)`);
  } else if (t.schemaVersion !== PLUGIN_TRAIT_SCHEMA_VERSION) {
    errors.push(
      `${prefix}.schemaVersion must be ${PLUGIN_TRAIT_SCHEMA_VERSION}; got ${String(t.schemaVersion)}`,
    );
  }

  // Restricted flags (R22): a plugin trait must not declare complete/archived.
  if (t.flags !== undefined) {
    if (typeof t.flags !== "object" || t.flags === null || Array.isArray(t.flags)) {
      errors.push(`${prefix}.flags must be an object`);
    } else {
      const flags = t.flags as Record<string, unknown>;
      for (const restricted of PLUGIN_TRAIT_RESTRICTED_FLAGS) {
        if (flags[restricted]) {
          errors.push(
            `${prefix}.flags.${restricted} is a restricted (built-in-only) flag and may not be declared by a plugin trait`,
          );
        }
      }
    }
  }

  // Hooks: async-only. A sync `guard` key is rejected (R22, KTD-2).
  if (t.hooks !== undefined) {
    if (typeof t.hooks !== "object" || t.hooks === null || Array.isArray(t.hooks)) {
      errors.push(`${prefix}.hooks must be an object`);
    } else {
      const hooks = t.hooks as Record<string, unknown>;
      if ("guard" in hooks) {
        errors.push(
          `${prefix}.hooks.guard is a sync (built-in-only) hook point and may not be declared by a plugin trait`,
        );
      }
      for (const [hookKind, descriptor] of Object.entries(hooks)) {
        if (hookKind === "guard") continue; // already reported
        if (!(PLUGIN_TRAIT_ALLOWED_HOOK_POINTS as readonly string[]).includes(hookKind)) {
          errors.push(
            `${prefix}.hooks.${hookKind} is not a recognized async hook point (allowed: ${PLUGIN_TRAIT_ALLOWED_HOOK_POINTS.join(", ")})`,
          );
          continue;
        }
        if (!descriptor || typeof descriptor !== "object") {
          errors.push(`${prefix}.hooks.${hookKind} must be an object`);
          continue;
        }
        const d = descriptor as Record<string, unknown>;
        if (d.mode !== "prompt" && d.mode !== "script") {
          errors.push(`${prefix}.hooks.${hookKind}.mode must be one of: prompt, script`);
        }
        if (d.mode === "script" && (typeof d.scriptName !== "string" || d.scriptName.trim() === "")) {
          errors.push(`${prefix}.hooks.${hookKind}.scriptName is required when mode is "script"`);
        }
        if (
          hookKind === "gate" &&
          d.gateMode !== undefined &&
          d.gateMode !== "blocking" &&
          d.gateMode !== "advisory"
        ) {
          errors.push(`${prefix}.hooks.gate.gateMode must be one of: blocking, advisory`);
        }
      }
    }
  }

  return errors;
}

const WORKFLOW_EXTENSION_KINDS: ReadonlySet<WorkflowExtensionKind> = new Set([
  "column-metadata",
  "move-policy",
  "work-engine",
  "node-handler",
  "verdict-provider",
  "merge-fact-provider",
]);

const WORKFLOW_EXTENSION_FALLBACKS: ReadonlySet<WorkflowExtensionFallback> = new Set([
  "degradeToDefault",
  "parkNeedsAttention",
  "failClosed",
]);

/**
 * Validate one full plugin workflow extension contribution. Discovery metadata
 * (`{ extensionId, name, kind }`) is validated in validatePluginManifest; runtime
 * contribution objects use this stricter check.
 */
export function validateWorkflowExtensionContribution(
  extension: unknown,
  index = 0,
): string[] {
  const errors: string[] = [];
  const prefix = `workflowExtensions[${index}]`;
  if (!extension || typeof extension !== "object" || Array.isArray(extension)) {
    return [`${prefix} must be an object`];
  }
  const e = extension as Record<string, unknown>;

  if (!e.extensionId || typeof e.extensionId !== "string" || e.extensionId.trim() === "") {
    errors.push(`${prefix}.extensionId is required and must be a non-empty string`);
  } else if (!SLUG_PATTERN.test(e.extensionId)) {
    errors.push(
      `${prefix}.extensionId must be a valid slug (lowercase, alphanumeric, hyphens only, cannot start or end with hyphen)`,
    );
  }

  if (!e.name || typeof e.name !== "string" || e.name.trim() === "") {
    errors.push(`${prefix}.name is required and must be a non-empty string`);
  }

  if (typeof e.kind !== "string" || !WORKFLOW_EXTENSION_KINDS.has(e.kind as WorkflowExtensionKind)) {
    errors.push(
      `${prefix}.kind must be one of: ${[...WORKFLOW_EXTENSION_KINDS].join(", ")}`,
    );
  }

  if (e.schemaVersion === undefined) {
    errors.push(`${prefix}.schemaVersion is required`);
  } else if (e.schemaVersion !== WORKFLOW_EXTENSION_SCHEMA_VERSION) {
    errors.push(
      `${prefix}.schemaVersion must be ${WORKFLOW_EXTENSION_SCHEMA_VERSION}; got ${String(e.schemaVersion)}`,
    );
  }

  if (typeof e.fallback !== "string" || !WORKFLOW_EXTENSION_FALLBACKS.has(e.fallback as WorkflowExtensionFallback)) {
    errors.push(
      `${prefix}.fallback must be one of: ${[...WORKFLOW_EXTENSION_FALLBACKS].join(", ")}`,
    );
  }

  if (e.configSchema !== undefined) {
    if (typeof e.configSchema !== "object" || e.configSchema === null || Array.isArray(e.configSchema)) {
      errors.push(`${prefix}.configSchema must be an object`);
    } else {
      const fields = (e.configSchema as { fields?: unknown }).fields;
      if (!Array.isArray(fields)) {
        errors.push(`${prefix}.configSchema.fields must be an array`);
      }
    }
  }

  return errors;
}

// ── Manifest Validation ──────────────────────────────────────────────

/**
 * Validate a plugin manifest.
 *
 * @returns Object with valid=true and empty errors array on success,
 *          or valid=false with descriptive error messages on failure.
 */
export function validatePluginManifest(manifest: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (manifest === null || manifest === undefined) {
    return { valid: false, errors: ["Manifest is required"] };
  }

  if (typeof manifest !== "object" || Array.isArray(manifest)) {
    return { valid: false, errors: ["Manifest must be an object"] };
  }

  const m = manifest as Record<string, unknown>;

  // Required fields
  if (!m.id || typeof m.id !== "string" || m.id.trim() === "") {
    errors.push("id is required and must be a non-empty string");
  } else if (!SLUG_PATTERN.test(m.id)) {
    errors.push("id must be a valid slug (lowercase, alphanumeric, hyphens only, cannot start or end with hyphen)");
  }

  if (!m.name || typeof m.name !== "string" || m.name.trim() === "") {
    errors.push("name is required and must be a non-empty string");
  }

  if (!m.version || typeof m.version !== "string" || m.version.trim() === "") {
    errors.push("version is required and must be a non-empty string");
  } else if (!/^\d+\.\d+\.\d+$/.test(m.version)) {
    errors.push("version must be a valid semver string (e.g., 1.0.0)");
  }

  // Optional: dependencies
  if (m.dependencies !== undefined) {
    if (!Array.isArray(m.dependencies)) {
      errors.push("dependencies must be an array");
    } else {
      const invalidDeps = m.dependencies.filter(
        (d) => typeof d !== "string" || d.trim() === "",
      );
      if (invalidDeps.length > 0) {
        errors.push("All dependencies must be non-empty strings");
      }
    }
  }

  // Optional: settingsSchema
  if (m.settingsSchema !== undefined) {
    if (typeof m.settingsSchema !== "object" || m.settingsSchema === null) {
      errors.push("settingsSchema must be an object");
    } else {
      const settingsSchema = m.settingsSchema as Record<string, unknown>;
      for (const [key, schema] of Object.entries(settingsSchema)) {
        if (!schema || typeof schema !== "object") {
          errors.push(`settingsSchema.${key} must be an object`);
          continue;
        }
        const setting = schema as Record<string, unknown>;
        if (!setting.type || !["string", "number", "boolean", "enum", "password", "array"].includes(setting.type as string)) {
          errors.push(`settingsSchema.${key}.type must be one of: string, number, boolean, enum, password, array`);
        }
        if (setting.type === "enum" && (!Array.isArray(setting.enumValues) || setting.enumValues.length === 0)) {
          errors.push(`settingsSchema.${key}.enumValues is required and must be a non-empty array when type is enum`);
        }
        if (setting.type === "array" && (!setting.itemType || !["string", "number"].includes(setting.itemType as string))) {
          errors.push(`settingsSchema.${key}.itemType is required and must be "string" or "number" when type is array`);
        }
      }
    }
  }

  // Optional: runtime manifest metadata validation
  if (m.runtime !== undefined) {
    if (typeof m.runtime !== "object" || m.runtime === null) {
      errors.push("runtime must be an object");
    } else {
      const runtime = m.runtime as Record<string, unknown>;

      // runtimeId is required
      if (!runtime.runtimeId || typeof runtime.runtimeId !== "string" || runtime.runtimeId.trim() === "") {
        errors.push("runtime.runtimeId is required and must be a non-empty string");
      } else if (!SLUG_PATTERN.test(runtime.runtimeId as string)) {
        errors.push("runtime.runtimeId must be a valid slug (lowercase, alphanumeric, hyphens only, cannot start or end with hyphen)");
      }

      // name is required
      if (!runtime.name || typeof runtime.name !== "string" || runtime.name.trim() === "") {
        errors.push("runtime.name is required and must be a non-empty string");
      }

      // version is optional but must be valid semver if provided
      if (runtime.version !== undefined) {
        if (typeof runtime.version !== "string") {
          errors.push("runtime.version must be a string");
        } else if (!/^\d+\.\d+\.\d+$/.test(runtime.version)) {
          errors.push("runtime.version must be a valid semver string (e.g., 1.0.0)");
        }
      }
    }
  }

  // Optional: plugin skill discovery metadata
  if (m.skills !== undefined) {
    if (!Array.isArray(m.skills)) {
      errors.push("skills must be an array");
    } else {
      for (const [index, skill] of m.skills.entries()) {
        if (!skill || typeof skill !== "object") {
          errors.push(`skills[${index}] must be an object`);
          continue;
        }
        const skillMeta = skill as Record<string, unknown>;
        if (!skillMeta.skillId || typeof skillMeta.skillId !== "string" || skillMeta.skillId.trim() === "") {
          errors.push(`skills[${index}].skillId is required and must be a non-empty string`);
        } else if (!SLUG_PATTERN.test(skillMeta.skillId)) {
          errors.push(`skills[${index}].skillId must be a valid slug (lowercase, alphanumeric, hyphens only, cannot start or end with hyphen)`);
        }
        if (!skillMeta.name || typeof skillMeta.name !== "string" || skillMeta.name.trim() === "") {
          errors.push(`skills[${index}].name is required and must be a non-empty string`);
        }
      }
    }
  }

  // Optional: plugin workflow step discovery metadata
  if (m.workflowSteps !== undefined) {
    if (!Array.isArray(m.workflowSteps)) {
      errors.push("workflowSteps must be an array");
    } else {
      for (const [index, step] of m.workflowSteps.entries()) {
        if (!step || typeof step !== "object") {
          errors.push(`workflowSteps[${index}] must be an object`);
          continue;
        }
        const stepMeta = step as Record<string, unknown>;
        if (!stepMeta.stepId || typeof stepMeta.stepId !== "string" || stepMeta.stepId.trim() === "") {
          errors.push(`workflowSteps[${index}].stepId is required and must be a non-empty string`);
        } else if (!SLUG_PATTERN.test(stepMeta.stepId)) {
          errors.push(`workflowSteps[${index}].stepId must be a valid slug (lowercase, alphanumeric, hyphens only, cannot start or end with hyphen)`);
        }
        if (!stepMeta.name || typeof stepMeta.name !== "string" || stepMeta.name.trim() === "") {
          errors.push(`workflowSteps[${index}].name is required and must be a non-empty string`);
        }
        if (stepMeta.mode !== undefined && (typeof stepMeta.mode !== "string" || !["prompt", "script"].includes(stepMeta.mode))) {
          errors.push(`workflowSteps[${index}].mode must be one of: prompt, script`);
        }
      }
    }
  }

  // Optional: plugin trait contributions (U8). Full contribution shapes (with
  // hooks/flags) validate via validatePluginTraitContribution; the discovery
  // metadata form (`{ traitId, name }`) validates structurally here.
  if (m.traits !== undefined) {
    if (!Array.isArray(m.traits)) {
      errors.push("traits must be an array");
    } else {
      for (const [index, trait] of m.traits.entries()) {
        if (!trait || typeof trait !== "object") {
          errors.push(`traits[${index}] must be an object`);
          continue;
        }
        const traitMeta = trait as Record<string, unknown>;
        // A full contribution carries schemaVersion/flags/hooks — validate it
        // fully. The discovery-metadata form (just traitId + name) is validated
        // structurally.
        if (traitMeta.schemaVersion !== undefined || traitMeta.hooks !== undefined || traitMeta.flags !== undefined) {
          errors.push(...validatePluginTraitContribution(traitMeta, index));
          continue;
        }
        if (!traitMeta.traitId || typeof traitMeta.traitId !== "string" || traitMeta.traitId.trim() === "") {
          errors.push(`traits[${index}].traitId is required and must be a non-empty string`);
        } else if (!SLUG_PATTERN.test(traitMeta.traitId)) {
          errors.push(`traits[${index}].traitId must be a valid slug (lowercase, alphanumeric, hyphens only, cannot start or end with hyphen)`);
        }
        if (!traitMeta.name || typeof traitMeta.name !== "string" || traitMeta.name.trim() === "") {
          errors.push(`traits[${index}].name is required and must be a non-empty string`);
        }
      }
    }
  }

  // Optional: workflow extension contributions. Full contribution shapes validate
  // through validateWorkflowExtensionContribution; discovery metadata uses the
  // lighter {extensionId, name, kind} form.
  if (m.workflowExtensions !== undefined) {
    if (!Array.isArray(m.workflowExtensions)) {
      errors.push("workflowExtensions must be an array");
    } else {
      for (const [index, extension] of m.workflowExtensions.entries()) {
        if (!extension || typeof extension !== "object") {
          errors.push(`workflowExtensions[${index}] must be an object`);
          continue;
        }
        const extensionMeta = extension as Record<string, unknown>;
        if (
          extensionMeta.schemaVersion !== undefined ||
          extensionMeta.fallback !== undefined ||
          extensionMeta.configSchema !== undefined
        ) {
          errors.push(...validateWorkflowExtensionContribution(extensionMeta, index));
          continue;
        }
        if (!extensionMeta.extensionId || typeof extensionMeta.extensionId !== "string" || extensionMeta.extensionId.trim() === "") {
          errors.push(`workflowExtensions[${index}].extensionId is required and must be a non-empty string`);
        } else if (!SLUG_PATTERN.test(extensionMeta.extensionId)) {
          errors.push(`workflowExtensions[${index}].extensionId must be a valid slug (lowercase, alphanumeric, hyphens only, cannot start or end with hyphen)`);
        }
        if (!extensionMeta.name || typeof extensionMeta.name !== "string" || extensionMeta.name.trim() === "") {
          errors.push(`workflowExtensions[${index}].name is required and must be a non-empty string`);
        }
        if (typeof extensionMeta.kind !== "string" || !WORKFLOW_EXTENSION_KINDS.has(extensionMeta.kind as WorkflowExtensionKind)) {
          errors.push(`workflowExtensions[${index}].kind must be one of: ${[...WORKFLOW_EXTENSION_KINDS].join(", ")}`);
        }
      }
    }
  }

  // Optional: prompt surface metadata
  if (m.promptSurfaces !== undefined) {
    if (!Array.isArray(m.promptSurfaces)) {
      errors.push("promptSurfaces must be an array");
    } else {
      for (const [index, surface] of m.promptSurfaces.entries()) {
        if (typeof surface !== "string" || !PROMPT_CONTRIBUTION_SURFACES.includes(surface as (typeof PROMPT_CONTRIBUTION_SURFACES)[number])) {
          errors.push(`promptSurfaces[${index}] must be one of: ${PROMPT_CONTRIBUTION_SURFACES.join(", ")}`);
        }
      }
    }
  }

  // Optional: top-level dashboard view metadata
  if (m.dashboardViews !== undefined) {
    if (!Array.isArray(m.dashboardViews)) {
      errors.push("dashboardViews must be an array");
    } else {
      for (const [index, view] of m.dashboardViews.entries()) {
        if (!view || typeof view !== "object") {
          errors.push(`dashboardViews[${index}] must be an object`);
          continue;
        }

        const dashboardView = view as Record<string, unknown>;

        if (!dashboardView.viewId || typeof dashboardView.viewId !== "string" || dashboardView.viewId.trim() === "") {
          errors.push(`dashboardViews[${index}].viewId is required and must be a non-empty string`);
        } else if (!SLUG_PATTERN.test(dashboardView.viewId)) {
          errors.push(`dashboardViews[${index}].viewId must be a valid slug (lowercase, alphanumeric, hyphens only, cannot start or end with hyphen)`);
        }

        if (!dashboardView.label || typeof dashboardView.label !== "string" || dashboardView.label.trim() === "") {
          errors.push(`dashboardViews[${index}].label is required and must be a non-empty string`);
        }

        if (
          !dashboardView.componentPath
          || typeof dashboardView.componentPath !== "string"
          || dashboardView.componentPath.trim() === ""
        ) {
          errors.push(`dashboardViews[${index}].componentPath is required and must be a non-empty string`);
        }

        if (
          dashboardView.placement !== undefined
          && (typeof dashboardView.placement !== "string" || !["primary", "overflow", "more"].includes(dashboardView.placement))
        ) {
          errors.push(`dashboardViews[${index}].placement must be one of: primary, overflow, more`);
        }
      }
    }
  }

  // Optional: setup manifest metadata
  if (m.setup !== undefined) {
    if (typeof m.setup !== "object" || m.setup === null) {
      errors.push("setup must be an object");
    } else {
      const setup = m.setup as Record<string, unknown>;
      if (!setup.binaryName || typeof setup.binaryName !== "string" || setup.binaryName.trim() === "") {
        errors.push("setup.binaryName is required and must be a non-empty string");
      }
      if (!setup.description || typeof setup.description !== "string" || setup.description.trim() === "") {
        errors.push("setup.description is required and must be a non-empty string");
      }
      if (setup.channel !== undefined && (typeof setup.channel !== "string" || !SETUP_CHANNELS.includes(setup.channel as (typeof SETUP_CHANNELS)[number]))) {
        errors.push(`setup.channel must be one of: ${SETUP_CHANNELS.join(", ")}`);
      }
      if (setup.defaultTimeoutMs !== undefined && (typeof setup.defaultTimeoutMs !== "number" || !Number.isFinite(setup.defaultTimeoutMs) || setup.defaultTimeoutMs <= 0)) {
        errors.push("setup.defaultTimeoutMs must be a positive finite number");
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
