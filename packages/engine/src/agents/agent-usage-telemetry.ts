import type { TaskStore, UsageEventInput } from "@fusion/core";
import { AgentLogger, emitUsageEventFailSoft } from "./agent-logger.js";
import { createLogger } from "../logger.js";

export const AGENT_SESSION_USAGE_CATEGORY = "agent-session";
export type AgentTelemetryLane = "heartbeat" | "executor" | "workflow-step" | "triage" | "reviewer" | "merger";
export interface AgentSessionTelemetryContext {
  store: TaskStore;
  agentId?: string | null;
  taskId?: string | null;
  nodeId?: string | null;
  model?: string | null;
  provider?: string | null;
  lane: AgentTelemetryLane;
  ephemeral?: boolean;
  runId?: string;
}
const log = createLogger("agent-usage-telemetry");
const SESSION_TELEMETRY_FAILURE = "Failed to emit agent session telemetry";
/** Attach telemetry without coupling usage events to the task-log lifecycle. */
export function attachAgentUsageTelemetry(logger: AgentLogger | null | undefined, ctx: AgentSessionTelemetryContext): void {
  if (!logger) return;
  logger.setUsageTelemetry({ store: ctx.store, usageContext: { agentId: ctx.agentId ?? null, nodeId: ctx.nodeId ?? null, model: ctx.model ?? null, provider: ctx.provider ?? null } });
}
/**
 * Emit a single, non-sensitive session boundary event; failures never affect an agent lane.
 *
 * FNXC:CommandCenterActivity 2026-10-11-01:30:
 * A lane's completion must imply its session boundary is persisted, so the write is tracked by the lane's logger and drained by its `flush()`.
 * The logger is a required argument so every lane states which logger owns the boundary; `null` (a lane without a logger) keeps a detached, fail-soft write.
 */
export function emitAgentSessionStart(ctx: AgentSessionTelemetryContext, logger: AgentLogger | null | undefined): void {
  const event: UsageEventInput = { kind: "session_start", taskId: ctx.taskId ?? null, agentId: ctx.agentId ?? null, nodeId: ctx.nodeId ?? null, model: ctx.model ?? null, provider: ctx.provider ?? null, category: AGENT_SESSION_USAGE_CATEGORY, meta: { lane: ctx.lane, ...(ctx.ephemeral !== undefined ? { ephemeral: ctx.ephemeral } : {}), ...(ctx.runId ? { runId: ctx.runId } : {}) } };
  if (logger) {
    logger.trackUsageEvent(ctx.store, event, SESSION_TELEMETRY_FAILURE);
    return;
  }
  void emitUsageEventFailSoft(ctx.store, event, (message) => log.warn(`${SESSION_TELEMETRY_FAILURE}: ${message}`));
}
