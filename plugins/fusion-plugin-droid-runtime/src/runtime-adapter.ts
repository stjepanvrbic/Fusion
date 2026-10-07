import { streamViaCli } from "./provider.js";
import { resolveCliSettings } from "./cli-spawn.js";
import type { AgentRuntime, AgentRuntimeOptions, AgentSession, AgentSessionResult, DroidSession } from "./types.js";

/*
FNXC:DroidCli 2026-10-07-18:02:
A Droid session runs in the task's working directory from `AgentRuntimeOptions.cwd`; falling back to Fusion's own cwd launched the CLI in the primary checkout instead of the task worktree.
Disposing a session aborts its active turn so a timed-out workflow step does not leave the CLI running.
*/
interface DroidSessionState {
  cwd: string;
  activeTurn?: AbortController;
}

const sessionState = new WeakMap<DroidSession, DroidSessionState>();

export class DroidRuntimeAdapter implements AgentRuntime {
  readonly id = "droid";
  readonly name = "Droid Runtime";
  private readonly settings: ReturnType<typeof resolveCliSettings>;

  constructor(settings?: Record<string, unknown>) {
    this.settings = resolveCliSettings(settings);
  }

  async createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult> {
    const model = this.settings.model ?? options.defaultModelId ?? "droid";
    const state: DroidSessionState = { cwd: options.cwd };
    const session: DroidSession = {
      model,
      systemPrompt: options.systemPrompt,
      messages: [],
      apiKey: undefined,
      thinkingLevel: options.defaultThinkingLevel,
      sessionId: "",
      lastModelDescription: `droid/${model}`,
      callbacks: {
        onText: options.onText,
        onThinking: options.onThinking,
        onToolStart: options.onToolStart,
        onToolEnd: options.onToolEnd,
      },
      dispose: () => {
        state.activeTurn?.abort();
      },
    };
    sessionState.set(session, state);
    return { session, sessionFile: undefined };
  }

  /**
   * Run one turn. `streamViaCli` returns pi-ai's async-iterable `AssistantMessageEventStream`, not an EventEmitter:
   * consume it with `for await`, forward deltas, and settle on its terminal event. Failures reject.
   */
  async promptWithFallback(session: AgentSession, prompt: string, _options?: unknown): Promise<void> {
    const model = {
      id: String(session.model ?? this.settings.model ?? "droid"),
      provider: "droid-cli",
      api: "droid-cli",
    } as any;
    const state = sessionState.get(session);
    const turn = new AbortController();
    if (state) state.activeTurn = turn;

    try {
      const stream = streamViaCli(model, {
        messages: [{ role: "user", content: prompt }],
        systemPrompt: session.systemPrompt,
      } as any, { sessionId: session.sessionId, cwd: state?.cwd, signal: turn.signal, binaryPath: this.settings.binaryPath } as any);

      for await (const event of stream) {
        if (event.type === "text_delta") {
          session.callbacks.onText?.(event.delta);
        } else if (event.type === "thinking_delta") {
          session.callbacks.onThinking?.(event.delta);
        } else if (event.type === "error") {
          throw new Error(event.error.errorMessage ?? "Droid CLI turn failed");
        } else if (event.type === "done") {
          if (event.message.errorMessage) throw new Error(event.message.errorMessage);
          return;
        }
      }
    } finally {
      if (state?.activeTurn === turn) state.activeTurn = undefined;
    }
  }

  describeModel(session: AgentSession): string {
    return session.lastModelDescription || "droid";
  }

  async dispose(session: AgentSession): Promise<void> {
    session.dispose();
  }
}
