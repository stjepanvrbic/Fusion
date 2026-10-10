// Wire protocol types for Claude CLI stream-json NDJSON communication

// NDJSON message types from Claude CLI stdout

export interface ClaudeStreamEventMessage {
  type: "stream_event";
  event: ClaudeApiEvent;
  /** Present on sub-agent stream events; null/undefined for top-level events. */
  parent_tool_use_id?: string | null;
}

/**
 * FNXC:ClaudeCliProvider 2026-10-07-19:34:
 * The CLI ends every turn with one result. Failures use `error_*` subtypes (`error_max_turns`, `error_during_execution`, ...) or `success` with `is_error: true` (auth, billing, API errors); there is no plain `error` subtype.
 * Only `subtype: "success"` without `is_error` is a completed turn.
 */
export interface ClaudeResultMessage {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_during_execution" | (string & {});
  is_error?: boolean;
  /** HTTP status of the API error that ended the turn; absent or null when the turn ended without one. */
  api_error_status?: number | null;
  result?: string;
  /** Diagnostics on `error_*` results. */
  errors?: string[];
  error?: string;
  session_id?: string;
}

export interface ClaudeSystemMessage {
  type: "system";
  subtype: string;
  session_id?: string;
  tools?: unknown[];
}

export interface ClaudeControlRequest {
  type: "control_request";
  request_id: string;
  request: {
    subtype: "can_use_tool";
    tool_name: string;
    input: Record<string, unknown>;
  };
}

/** A user-role message the CLI echoes; carries the `tool_result` blocks it recorded for the preceding tool calls. */
export interface ClaudeUserMessage {
  type: "user";
  message?: { content?: unknown };
  /** Present on sub-agent messages; null/undefined for top-level ones. */
  parent_tool_use_id?: string | null;
}

export type NdjsonMessage =
  | ClaudeStreamEventMessage
  | ClaudeUserMessage
  | ClaudeResultMessage
  | ClaudeSystemMessage
  | ClaudeControlRequest;

// Claude API event types (inside stream_event wrapper)

export interface ClaudeApiEvent {
  type: string; // message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop
  index?: number;
  message?: {
    id?: string;
    type?: string;
    role?: string;
    content?: unknown[];
    model?: string;
    usage?: ClaudeUsage;
  };
  content_block?: {
    type: string; // "text", "tool_use", "thinking"
    text?: string;
    id?: string;
    name?: string;
    input?: string;
  };
  delta?: {
    type?: string; // "text_delta", "input_json_delta", "thinking_delta", "signature_delta"
    text?: string;
    partial_json?: string;
    thinking?: string;
    signature?: string;
    stop_reason?: string;
  };
  usage?: ClaudeUsage;
}

export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// Content block tracking during stream processing

export interface TrackedContentBlock {
  type: "text" | "thinking";
  text: string;
  index: number; // Claude's content_block index
}
