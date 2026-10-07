import type { Task, TaskCreateInput } from "@fusion/core";
import type { RuntimeMetrics } from "../project/project-runtime.js";
import { remoteNodeLog } from "../logger.js";

export type RemoteNodeEventType =
  | "task:created"
  | "task:moved"
  | "task:updated"
  | "task:assigned"
  | "error"
  | (string & {});

export interface RemoteNodeTaskAssignedPayload {
  taskId: string;
  agentId: string;
  fromNodeId?: string;
  toNodeId?: string;
  leaseEpoch?: number;
  assignedAt: string;
}

export interface RemoteNodeEvent {
  type: RemoteNodeEventType;
  payload: unknown;
  timestamp: string;
}

export interface RemoteNodeClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

export type RemoteTaskListFilter = Record<string, string | number | boolean | undefined | null>;

class RemoteNodeRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number
  ) {
    super(message);
    this.name = "RemoteNodeRequestError";
  }
}

const RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_RETRIES = 3;

/**
 * One request's cancellation: the caller's signal plus a deadline, kept attached until the response body is consumed.
 *
 * FNXC:RemoteNodeRuntime 2026-10-07-19:50:
 * The timeout and the caller's abort used to detach as soon as fetch returned headers, so a body that stalled after its headers could never be cancelled.
 * A silent SSE stream then kept `RemoteNodeRuntime.stop()` waiting forever on a pending read, and JSON bodies outlived the request timeout.
 * Every request now keeps both attached through body consumption: ordinary JSON bodies stay under the deadline, long-lived stream bodies drop only the deadline, and an abort cancels the pending body read.
 */
interface RequestScope {
  readonly signal: AbortSignal;
  timedOut(): boolean;
  /** Stop the deadline; a long-lived stream body stays bounded by the caller's signal. */
  clearDeadline(): void;
  /** Detach from the caller's signal and abort the request so an unread body releases its connection. Idempotent. */
  dispose(): void;
}

export interface RemoteNodeRequestOptions {
  signal?: AbortSignal;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("The operation was aborted");
}

/**
 * Yield a body's chunks, cancelling the reader the moment `signal` aborts so a stalled read wakes up.
 * Ends quietly on abort; a consumer that stops early also cancels the body.
 */
async function* readChunks(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  let finished = false;
  try {
    while (!signal.aborted) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
      if (result.done) {
        finished = true;
        return;
      }
      if (result.value) yield result.value;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!finished) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Read a whole body as text; an abort mid-read rejects instead of returning a truncated body. */
async function readAllText(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of readChunks(body, signal)) {
    text += decoder.decode(chunk, { stream: true });
  }
  if (signal.aborted) throw abortReason(signal);
  return text + decoder.decode();
}

export class RemoteNodeClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(options: RemoteNodeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async health(options?: RemoteNodeRequestOptions): Promise<{ status: string; version: string; uptime: number }> {
    return this.withRetry(
      () =>
        this.requestJson<{ status: string; version: string; uptime: number }>(
          "/api/health",
          { method: "GET" },
          options?.signal
        ),
      DEFAULT_MAX_RETRIES,
      options?.signal
    );
  }

  async getMetrics(): Promise<RuntimeMetrics> {
    return this.withRetry(() =>
      this.requestJson<RuntimeMetrics>("/api/metrics", {
        method: "GET",
      })
    );
  }

  async createTask(input: TaskCreateInput): Promise<Task> {
    return this.withRetry(() =>
      this.requestJson<Task>("/api/tasks", {
        method: "POST",
        body: JSON.stringify(input),
      })
    );
  }

  async listTasks(filter?: RemoteTaskListFilter): Promise<Task[]> {
    const query = new URLSearchParams();
    if (filter) {
      for (const [key, value] of Object.entries(filter)) {
        if (value !== undefined && value !== null) {
          query.set(key, String(value));
        }
      }
    }

    const path = query.toString().length > 0 ? `/api/tasks?${query.toString()}` : "/api/tasks";
    return this.withRetry(() =>
      this.requestJson<Task[]>(path, {
        method: "GET",
      })
    );
  }

  async executeTask(taskId: string): Promise<{ acknowledged: boolean; [key: string]: unknown }> {
    return this.withRetry(() =>
      this.requestJson<{ acknowledged: boolean; [key: string]: unknown }>(
        `/api/tasks/${encodeURIComponent(taskId)}/execute`,
        {
          method: "POST",
        }
      )
    );
  }

  async pollPendingAssignments(
    options?: { since?: string } & RemoteNodeRequestOptions
  ): Promise<RemoteNodeTaskAssignedPayload[]> {
    const query = new URLSearchParams();
    if (options?.since) {
      query.set("since", options.since);
    }
    const path = query.size > 0
      ? `/api/events/assignments?${query.toString()}`
      : "/api/events/assignments";
    return this.withRetry(
      () => this.requestJson<RemoteNodeTaskAssignedPayload[]>(path, { method: "GET" }, options?.signal),
      DEFAULT_MAX_RETRIES,
      options?.signal
    );
  }

  async *streamEvents(options?: RemoteNodeRequestOptions): AsyncIterable<RemoteNodeEvent> {
    const path = "/api/events/stream";
    const { response, scope } = await this.withRetry(
      () => this.openStream(path, options?.signal),
      DEFAULT_MAX_RETRIES,
      options?.signal
    );

    try {
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.body) {
        throw new Error("Remote node event stream opened without a body");
      }

      if (contentType.includes("text/event-stream")) {
        scope.clearDeadline();
        yield* this.parseSseStream(response.body, scope.signal);
        return;
      }

      // Fallback for long-polling endpoints that return JSON payloads; the body stays under the request deadline.
      if (contentType.includes("application/json")) {
        const payload = JSON.parse(await this.readBodyText(path, response, scope)) as unknown;
        if (Array.isArray(payload)) {
          for (const rawEvent of payload) {
            yield this.normalizeEvent(rawEvent, "message");
          }
        } else {
          yield this.normalizeEvent(payload, "message");
        }
        return;
      }

      // Generic fallback: treat each line as one JSON event.
      scope.clearDeadline();
      yield* this.parseJsonLines(response.body, scope.signal);
    } finally {
      scope.dispose();
    }
  }

  private async requestJson<T>(path: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
    const scope = this.openScope(path, signal);
    try {
      const response = await this.fetchInScope(
        path,
        {
          ...init,
          headers: {
            ...this.getAuthHeaders(),
            Accept: "application/json",
            ...(init.body ? { "Content-Type": "application/json" } : {}),
            ...(init.headers ?? {}),
          },
        },
        scope
      );

      if (!response.ok) {
        await this.throwHttpError(path, response, scope);
      }

      const text = await this.readBodyText(path, response, scope);
      try {
        return JSON.parse(text) as T;
      } catch (error) {
        throw new RemoteNodeRequestError(
          `Failed to parse JSON response for ${path}: ${error instanceof Error ? error.message : String(error)}`,
          false
        );
      }
    } finally {
      scope.dispose();
    }
  }

  private async openStream(
    path: string,
    signal?: AbortSignal
  ): Promise<{ response: Response; scope: RequestScope }> {
    const scope = this.openScope(path, signal);
    try {
      const response = await this.fetchInScope(
        path,
        {
          method: "GET",
          headers: {
            ...this.getAuthHeaders(),
            Accept: "text/event-stream, application/json",
          },
        },
        scope
      );

      if (!response.ok) {
        await this.throwHttpError(path, response, scope);
      }

      return { response, scope };
    } catch (error) {
      scope.dispose();
      throw error;
    }
  }

  private async throwHttpError(path: string, response: Response, scope: RequestScope): Promise<never> {
    // The status is the error; a body that fails or stalls must not replace it.
    const responseBody = (await this.readBodyText(path, response, scope).catch(() => "")).trim();
    const snippet = responseBody.length > 0 ? ` — ${responseBody.slice(0, 300)}` : "";
    const retryable = response.status >= 500;

    throw new RemoteNodeRequestError(
      `Remote node request failed (${response.status} ${response.statusText}) for ${path}${snippet}`,
      retryable,
      response.status
    );
  }

  private getAuthHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  private openScope(path: string, externalSignal?: AbortSignal): RequestScope {
    if (externalSignal?.aborted) {
      throw new RemoteNodeRequestError(`Remote node request aborted (${path})`, false);
    }

    const controller = new AbortController();
    let timedOut = false;
    let deadline: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const clearDeadline = () => {
      if (deadline !== undefined) clearTimeout(deadline);
      deadline = undefined;
    };
    const onAbort = () => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener("abort", onAbort, { once: true });

    return {
      signal: controller.signal,
      timedOut: () => timedOut,
      clearDeadline,
      dispose: () => {
        clearDeadline();
        externalSignal?.removeEventListener("abort", onAbort);
        controller.abort();
      },
    };
  }

  private async fetchInScope(path: string, init: RequestInit, scope: RequestScope): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: scope.signal,
      });
    } catch (error) {
      throw this.toRequestError(path, scope, error);
    }
  }

  private async readBodyText(path: string, response: Response, scope: RequestScope): Promise<string> {
    if (!response.body) return "";
    try {
      return await readAllText(response.body, scope.signal);
    } catch (error) {
      throw this.toRequestError(path, scope, error);
    }
  }

  private toRequestError(path: string, scope: RequestScope, error: unknown): RemoteNodeRequestError {
    if (error instanceof RemoteNodeRequestError) {
      return error;
    }

    if (scope.timedOut()) {
      return new RemoteNodeRequestError(
        `Remote node request timed out after ${this.timeoutMs}ms (${path})`,
        true
      );
    }

    if (scope.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      return new RemoteNodeRequestError(`Remote node request aborted (${path})`, false);
    }

    return new RemoteNodeRequestError(
      `Remote node network error (${path}): ${error instanceof Error ? error.message : String(error)}`,
      true
    );
  }

  private async *parseSseStream(
    stream: ReadableStream<Uint8Array>,
    signal: AbortSignal
  ): AsyncIterable<RemoteNodeEvent> {
    const decoder = new TextDecoder();

    let buffer = "";
    let eventType = "message";
    let dataLines: string[] = [];

    const flushEvent = (): RemoteNodeEvent | null => {
      if (dataLines.length === 0) {
        eventType = "message";
        return null;
      }

      const data = dataLines.join("\n");
      dataLines = [];

      const normalized = this.normalizeEvent(data, eventType);
      eventType = "message";
      return normalized;
    };

    for await (const value of readChunks(stream, signal)) {
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.length === 0) {
          const event = flushEvent();
          if (event) {
            yield event;
          }
          continue;
        }

        if (line.startsWith(":")) {
          continue;
        }

        const separator = line.indexOf(":");
        const field = separator === -1 ? line : line.slice(0, separator);
        const valuePart = separator === -1 ? "" : line.slice(separator + 1).trimStart();

        if (field === "event") {
          eventType = valuePart || "message";
        } else if (field === "data") {
          dataLines.push(valuePart);
        }
      }
    }

    // A cancelled stream's partial tail is not an event.
    if (signal.aborted) return;

    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      dataLines.push(buffer.trim());
    }

    const trailingEvent = flushEvent();
    if (trailingEvent) {
      yield trailingEvent;
    }
  }

  private async *parseJsonLines(
    stream: ReadableStream<Uint8Array>,
    signal: AbortSignal
  ): AsyncIterable<RemoteNodeEvent> {
    const decoder = new TextDecoder();
    let buffer = "";

    for await (const value of readChunks(stream, signal)) {
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        yield this.normalizeEvent(trimmed, "message");
      }
    }

    if (signal.aborted) return;

    const trailing = (buffer + decoder.decode()).trim();
    if (trailing.length > 0) {
      yield this.normalizeEvent(trailing, "message");
    }
  }

  private normalizeEvent(raw: unknown, fallbackType: string): RemoteNodeEvent {
    const parsed = this.tryParseJson(raw);

    if (
      parsed &&
      typeof parsed === "object" &&
      "type" in parsed &&
      "timestamp" in parsed
    ) {
      return {
        type: String((parsed as { type: unknown }).type),
        payload: (parsed as { payload?: unknown }).payload,
        timestamp: String((parsed as { timestamp: unknown }).timestamp),
      };
    }

    return {
      type: fallbackType,
      payload: parsed,
      timestamp: new Date().toISOString(),
    };
  }

  private tryParseJson(value: unknown): unknown {
    if (typeof value !== "string") {
      return value;
    }

    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  /** Retry transient failures with backoff; a caller abort ends the retries, including one waiting out a backoff. */
  private async withRetry<T>(
    fn: () => Promise<T>,
    maxRetries = DEFAULT_MAX_RETRIES,
    signal?: AbortSignal
  ): Promise<T> {
    let attempt = 0;

    while (true) {
      try {
        return await fn();
      } catch (error) {
        const isRetryable =
          error instanceof RemoteNodeRequestError
            ? error.retryable
            : this.isLikelyNetworkError(error);

        if (!isRetryable || attempt >= maxRetries || signal?.aborted) {
          throw error;
        }

        const delayMs = RETRY_BASE_DELAY_MS * 2 ** attempt;
        attempt += 1;
        remoteNodeLog.warn(
          `Request failed, retrying in ${delayMs}ms (attempt ${attempt}/${maxRetries})`,
          error
        );
        await this.sleep(delayMs, signal);
        if (signal?.aborted) {
          throw new RemoteNodeRequestError("Remote node request aborted during retry backoff", false);
        }
      }
    }
  }

  private isLikelyNetworkError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    if (error.name === "AbortError") {
      return true;
    }

    return error instanceof TypeError;
  }

  private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}
