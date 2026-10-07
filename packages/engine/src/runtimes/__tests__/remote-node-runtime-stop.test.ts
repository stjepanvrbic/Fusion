import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodeConfig } from "@fusion/core";
import { RemoteNodeRuntime } from "../remote-node-runtime.js";

const NOW = "2026-04-08T00:00:00.000Z";

const node: NodeConfig = {
  id: "node_remote_stop",
  name: "Remote Node",
  type: "remote",
  url: "https://remote.example.com",
  apiKey: "token-123",
  status: "online",
  maxConcurrent: 4,
  createdAt: NOW,
  updatedAt: NOW,
};

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

/** Settles with "timeout" when `promise` has not settled within `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([promise, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms))]);
}

/*
FNXC:RemoteNodeRuntime 2026-10-07-19:50:
stop() must settle when the remote node returned event-stream headers and then went silent; the real client is used so the pending body read is the one the runtime waits on.
*/
describe("RemoteNodeRuntime stop with a silent event stream", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("settles stop() while the stream body is stalled after its headers", async () => {
    const streamCancelled = vi.fn();
    let streamOpened!: () => void;
    const opened = new Promise<void>((resolve) => {
      streamOpened = resolve;
    });
    // The fake ignores fetch's signal: only the runtime's own cancellation can end the body.
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/health")) return json({ status: "ok", version: "1", uptime: 1 });
      if (url.endsWith("/api/metrics")) return json({ inFlightTasks: 0, activeAgents: 0, lastActivityAt: NOW });
      if (url.endsWith("/api/events/stream")) {
        streamOpened();
        return new Response(new ReadableStream<Uint8Array>({ cancel: streamCancelled }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;

    const runtime = new RemoteNodeRuntime({ nodeConfig: node, projectId: "proj_stop", projectName: "Stop" });
    await runtime.start();
    await opened;

    await expect(within(runtime.stop(), 1_000)).resolves.toBeUndefined();
    expect(runtime.getStatus()).toBe("stopped");
    expect(streamCancelled).toHaveBeenCalled();
  });
});
