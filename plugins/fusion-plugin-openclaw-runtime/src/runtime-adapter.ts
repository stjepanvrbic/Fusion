/**
 * OpenClaw Runtime Adapter — drives the local `openclaw` CLI as a subprocess.
 *
 * Each call to `promptWithFallback` invokes
 *   `openclaw --no-color agent --local --json --session-id <uuid> --message <prompt>`
 * (and `--model`, `--thinking`, `--timeout`, `--agent` if configured),
 * parses the JSON document on stdout, and forwards visible/reasoning text
 * via the session callbacks.
 *
 * Session continuity: the UUID minted on session create is reused on every
 * subsequent prompt as `--session-id`, so openclaw resumes the same agent
 * conversation server-side.
 */

import type {
  AgentRuntime,
  AgentRuntimeOptions,
  AgentSessionResult,
  CliConfig,
  GatewaySession,
} from "./types.js";
import {
  configureOpenClawMcpServer,
  createCliSession,
  describeCliModel,
  promptCli,
  resolveCliConfig,
} from "./pi-module.js";
import { toolsToMcpToolDefs, writeOpenClawMcpBridgeFiles, type ToolLike } from "./mcp-config.js";
import { randomUUID } from "node:crypto";

/*
FNXC:OpenClawCli 2026-10-07-18:02:
Sessions carry the task cwd into every turn. Disposal (adapter `dispose` or `session.dispose`) aborts the active turn, because the engine disposes on step timeout and a no-op disposer left the CLI running.
*/
const activeTurns = new WeakMap<GatewaySession, AbortController>();

export class OpenClawRuntimeAdapter implements AgentRuntime {
  readonly id = "openclaw";
  readonly name = "OpenClaw Runtime";

  private readonly config: CliConfig;

  constructor(settings?: Partial<CliConfig> | Record<string, unknown>) {
    this.config = resolveCliConfig(settings as Record<string, unknown> | undefined);
  }

  async createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult> {
    const contextTools = [
      ...(Array.isArray(options.tools) ? (options.tools as ToolLike[]) : []),
      ...(Array.isArray(options.customTools) ? (options.customTools as ToolLike[]) : []),
    ];
    const toolDefs = toolsToMcpToolDefs(contextTools);

    let mcpProfile: string | undefined;
    let mcpConfigPath: string | undefined;

    if (toolDefs.length > 0) {
      const bridge = writeOpenClawMcpBridgeFiles(toolDefs, randomUUID());
      mcpProfile = `fusion-${randomUUID()}`;
      mcpConfigPath = bridge.serverConfigPath;
      await configureOpenClawMcpServer({
        binaryPath: this.config.binaryPath,
        profile: mcpProfile,
        serverName: bridge.serverName,
        serverConfigPath: bridge.serverConfigPath,
      });
    }

    const session = createCliSession({
      cwd: options.cwd,
      systemPrompt: options.systemPrompt,
      agentId: this.config.agentId,
      mcpProfile,
      mcpConfigPath,
      callbacks: {
        onText: options.onText,
        onThinking: options.onThinking,
        onToolStart: options.onToolStart,
        onToolEnd: options.onToolEnd,
      },
    });

    session.dispose = () => {
      activeTurns.get(session)?.abort();
    };

    return { session, sessionFile: undefined };
  }

  async promptWithFallback(
    session: GatewaySession,
    prompt: string,
    options?: unknown,
  ): Promise<void> {
    const overrideCallbacks = (options ?? undefined) as
      | Parameters<typeof promptCli>[3]
      | undefined;
    const turn = new AbortController();
    activeTurns.set(session, turn);
    try {
      await promptCli(session, prompt, this.config, overrideCallbacks, turn.signal);
    } finally {
      if (activeTurns.get(session) === turn) activeTurns.delete(session);
    }
  }

  describeModel(session: GatewaySession): string {
    return describeCliModel(session);
  }

  async dispose(session: GatewaySession): Promise<void> {
    await session.dispose?.();
  }
}
