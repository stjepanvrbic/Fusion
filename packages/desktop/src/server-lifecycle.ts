import type { Server } from "node:http";
import type { Socket } from "node:net";

/*
FNXC:DesktopServerExposure 2026-10-07-18:02:
Desktop local mode serves the dashboard API without a daemon token, so it must never listen beyond loopback.
Both embedded server paths bind 127.0.0.1 explicitly; remote exposure needs an explicitly configured, authenticated `fn serve`.
*/
export const DESKTOP_LOOPBACK_HOST = "127.0.0.1";

/** Time in-flight requests get to finish before held connections are destroyed on stop. */
export const DESKTOP_SERVER_DRAIN_GRACE_MS = 1_000;

const trackedSockets = new WeakMap<Server, Set<Socket>>();

/** Listen on an OS-assigned loopback port; accepts an http.Server or the dashboard's express app. */
export function listenOnLoopback<T>(target: { listen(port: number, host: string): T }): T {
  return target.listen(0, DESKTOP_LOOPBACK_HOST);
}

/**
 * Record every socket the server accepts, upgraded ones included.
 * Must be attached before the server starts listening.
 */
export function trackServerSockets(server: Server): void {
  if (trackedSockets.has(server)) return;
  const sockets = new Set<Socket>();
  trackedSockets.set(server, sockets);
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
}

/*
FNXC:DesktopShutdown 2026-10-07-18:02:
`server.close()` waits for every open connection, and the dashboard holds `/api/events` SSE streams and WebSocket upgrades for as long as the window is connected.
Stopping the desktop runtime must always reach engine stop and backend shutdown in bounded time: close idle sockets at once, give in-flight requests a short grace, then destroy whatever is still held, upgraded sockets included because `closeAllConnections()` does not release them.
*/
export async function closeServerDraining(server: Server, options: { graceMs?: number } = {}): Promise<void> {
  const graceMs = options.graceMs ?? DESKTOP_SERVER_DRAIN_GRACE_MS;
  const closed = new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  server.closeIdleConnections?.();
  const forceTimer = setTimeout(() => {
    server.closeAllConnections?.();
    for (const socket of trackedSockets.get(server) ?? []) socket.destroy();
  }, graceMs);
  try {
    await closed;
  } finally {
    clearTimeout(forceTimer);
  }
}
