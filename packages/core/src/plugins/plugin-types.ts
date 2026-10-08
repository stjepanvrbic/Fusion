/**
 * Plugin System Type Definitions for Fusion
 *
 * This module defines all types for the Fusion plugin system, including:
 * - PluginManifest: metadata and capability declaration
 * - Plugin hooks: lifecycle callbacks
 * - Plugin tools: AI agent tool definitions
 * - Plugin routes: custom dashboard API routes
 * - PluginContext: API surface available to plugins at runtime
 * - FusionPlugin: loaded plugin instance
 * - PluginInstallation: persisted plugin record
 */

import type { Database } from "../db/db.js";
import type { TaskStore } from "../store.js";
import type { McpServerDefinition, PlanningQuestion, Task, WorkflowStepMode, WorkflowStepToolMode } from "../types.js";
import type {
  WorkflowExtensionContribution,
  WorkflowExtensionMetadata,
} from "../workflows/workflow-extension-types.js";
import type { PROMPT_CONTRIBUTION_SURFACES, SETUP_CHANNELS } from "./plugin-manifest-validation.js";

// ── Plugin Manifest ───────────────────────────────────────────────────

/**
 * FNXC:PluginTaskStoreGate 2026-07-26-12:20:
 * Opt-in privilege declarations. Plugins receive a gated TaskStore by default:
 * destructive methods (deleteTask*, bypassFailedPreMergeReviewStep, archiveAllDone,
 * cleanupArchivedTasks) throw unless the manifest declares
 * `permissions: { destructiveTaskOps: true }`. See plugin-task-store-gate.ts.
 */
export interface PluginPermissions {
  /** Allow calling destructive TaskStore methods (delete/bypass/bulk-archive). */
  destructiveTaskOps?: boolean;
}

/**
 * Metadata and capability declaration for a plugin.
 */
export interface PluginManifest {
  /** Unique identifier (e.g., "fusion-plugin-slack") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Semver version string */
  version: string;
  /** Short description */
  description?: string;
  /** Author name or org */
  author?: string;
  /** URL to plugin docs/repo */
  homepage?: string;
  /** Minimum Fusion version required */
  fusionVersion?: string;
  /** IDs of other plugins this depends on */
  dependencies?: string[];
  /** Settings schema for validation */
  settingsSchema?: Record<string, PluginSettingSchema>;
  /** Optional agent runtime metadata for discovery (runtime factory is in FusionPlugin.runtime) */
  runtime?: PluginRuntimeManifestMetadata;
  /** Optional skill metadata used for discovery UIs. */
  skills?: Array<{ skillId: string; name: string }>;
  /** Optional workflow step metadata used for discovery UIs. */
  workflowSteps?: Array<{ stepId: string; name: string }>;
  /** Optional trait metadata used for discovery UIs (U8). */
  traits?: Array<{ traitId: string; name: string }>;
  /** Optional workflow extension metadata used for discovery UIs. */
  workflowExtensions?: WorkflowExtensionMetadata[];
  /** Prompt surfaces this plugin contributes to. */
  promptSurfaces?: PluginPromptSurface[];
  /** Setup metadata for plugin-managed binaries/runtimes. */
  setup?: PluginSetupManifest;
  /** Opt-in privilege declarations (see PluginPermissions). Absent = least privilege. */
  permissions?: PluginPermissions;
}

// ── Plugin Setting Schema ──────────────────────────────────────────────

export type PluginSettingType = "string" | "number" | "boolean" | "enum" | "password" | "array";

/**
 * Schema for a single plugin setting.
 */
export interface PluginSettingSchema {
  type: PluginSettingType;
  /** Human-readable label for UI */
  label?: string;
  description?: string;
  defaultValue?: unknown;
  required?: boolean;
  /** Only when type is "enum" */
  enumValues?: string[];
  /** Only when type is "string" - renders as textarea when true */
  multiline?: boolean;
  /** Optional UI grouping label used by settings forms */
  group?: string;
  /** Only when type is "array" - type of items in the array */
  itemType?: "string" | "number";
}

// ── Plugin Hooks ─────────────────────────────────────────────────────

/**
 * Options for creating an AI session from plugin runtime context.
 * This is a focused subset of engine agent options exposed to plugin authors.
 */
export interface CreateAiSessionOptions {
  /** Working directory for the agent session */
  cwd: string;
  /** System prompt for the agent */
  systemPrompt: string;
  /** Tool mode: "coding" for full tools, "readonly" for read-only */
  tools?: "coding" | "readonly";
  /** Default model provider (e.g., "anthropic") */
  defaultProvider?: string;
  /** Default model ID within the provider */
  defaultModelId?: string;
}

/**
 * Result returned from creating an AI session through PluginContext.
 */
export interface AiSessionResult {
  /** The underlying agent session — plugins call .prompt() on it */
  session: {
    prompt(text: string): Promise<void>;
    state: {
      messages: Array<{
        role: string;
        content?: unknown;
      }>;
    };
  };
  /** Path to persisted session file, if any */
  sessionFile?: string;
}

/**
 * Engine-injected factory for plugin AI sessions.
 */
export type CreateAiSessionFactory = (options: CreateAiSessionOptions) => Promise<AiSessionResult>;

// ── Interactive AI Sessions ───────────────────────────────────────────
//
// A generic interactive (multi-turn, await-input) AI session capability.
// Unlike the one-shot `createAiSession` above, an interactive session can
// pause mid-agent-turn on a structured question and resume when the caller
// supplies an answer. The host (engine) builds the prompt → parse → retry →
// pause → resume loop; the caller drives it by pulling events.
//
// The protocol is deliberately generic: the caller supplies a `systemPrompt`
// that instructs the agent to emit the JSON question/complete contract
// (the same shape used by `PlanningResponse`). The seam hardcodes no
// application-specific (e.g. compound-engineering) prompts or concepts.

/**
 * Options for creating an interactive AI session.
 * Mirrors {@link CreateAiSessionOptions}; the caller-supplied `systemPrompt`
 * is responsible for instructing the agent to emit the question/complete
 * JSON protocol that the seam parses.
 */
export interface CreateInteractiveAiSessionOptions {
  /** Working directory for the agent session */
  cwd: string;
  /** System prompt for the agent (must instruct it to emit the JSON protocol) */
  systemPrompt: string;
  /** Tool mode: "coding" for full tools, "readonly" for read-only */
  tools?: "coding" | "readonly";
  /** Default model provider (e.g., "anthropic") */
  defaultProvider?: string;
  /** Default model ID within the provider */
  defaultModelId?: string;
  /**
   * Skill names the session should load (matched against discovered skills).
   * Lets a plugin point a session at a specific bundled skill rather than
   * relying on cwd-only discovery. Forwarded to the engine's skill selection.
   */
  requestedSkillNames?: string[];
  /**
   * Extra directories to scan for skills (each holding `<id>/SKILL.md`), in
   * addition to the default cwd/agent-dir roots. A plugin that installs its
   * skills to a plugin-local directory passes that directory here so its
   * `requestedSkillNames` are actually discoverable in the live session.
   */
  additionalSkillPaths?: string[];
  /**
   * Live progress callback, invoked WHILE a turn runs (the pull-based
   * `nextEvent()` only resolves once the turn settles). Receives streaming
   * thinking/text deltas and tool start/end markers so a caller can surface
   * the agent's work in real time. Optional; ignored by factories that cannot
   * stream. Must not throw — implementations should swallow callback errors.
   */
  onProgress?: (event: InteractiveAiSessionProgressEvent) => void;
  /**
   * Trust the caller's persisted/current question id when answering, even if a
   * rehydrated live handle generated a different question id while replaying.
   * Default remains strict for fresh planning/CE sessions; recovery paths may
   * enable this when the persisted session row is the authoritative anchor.
   */
  allowAnswerQuestionIdDrift?: boolean;
}

/**
 * A live progress event emitted mid-turn via
 * {@link CreateInteractiveAiSessionOptions.onProgress}.
 *
 * - `thinking` / `text`: an incremental output DELTA (not a snapshot) — the
 *   consumer accumulates.
 * - `tool`: a discrete tool execution start/end marker.
 */
export type InteractiveAiSessionProgressEvent =
  | { type: "thinking"; delta: string }
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; phase: "start" | "end"; isError?: boolean };

/**
 * A single event pulled from an interactive AI session.
 *
 * Discriminated union on `type`:
 * - `thinking` / `text`: incremental agent output (data is a string).
 * - `question`: the agent paused awaiting structured input; the session is
 *   now in awaiting-input until {@link InteractiveAiSession.answer} is called.
 *   `data` is a {@link PlanningQuestion} (reused for protocol parity).
 * - `complete`: the agent finished; `data` is the final payload (shape is
 *   defined by the caller's protocol — opaque to the seam).
 * - `error`: an agent/session/parse error; `data` carries a human-readable
 *   message and optional error detail. The caller is never left hanging.
 */
export type InteractiveAiSessionEvent =
  | { type: "thinking"; data: string }
  | { type: "text"; data: string }
  | { type: "question"; data: PlanningQuestion }
  | { type: "complete"; data: unknown }
  | { type: "error"; data: { message: string; cause?: unknown } };

/**
 * An interactive, multi-turn AI session.
 *
 * Event delivery is **pull-based**: the caller awaits {@link nextEvent} to get
 * the next event. `nextEvent()` resolves once the session has produced an
 * event for the most recent `prompt`/`answer`. A `question` event leaves the
 * session in awaiting-input; the caller must call {@link answer} (not
 * {@link prompt}) to resume. After a `complete` or `error` event the session
 * is terminal and `nextEvent()` will keep returning that terminal event.
 *
 * (Pull-based `nextEvent()` is chosen over an async iterator because it is the
 * simpler shape to drive deterministically from a route/test: each turn is one
 * `prompt`/`answer` followed by one awaited `nextEvent`.)
 */
export interface InteractiveAiSession {
  /** Send a free-text turn to the agent (the opening turn, or follow-up text). */
  prompt(text: string): Promise<void>;
  /** Pull the next event produced by the most recent prompt/answer. */
  nextEvent(): Promise<InteractiveAiSessionEvent>;
  /** Answer the currently-awaiting question, resuming the agent. */
  answer(questionId: string, response: unknown): Promise<void>;
  /** Release the underlying agent/session handles. Safe to call repeatedly. */
  dispose(): void;
}

/**
 * Result returned from creating an interactive AI session.
 */
export interface CreateInteractiveAiSessionResult {
  /** The interactive session handle. */
  session: InteractiveAiSession;
  /** Path to persisted session file, if any. */
  sessionFile?: string;
}

/**
 * Engine-injected factory for plugin interactive AI sessions.
 */
export type CreateInteractiveAiSessionFactory = (
  options: CreateInteractiveAiSessionOptions,
) => Promise<CreateInteractiveAiSessionResult>;

/**
 * Context object passed to plugins at runtime.
 * Contains task store access, settings, logging, and event emission.
 */
export interface PluginContext {
  pluginId: string;
  /** Read-only access to task data */
  taskStore: TaskStore;
  /** Plugin's own settings */
  settings: Record<string, unknown>;
  /** Structured logger */
  logger: PluginLogger;
  /** Emit custom events */
  emitEvent: (event: string, data: unknown) => void;
  /** Engine-injected AI session factory (undefined when engine is not loaded) */
  createAiSession?: CreateAiSessionFactory;
  /**
   * Engine-injected interactive (multi-turn, await-input) AI session factory.
   * Undefined when the engine is not loaded or on non-route contexts (parity
   * with `createAiSession`).
   */
  createInteractiveAiSession?: CreateInteractiveAiSessionFactory;
  /** Optional host capability to resolve a project-scoped TaskStore by projectId. */
  resolveProjectTaskStore?: (projectId: string) => Promise<TaskStore>;
}

/**
 * Structured logger interface for plugins.
 */
export interface PluginLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

/** Lifecycle hook: called when plugin is loaded */
export type PluginOnLoad = (ctx: PluginContext) => Promise<void> | void;
/** Lifecycle hook: called when plugin is unloaded */
export type PluginOnUnload = (ctx: PluginContext) => Promise<void> | void;
/** Lifecycle hook: called during database schema initialization */
export type PluginOnSchemaInit = (db: Database) => Promise<void> | void;
/**
 * Declarative PostgreSQL schema owned by a plugin.
 *
 * FNXC:PluginPostgresContract 2026-07-14-18:32:
 * PostgreSQL plugins declare idempotent project-schema DDL without receiving
 * the host's privileged migration connection. Fusion validates this immutable
 * plan before onLoad and executes it through a short-lived migration-only
 * capability, keeping ordinary plugin runtime code on the forced-RLS role.
 *
 * FNXC:PluginPostgresContract 2026-07-14-22:42:
 * ALTER TABLE is intentionally limited to adding ordinary columns or setting
 * their defaults/nullability. Fusion alone owns project_id, keys, RLS,
 * policies, triggers, grants, ownership, and table identity.
 */
export interface PluginPostgresSchemaDefinition {
  /** Monotonically increasing plugin schema version for diagnostics. */
  version: number;
  /** Stable snake_case namespace prefix for every referenced table (must end in `_`). */
  tablePrefix: string;
  /** One idempotent CREATE TABLE/INDEX or host-approved additive ALTER TABLE statement per item. */
  statements: readonly string[];
}
/** PostgreSQL-native schema hook. It receives no database handle. */
export type PluginOnPostgresSchemaInit = () => PluginPostgresSchemaDefinition;
/** Lifecycle hook: called when a task is created */
export type PluginOnTaskCreated = (task: Task, ctx: PluginContext) => Promise<void> | void;
/** Lifecycle hook: called when a task moves between columns */
export type PluginOnTaskMoved = (task: Task, fromColumn: string, toColumn: string, ctx: PluginContext) => Promise<void> | void;
/** Lifecycle hook: called when a task is completed */
export type PluginOnTaskCompleted = (task: Task, ctx: PluginContext) => Promise<void> | void;
/** Lifecycle hook: called when an error occurs */
export type PluginOnError = (error: Error, ctx: PluginContext) => Promise<void> | void;
/** Lifecycle hook: called when an agent session begins running for a task. */
export type PluginOnAgentRunStart = (taskId: string, ctx: PluginContext) => Promise<void> | void;
/** Lifecycle hook: called when an agent session ends for a task. */
export type PluginOnAgentRunEnd = (taskId: string, ctx: PluginContext) => Promise<void> | void;

// ── Plugin Tools ─────────────────────────────────────────────────────

/**
 * Tool registration for AI agents.
 * Tools are prefixed with "plugin_" at runtime.
 */
export interface PluginToolDefinition {
  /** Tool name (prefixed with "plugin_" at runtime) */
  name: string;
  /** Description for the AI agent */
  description: string;
  /** TypeBox-style parameter schema */
  parameters: Record<string, unknown>;
  execute: (params: Record<string, unknown>, ctx: PluginContext) => Promise<PluginToolResult>;
}

/**
 * Result returned by a plugin tool execution.
 */
export interface PluginToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details?: Record<string, unknown>;
}

// ── Plugin Routes ────────────────────────────────────────────────────

export type PluginRouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Custom dashboard API route definition.
 */
export interface PluginRouteResponse {
  status: number;
  body?: unknown;
  /** Optional response headers to set on the outgoing HTTP response. */
  headers?: Record<string, string>;
  /** Optional explicit content type; when set, body is sent without JSON serialization. */
  contentType?: string;
}

export type PluginRouteResult = unknown | PluginRouteResponse;

export interface PluginRouteDefinition {
  method: PluginRouteMethod;
  /** Relative path under /api/plugins/:pluginId/ */
  path: string;
  handler: (req: unknown, ctx: PluginContext) => Promise<PluginRouteResult>;
  description?: string;
}

// ── Plugin UI Slots ─────────────────────────────────────────────────

/**
 * Host-defined dashboard UI surfaces that plugins can contribute to.
 * Existing generic surfaces remain supported for backward compatibility.
 */
export type PluginUiSurface =
  | "header-action"
  | "task-detail-tab"
  | "task-card-badge"
  | "board-column-footer"
  | "settings-section"
  | "settings-provider-card"
  | "settings-integration-card"
  | "onboarding-provider-card"
  | "onboarding-recommendation-card"
  | "onboarding-setup-help"
  | "post-onboarding-recommendation";

/**
 * UI slot definition for plugin-provided dashboard components.
 * Each slot represents a host-owned mount point where a plugin can render UI.
 */
export interface PluginUiSlotDefinition {
  /**
   * Unique slot identifier. Should match one of the known host surfaces above,
   * but string is retained for compatibility with legacy plugins.
   */
  slotId: PluginUiSurface | string;
  /** Human-readable label for the UI slot */
  label: string;
  /** Optional icon name (lucide-react icon name or custom icon identifier) */
  icon?: string;
  /**
   * Path to the JS module that exports the component.
   * Path is relative to the plugin's root directory.
   */
  componentPath: string;
  /** Optional explicit surface metadata (defaults to slotId). */
  surface?: PluginUiSurface;
  /** Optional deterministic render order; lower values render first. */
  order?: number;
  /** Optional host placement hint for the surface. */
  placement?: "before-default" | "after-default" | "replace-default";
}

/**
 * Top-level dashboard view definition for plugin-provided navigation destinations.
 * This is separate from embedded uiSlots and is rendered via host-managed registry.
 */
export type PluginUiContributionSurface =
  | "settings-provider-card"
  | "settings-config-section"
  | "onboarding-provider-card"
  | "onboarding-setup-help"
  | "onboarding-provider-recommendation"
  | "post-onboarding-recommendation";

export interface PluginUiContributionWhen {
  providerIds?: string[];
  runtimeIds?: string[];
  authState?: "required" | "authenticated" | "unauthenticated";
  onboardingState?: "required" | "in-progress" | "complete";
}

export interface PluginUiActionDescriptor {
  kind:
    | "open-settings-section"
    | "open-onboarding"
    | "refresh-auth-status"
    | "save-api-key"
    | "toggle-cli-provider"
    | "open-external-url";
  target?: string;
  label?: string;
}

interface PluginUiContributionBase {
  surface: PluginUiContributionSurface;
  contributionId: string;
  title: string;
  description?: string;
  order?: number;
  when?: PluginUiContributionWhen;
}

interface PluginUiProviderCardBase extends PluginUiContributionBase {
  providerId: string;
  providerType: "cli" | "oauth" | "api_key" | "custom";
  settingsSectionId?: string;
  statusSource?: { kind: string; providerId: string; route?: string };
  actions?: PluginUiActionDescriptor[];
}

export interface SettingsProviderCardContribution extends PluginUiProviderCardBase {
  surface: "settings-provider-card";
}

export interface SettingsConfigSectionContribution extends PluginUiContributionBase {
  surface: "settings-config-section";
  sectionId: string;
  pluginSettingKeys: string[];
  layout?: "section" | "card" | "disclosure";
}

export interface OnboardingProviderCardContribution extends PluginUiProviderCardBase {
  surface: "onboarding-provider-card";
  quickStart?: string;
  recommended?: boolean;
}

export interface OnboardingSetupHelpContribution extends PluginUiContributionBase {
  surface: "onboarding-setup-help";
  providerId?: string;
  body: string;
  bodyFormat: "text" | "markdown";
  actions?: PluginUiActionDescriptor[];
}

export interface OnboardingProviderRecommendationContribution extends PluginUiContributionBase {
  surface: "onboarding-provider-recommendation";
  providerId: string;
  reason: string;
  actions?: PluginUiActionDescriptor[];
  priority?: number;
}

export interface PostOnboardingRecommendationContribution extends PluginUiContributionBase {
  surface: "post-onboarding-recommendation";
  description: string;
  actions?: PluginUiActionDescriptor[];
  priority?: number;
  dismissible?: boolean;
}

export type PluginUiContributionDefinition =
  | SettingsProviderCardContribution
  | SettingsConfigSectionContribution
  | OnboardingProviderCardContribution
  | OnboardingSetupHelpContribution
  | OnboardingProviderRecommendationContribution
  | PostOnboardingRecommendationContribution;

type LegacyPluginUiContributionSurface =
  | "settings-integration-card"
  | "onboarding-recommendation-card";

export type PluginUiContributionInputDefinition = Omit<PluginUiContributionDefinition, "surface"> & {
  surface: PluginUiContributionSurface | LegacyPluginUiContributionSurface;
};

export function normalizePluginUiContributionSurface(
  surface: PluginUiContributionSurface | LegacyPluginUiContributionSurface,
): PluginUiContributionSurface {
  if (surface === "settings-integration-card") {
    return "settings-config-section";
  }
  if (surface === "onboarding-recommendation-card") {
    return "onboarding-provider-recommendation";
  }
  return surface;
}

export function normalizePluginUiContributionDefinition(
  contribution: PluginUiContributionInputDefinition,
): PluginUiContributionDefinition {
  return {
    ...contribution,
    surface: normalizePluginUiContributionSurface(contribution.surface),
  } as PluginUiContributionDefinition;
}

export interface PluginDashboardViewDefinition {
  /** Unique view identifier within a plugin namespace. */
  viewId: string;
  /** Human-readable label shown in dashboard navigation. */
  label: string;
  /**
   * Path to module exporting the dashboard view component.
   * Stored for authoring symmetry/future expansion; host currently resolves via static registry.
   */
  componentPath: string;
  /** Optional icon name (lucide-react icon name or custom icon identifier). */
  icon?: string;
  /** Optional sort order for nav presentation. Lower numbers appear first. */
  order?: number;
  /** Preferred navigation placement for this top-level view. */
  placement?: "primary" | "overflow" | "more";
  /** Optional short description used by navigation/help UI. */
  description?: string;
}

// ── Plugin Runtimes ─────────────────────────────────────────────────

/**
 * Runtime manifest metadata for plugin-provided agent runtimes.
 * Declares the capabilities and requirements of a runtime.
 */
export interface PluginRuntimeManifestMetadata {
  /** Unique runtime identifier within the plugin (e.g., "code-interpreter", "web-search") */
  runtimeId: string;
  /** Human-readable name for the runtime */
  name: string;
  /** Short description of what the runtime provides */
  description?: string;
  /** Semantic version of the runtime implementation */
  version?: string;
}

/**
 * Factory function for creating a runtime instance.
 * The factory receives plugin context and returns the runtime handle.
 *
 * @param ctx - Plugin context with access to task store, settings, and logging
 * @returns The runtime instance, or void/null if initialization fails
 */
export type PluginRuntimeFactory = (
  ctx: PluginContext,
) => Promise<unknown> | unknown;

/**
 * Runtime registration combining manifest metadata with the factory function.
 * Plugins declare runtimes by providing both metadata (for discovery) and
 * a factory function (for instantiation).
 */
export interface PluginRuntimeRegistration {
  /** Runtime metadata for discovery and display */
  metadata: PluginRuntimeManifestMetadata;
  /** Factory function that creates the runtime instance */
  factory: PluginRuntimeFactory;
}

export type CliProviderType = "cli" | "oauth" | "api_key" | "custom";

export interface CliProviderActionMetadata {
  actionId: string;
  label: string;
  actionType: "enable" | "disable" | "test" | "open-url" | "custom";
  route?: string;
  method?: "GET" | "POST";
}

export interface CliProviderProbeResult {
  available: boolean;
  authenticated?: boolean;
  binaryPath?: string;
  binaryName?: string;
  version?: string;
  reason?: string;
  hostReady?: boolean;
  pluginReady?: boolean;
}

export interface CliProviderModelDiscoveryResult {
  models: Array<{ id: string; label?: string; metadata?: Record<string, unknown> }>;
  source: string;
  fallbackUsed: boolean;
  reason?: string;
}

export interface CliProviderRuntimeRegistration {
  runtimeId?: string;
  createAdapter?: PluginRuntimeFactory;
}

export interface CliProviderContribution {
  providerId: string;
  displayName: string;
  binaryName: string;
  providerType: CliProviderType;
  statusRoute: string;
  authRoute: string;
  onboarding?: {
    title?: string;
    description?: string;
  };
  settings?: {
    sectionId?: string;
    pluginSettingKeys?: string[];
  };
  actions?: CliProviderActionMetadata[];
  probe?: (ctx: PluginContext) => Promise<CliProviderProbeResult>;
  discoverModels?: (ctx: PluginContext) => Promise<CliProviderModelDiscoveryResult>;
  runtime?: CliProviderRuntimeRegistration;
}

// ── Plugin Contribution Types ───────────────────────────────────────

/**
 * Plugin-contributed skill surfaced in agent sessions via the skill-selection system.
 */
/*
 * FNXC:PluginMcpServers 2026-07-22-12:00:
 * FN-8491 / #2401 lets plugins declare MCP wiring without writing consumer settings.
 * Contributions deliberately omit `enabled`: project settings own enablement and can
 * override or tombstone a server by name; sensitive values remain secret references.
 */
export type PluginMcpServerContribution = Omit<McpServerDefinition, "enabled"> & {
  /** Opt out of automatic wiring while remaining available for a project override. */
  enabledByDefault?: boolean;
};

export interface PluginSkillContribution {
  /** Unique skill identifier within the plugin namespace (kebab-case). */
  skillId: string;
  /** Human-readable skill name. */
  name: string;
  /** What the skill does. */
  description: string;
  /** Paths (relative to plugin root) to SKILL.md or equivalent definitions. */
  skillFiles: string[];
  /** Whether this skill is enabled by default. Defaults to true. */
  enabled?: boolean;
  /** Optional keyword/pattern hints used by skill matching. */
  triggerPatterns?: string[];
}

/**
 * Workflow step template contributed by a plugin. These templates are
 * materialized into concrete WorkflowStep instances when selected for a task.
 */
export interface PluginWorkflowStepContribution {
  /** Unique step identifier within the plugin namespace (kebab-case). */
  stepId: string;
  /** Human-readable step name. */
  name: string;
  /** Short description for UI. */
  description: string;
  /** Execution mode, aligned with WorkflowStepMode. */
  mode: WorkflowStepMode;
  /** Task lifecycle phase where this step runs. Defaults to "pre-merge". */
  phase?: "pre-merge" | "post-merge";
  /** Prompt text used when mode is "prompt". */
  prompt?: string;
  /** Script name used when mode is "script". */
  scriptName?: string;
  /** Tool access level, aligned with WorkflowStepToolMode. */
  toolMode?: WorkflowStepToolMode;
  /** Whether this step is enabled by default. Defaults to true. */
  enabled?: boolean;
  /** Whether this step is auto-selected on new tasks. */
  defaultOn?: boolean;
  /** Optional model provider override for prompt steps. */
  modelProvider?: string;
  /** Optional model ID override for prompt steps. */
  modelId?: string;
}

/**
 * Plugin-contributed trait (U8, R6/R22, KTD-7).
 *
 * Plugins declare traits in their manifest the way they declare workflow steps.
 * A trait carries declarative flags + an optional config schema + async-only
 * hook descriptors. The contract is a VERSIONED hook-descriptor schema
 * (`schemaVersion`) so the built-in trait vocabulary can grow additively (new
 * flags, hook points, config fields) without breaking published plugin traits.
 *
 * Restricted (built-in-only) capabilities a plugin trait may NOT declare (R22,
 * KTD-2/KTD-7), rejected at validation:
 *   - the `complete` / `archived` flags (silently satisfying dependencies /
 *     hiding cards is a scheduling-poison surface);
 *   - a sync `guard` hook (sync guards run in-lock and must be fast/pure — a
 *     plugin hook there could wedge the task lock).
 *
 * Plugin traits get ASYNC hook points only: `gate`, `onEnter`, `onExit`,
 * `releaseCondition`. Each hook descriptor mirrors PluginWorkflowStepContribution's
 * declarative shape (mode + prompt/scriptName) so the existing prompt-session /
 * script / verdict machinery executes them; gates additionally carry `gateMode`.
 */
export interface PluginTraitHookDescriptor {
  /** How the hook runs: a model prompt or a named project script. */
  mode: "prompt" | "script";
  /** Prompt text used when `mode === "prompt"`. */
  prompt?: string;
  /** Named project script used when `mode === "script"`. */
  scriptName?: string;
  /**
   * Gate semantics (gate hook only): `blocking` fails closed (a non-pass
   * verdict rejects the move); `advisory` records the verdict and allows the
   * move. Ignored for non-gate hooks. Defaults to `blocking` for gate hooks.
   */
  gateMode?: "blocking" | "advisory";
}

/**
 * The declarative flag subset a plugin trait may declare. Restricted flags
 * (`complete`, `archived`) are intentionally absent from this type AND rejected
 * at validation — declaring them is a contribution error, not silently ignored.
 */
export interface PluginTraitFlags {
  countsTowardWip?: boolean;
  hiddenFromBoard?: boolean;
  abortOnExit?: boolean;
  humanReview?: boolean;
  intake?: boolean;
  hold?: boolean;
  mergeOrchestration?: boolean;
  mergeBlocker?: boolean;
  resetOnEntry?: boolean;
  timing?: boolean;
  stallDetection?: boolean;
  notify?: boolean;
  gate?: boolean;
}

export interface PluginTraitContribution {
  /** Unique trait identifier within the plugin namespace (kebab-case). The
   *  registry-facing id is namespaced as `plugin:<pluginId>:<traitId>`. */
  traitId: string;
  /** Human-readable trait name. */
  name: string;
  /** Short description for UI. */
  description?: string;
  /** Versioned hook-descriptor schema. Currently `1`. Required so the
   *  vocabulary can extend additively without breaking published traits. */
  schemaVersion: 1;
  /** Declarative flags (restricted flags rejected at validation, R22). */
  flags?: PluginTraitFlags;
  /** Optional declarative config schema fields (shape mirrors TraitConfigField). */
  configSchema?: {
    fields: Array<{
      key: string;
      type: "string" | "number" | "boolean" | "enum" | "object" | "array";
      required?: boolean;
      enumValues?: readonly string[];
      description?: string;
    }>;
  };
  /** Async-only hook descriptors (R22). A `guard` key is NOT permitted and is
   *  rejected at validation. */
  hooks?: {
    gate?: PluginTraitHookDescriptor;
    onEnter?: PluginTraitHookDescriptor;
    onExit?: PluginTraitHookDescriptor;
    releaseCondition?: PluginTraitHookDescriptor;
  };
}

/*
FNXC:PluginManifestValidation 2026-10-08-04:45:
Manifest validation lives in the pure plugin-manifest-validation.ts module so the plugin SDK can re-export the exact function the loader runs (KB-034).
These re-exports keep every existing importer of plugin-types.js and both core barrels unchanged.
*/
export {
  validatePluginManifest,
  validatePluginTraitContribution,
  validateWorkflowExtensionContribution,
  PLUGIN_TRAIT_RESTRICTED_FLAGS,
  PLUGIN_TRAIT_ALLOWED_HOOK_POINTS,
  PLUGIN_TRAIT_SCHEMA_VERSION,
} from "./plugin-manifest-validation.js";

/**
 * Prompt injection surfaces for plugin-contributed instructions.
 * - executor-system: Appended to executor agent system prompt
 * - executor-task: Injected into per-task execution context
 * - triage: Appended to triage/planning prompts
 * - reviewer: Appended to reviewer/validation prompts
 * - heartbeat: Appended to heartbeat agent system prompts
 */
export type PluginPromptSurface = (typeof PROMPT_CONTRIBUTION_SURFACES)[number];

export interface PluginPromptContribution {
  /** Which prompt surface this contribution targets. */
  surface: PluginPromptSurface;
  /** Prompt text to inject. */
  content: string;
  /** Position relative to existing prompt content. Defaults to "append". */
  position?: "append" | "prepend";
  /**
   * Optional host-enforced gate for this contribution.
   *
   * FNXC:PluginPrompt 2026-07-10-00:00:
   * Plugin authors can gate prompt guidance on per-project effective plugin settings, so `condition` is no longer decorative.
   * The host supports exactly one injection-safe comparison: `settings["key"] === "value"` or `settings["key"] !== "value"` (single or double quotes, whitespace-tolerant).
   * Settings are resolved from the plugin settings schema `defaultValue`s overlaid by stored per-project values; absent or empty conditions include the contribution, while malformed conditions fail closed and exclude it.
   * Example: `settings["api-style"] === "minimal-apis"`.
   */
  condition?: string;
}

export interface PluginPromptContributions {
  contributions: PluginPromptContribution[];
  /** Whether contributions are active by default. Defaults to false for safety. */
  enabledByDefault?: boolean;
}

export interface ExecutorRuntimeTaskContext {
  taskId: string;
  worktreePath: string;
  rootDir: string;
  branch?: string;
}

export interface ExecutorRuntimeEnvContribution {
  pathPrepend?: string[];
  env?: Record<string, string>;
  description?: string;
}

export type PluginExecutorRuntimeEnvHook = (
  taskCtx: ExecutorRuntimeTaskContext,
  ctx: PluginContext,
) => Promise<ExecutorRuntimeEnvContribution> | ExecutorRuntimeEnvContribution;

export type PluginSetupStatus = "not-installed" | "installing" | "installed" | "error";

export interface PluginSetupCheckResult {
  status: PluginSetupStatus;
  /** Installed version if available. */
  version?: string;
  /** Installed binary path if detected. */
  binaryPath?: string;
  /** Error details when status is "error". */
  error?: string;
}

/**
 * Plugin-managed setup hooks. All process execution in hooks MUST be async
 * (never execSync) to avoid blocking the engine event loop.
 */
export interface PluginSetupHooks {
  /** Check whether required binaries/runtimes are installed and ready. */
  checkSetup: (ctx: PluginContext) => Promise<PluginSetupCheckResult>;
  /** Install required binaries/runtimes. */
  install?: (ctx: PluginContext) => Promise<void>;
  /** Uninstall managed binaries/runtimes. */
  uninstall?: (ctx: PluginContext) => Promise<void>;
}

export interface PluginSetupManifest {
  /** Binary/runtime name being managed (e.g. "agent-browser"). */
  binaryName: string;
  /** What this binary/runtime provides. */
  description: string;
  /** Expected or pinned version. */
  version?: string;
  /** Installation channel. */
  channel?: (typeof SETUP_CHANNELS)[number];
  /** Timeout for setup/install commands. Defaults to 120000. */
  defaultTimeoutMs?: number;
}

// ── Fusion Plugin ────────────────────────────────────────────────────

export type PluginState = "installed" | "started" | "stopped" | "error";

export interface PluginSecurityFinding {
  category: string;
  severity: "low" | "medium" | "high" | "critical";
  file: string;
  excerpt: string;
  reason: string;
}

export interface PluginSecurityScanResult {
  verdict: "clean" | "warning" | "blocked" | "error" | "unavailable";
  summary: string;
  findings: PluginSecurityFinding[];
  scannedAt: string;
  scannedFiles: string[];
  scanDurationMs?: number;
  modelProvider?: string;
  modelId?: string;
}

/**
 * Loaded plugin instance with all hooks, tools, routes, and runtimes.
 */
export interface FusionPlugin {
  manifest: PluginManifest;
  state: PluginState;
  hooks: {
    onLoad?: PluginOnLoad;
    onUnload?: PluginOnUnload;
    onTaskCreated?: PluginOnTaskCreated;
    onTaskMoved?: PluginOnTaskMoved;
    onTaskCompleted?: PluginOnTaskCompleted;
    onError?: PluginOnError;
    onSchemaInit?: PluginOnSchemaInit;
    onPostgresSchemaInit?: PluginOnPostgresSchemaInit;
    onAgentRunStart?: PluginOnAgentRunStart;
    onAgentRunEnd?: PluginOnAgentRunEnd;
  };
  tools?: PluginToolDefinition[];
  routes?: PluginRouteDefinition[];
  uiSlots?: PluginUiSlotDefinition[];
  uiContributions?: PluginUiContributionInputDefinition[];
  /** Plugin-contributed top-level dashboard views. */
  dashboardViews?: PluginDashboardViewDefinition[];
  /** Agent runtime registration for providing custom runtime implementations */
  runtime?: PluginRuntimeRegistration;
  /** CLI-backed provider metadata and integration hooks. */
  cliProviders?: CliProviderContribution[];
  /** Plugin-contributed skills surfaced by the skill resolver. */
  skills?: PluginSkillContribution[];
  /** Declarative MCP servers, scoped to projects where this plugin is enabled. */
  mcpServers?: PluginMcpServerContribution[];
  /** Plugin-contributed workflow step templates. */
  workflowSteps?: PluginWorkflowStepContribution[];
  /** Plugin-contributed column traits (U8). */
  traits?: PluginTraitContribution[];
  /** Plugin-contributed workflow extension points. */
  workflowExtensions?: WorkflowExtensionContribution[];
  /** Plugin-contributed prompt injections. */
  promptContributions?: PluginPromptContributions;
  /** Plugin-managed setup metadata and lifecycle hooks. */
  setup?: {
    manifest: PluginSetupManifest;
    hooks: PluginSetupHooks;
  };
  /** Plugin-contributed executor runtime env for task-scoped subprocesses. */
  executorRuntimeEnv?: PluginExecutorRuntimeEnvHook;
}

/**
 * FNXC:PluginHooks 2026-10-07-18:01:
 * Hooks whose declared signature ends in `ctx: PluginContext`. The loader appends a per-plugin context to these when the caller passes raw event arguments.
 * `satisfies` forces every new key of `FusionPlugin["hooks"]` to be classified here, so a ctx-taking hook cannot ship without loader support.
 */
export const PLUGIN_HOOK_RECEIVES_CONTEXT = {
  onLoad: true,
  onUnload: true,
  onTaskCreated: true,
  onTaskMoved: true,
  onTaskCompleted: true,
  onError: true,
  onAgentRunStart: true,
  onAgentRunEnd: true,
  onSchemaInit: false,
  onPostgresSchemaInit: false,
} as const satisfies Record<keyof FusionPlugin["hooks"], boolean>;

// ── Plugin Installation ───────────────────────────────────────────────

/**
 * Persisted plugin record in the store.
 */
export interface PluginInstallation {
  /** Same as manifest.id */
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  /** Absolute path to plugin directory or npm package */
  path: string;
  enabled: boolean;
  state: PluginState;
  settings: Record<string, unknown>;
  settingsSchema?: Record<string, PluginSettingSchema>;
  /**
   * Last error message.
   * FNXC:PluginLoader 2026-10-07-18:01: With state "error" this is the load/unload failure. With state "started" it is the most recent hook failure; the plugin stays loaded and serving.
   */
  error?: string;
  dependencies?: string[];
  aiScanOnLoad?: boolean;
  lastSecurityScan?: PluginSecurityScanResult;
  createdAt: string;
  updatedAt: string;
}
