import { afterEach, describe, expect, it } from "vitest";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { DESKTOP_LOOPBACK_HOST, closeServerDraining, listenOnLoopback, trackServerSockets } from "../server-lifecycle.ts";

/*
 * Real sockets on purpose: Node's server.close() waits for every connection, and an upgraded
 * WebSocket socket is not released by closeAllConnections(). A fake server cannot reproduce either.
 */
const openServers: Server[] = [];

afterEach(() => {
  for (const server of openServers.splice(0)) {
    server.closeAllConnections?.();
    server.close();
  }
});

async function startServer(handler?: http.RequestListener): Promise<{ server: Server; port: number }> {
  const server = http.createServer(handler);
  openServers.push(server);
  trackServerSockets(server);
  listenOnLoopback(server);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return { server, port: (server.address() as AddressInfo).port };
}

function openSseStream(port: number): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: DESKTOP_LOOPBACK_HOST, port, path: "/api/events" }, (res) => {
      res.on("data", () => undefined);
      res.on("error", () => undefined);
      resolve(res);
    });
    req.on("error", reject);
  });
}

function openUpgradedSocket(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: DESKTOP_LOOPBACK_HOST,
      port,
      path: "/api/ws",
      headers: { Connection: "Upgrade", Upgrade: "websocket" },
    });
    req.on("upgrade", (_res, socket) => {
      socket.on("error", () => undefined);
      resolve();
    });
    req.on("error", reject);
    req.end();
  });
}

async function closesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe("desktop server lifecycle", () => {
  it("binds the embedded dashboard to loopback only", async () => {
    const { server } = await startServer();
    expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
  });

  it("closes in bounded time while an SSE response is held open", async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: hello\n\n");
    });
    await openSseStream(port);

    expect(await closesWithin(closeServerDraining(server, { graceMs: 20 }), 2_000)).toBe(true);
  });

  it("closes in bounded time while an upgraded WebSocket socket is open", async () => {
    const { server, port } = await startServer();
    server.on("upgrade", (_req, socket) => {
      socket.on("error", () => undefined);
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    });
    await openUpgradedSocket(port);

    expect(await closesWithin(closeServerDraining(server, { graceMs: 20 }), 2_000)).toBe(true);
  });

  it("closes immediately when only idle keep-alive connections remain", async () => {
    const agent = new http.Agent({ keepAlive: true });
    const { server, port } = await startServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve, reject) => {
      http
        .get({ host: DESKTOP_LOOPBACK_HOST, port, agent }, (res) => {
          res.resume();
          res.on("end", () => resolve());
        })
        .on("error", reject);
    });

    // Grace far beyond the bound proves idle sockets are released without waiting for it.
    expect(await closesWithin(closeServerDraining(server, { graceMs: 60_000 }), 2_000)).toBe(true);
    agent.destroy();
  });

  it("resolves when the server never started listening", async () => {
    const server = http.createServer();
    trackServerSockets(server);
    expect(await closesWithin(closeServerDraining(server, { graceMs: 20 }), 2_000)).toBe(true);
  });
});
